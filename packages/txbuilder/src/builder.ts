/**
 * The `TxBuilder` over `UtxoSources`: reads the live cells and the signer's
 * UTXOs, checks every cell it is given, selects funding, and calls the
 * synchronous shapes (shapes/*.ts).
 *
 * Nothing from the wire is trusted: a `CovenantCell`'s template hash is
 * recomputed from its redeem script, its state is decoded from the script
 * and compared with the state the source sent, and the cell's role (supply,
 * reserve, pool reserve, user cell) is checked against the singleton that
 * owns it by the shapes' preconditions. A cell that fails any check is
 * refused.
 *
 * Curve templates are identified among the committed presets of the v1 build
 * (the network's frozen and staged revisions included, `v1RevisionsOn`), the contexts the
 * caller registers, and any creator's instantiation of a committed preset
 * (`instantiate.ts`, the structural creator-slot rule). Pool templates are one
 * per set and are told apart by hash; the token template is fixed.
 */

import { poolLimitsOf, poolRoundingOf } from './cells.ts';
import { templateHashOfProgram, toHex } from '@kasseal/codec';
import { BUILDER_CONTRACT_SETS, DEFAULT_CONTRACT_SET, hasOpenLiquidity, artifactSource, curvePresetDir, launchRevisionOf, presetsOfSet, v1RevisionsOn, type ContractSet } from './artifacts.ts';
import { ResidualBelowMinimum, addressOfSpk, outpointKey, type AnyCell, type CurveCell, type FundingUtxo, type Outpoint, type PoolCell, type TokenCell } from './assemble.ts';
import { contextSet, createContext, type BuilderContext } from './cells.ts';
import { NETWORK_ID } from './sdk.ts';
import { p2shScript } from './blake2b.ts';
import { contextForCurveProgram } from './instantiate.ts';
import { assertTreasuryAllowedOnNetwork, isTreasuryAllowedOnNetwork } from './treasury.ts';
import { estimateBuilt, finalize } from './finalize.ts';
import { SOMPI_PER_KAS, boundedFeerate } from './mass.ts';
import { CellDecoder, POOL_KAS_SCALE, curveStateToJson, poolStateToJson, scriptHashOf, tokenStateToJson, type CurveParams, type DecodedCell } from './program.ts';
import { spendableCells } from './select/cells.ts';
import { isCovenantVaultCell, selectCurveCells, selectPoolReserve } from './select/covenant.ts';
import { selectFunding, type SelectFundingOptions } from './select/funding.ts';
import { buildExactCellChain, buildMergeChain, planExactCell, type ExactCellPlan } from './select/planner.ts';
import { buildDepositChain, buildWithdrawalChain } from './select/liquidity.ts';
import { buildBuy, buyPrecheck } from './shapes/buy.ts';
import { DEFAULT_USER_CELL_VALUE, MIN_PAYOUT, requireLineage, requireProofBound, toBuilt } from './shapes/common.ts';
import { DEFAULT_CURVE_VALUE, DEFAULT_PREP_VALUE, buildCreate } from './shapes/create.ts';
import { LP_INVENTORY_CELL_VALUE, buildBindLp, buildGraduateAndBind } from './shapes/bind-lp.ts';
import { buildGraduate } from './shapes/graduate.ts';

/** What a graduate-and-bind funding leaves beyond the inventory cell for the two fees (each about 0.06 KAS at 100 sompi/g). */
export const GRADUATE_BIND_FEE_MARGIN = 100_000_000n;
import {
  DEFAULT_LP_CELL_VALUE, assertRebuildAllowed, buildAddLiquidity, buildRemoveLiquidity, defaultTokenCellValue, depositQuote, requireBoundPool, withdrawalNeedsTopUp, withdrawalQuote,
} from './shapes/liquidity.ts';
import { buildSell, sellPrecheck } from './shapes/sell.ts';
import { buildSplit, splitValues } from './shapes/split.ts';
import { buildPoolSweep, buildSweep } from './shapes/sweep.ts';
import { UnsafeScript, buildSwapKasForTokens, buildSwapTokensForKas, poolMathState } from './shapes/swap.ts';
import { lpInventory, swapTokensForKas as poolSellQuote } from '@kasseal/curve-math';
import {
  CurveNotOfProof, LpUnsafe, NeedsConsolidation, NeedsSplit, PoolNotOfProof, ShapeNotSupported, TokenAmountMismatch, UnknownCurveTemplate, type BuildAddLiquidityParams, type BuildBuyParams, type BuildConsolidateParams, type BuildCreateParams,
  type BuildRemoveLiquidityParams, type BuildSellParams, type BuildScriptSellParams, type BuildSplitParams, type BuildSwapParams, type BuiltTx, type CovenantCell, type LiquidityPlanBuilt, type RegistrationPayload,
  type TxBuilder, type UtxoSources,
} from './types.ts';

/** Above the largest measured sell fee (0.0322 KAS): a sell whose cell value plus refund is below the payout floor plus this is topped up. */
const SELL_FEE_BOUND = SOMPI_PER_KAS / 20n;
/** Funding allowance for a creation: two fees (tx01 + tx2, 0.0096 + 0.0239 KAS measured). */
const CREATE_FEE_ALLOWANCE = SOMPI_PER_KAS / 10n;

/** Options of `createTxBuilder`. */
export interface TxBuilderOptions {
  /** Where UTXOs and cells are read from. */
  readonly sources: UtxoSources;
  /** `mainnet` or `testnet-10`; pass it explicitly. */
  readonly networkId?: string;
  /**
   * v1 curve presets the builder recognises by template hash (default: every committed
   * `curve.ctor.<preset>.json`).
   */
  readonly presets?: readonly string[];
  /** Further contexts (a factory-compiled curve) recognised before the presets. */
  readonly contexts?: readonly BuilderContext[];
  /** Sompi added on top of the model's minimum fee, every transaction. */
  readonly feeMargin?: bigint;
  /** Funding selection options (input limits). */
  readonly fundingOptions?: SelectFundingOptions;
}

/**
 * `TxBuilder` plus the exact-cell planner and the v1 pool's liquidity entries (bind, add, remove, and the deposit /
 * withdrawal plans).
 */
export interface KassealTxBuilder extends TxBuilder {
  /**
   * `bindLp` of an unbound v1 pool: the funder's KAS authorizes the L genesis group and funds the 10 KAS inventory
   * cell. Refused for swap-only pools and for a pool already bound.
   */
  buildBindLp(p: { poolId: string; funder: string }): Promise<BuiltTx>;
  /**
   * `addLiquidity(shares)` on a bound v1 pool from a T cell of exactly `dTok`; throws `NeedsSplit` | `NeedsConsolidation`
   * when the depositor has no such cell (`planDeposit` builds the chain instead). Refused without `lpSafe`, while unbound,
   * below the minimum deposit, or when the live reserve ratio drifted 1 % or more from `quoted`.
   */
  buildAddLiquidity(p: BuildAddLiquidityParams): Promise<BuiltTx>;
  /**
   * `removeLiquidity(shares)` on a bound v1 pool from an L cell of exactly `shares`; throws `NeedsSplit` |
   * `NeedsConsolidation` otherwise. Refused while unbound, below `PAYOUT_MIN`, or when `minKasOut` / `minTokOut` are not met.
   */
  buildRemoveLiquidity(p: BuildRemoveLiquidityParams): Promise<BuiltTx>;
  /** The splits or merges that leave one T cell of exactly `dTok`, then the deposit, with the total fee. */
  planDeposit(p: BuildAddLiquidityParams): Promise<LiquidityPlanBuilt>;
  /** The splits or merges that leave one L cell of exactly `shares`, then the withdrawal, with the total fee. */
  planWithdrawal(p: BuildRemoveLiquidityParams): Promise<LiquidityPlanBuilt>;
  /**
   * The chain that leaves exactly one cell of `amount` tokens (use, split, merge, merge then split), with the total
   * fee, before any signature. Empty when the cell already exists.
   */
  /** `mustSpend`: cells the plan's first step must spend (a changed retry conflicts with the earlier attempt). */
  buildExactCell(p: { covenantId: string; owner: string; ownerXOnlyPubkey: Uint8Array; amount: bigint; mustSpend?: readonly Outpoint[] }): Promise<{ transactions: BuiltTx[]; totalFeeSompi: bigint; cell: Outpoint; plan: ExactCellPlan }>;
  /**
   * The committed constants of the served curve's program: what a trade is sized and priced
   * with, never the API's `params`. The head is verified as for a trade (template, state, lineage).
   */
  curveParams(p: { covenantId: string; tokenId?: string }): Promise<CurveParams>;
}

/**
 * Committed curve presets of a set (the `curve.ctor.<preset>.json` constructor files of the bundled artifacts; a frozen
 * revision's under its own directory). Empty for a frozen revision whose artifacts are not bundled.
 */
export function committedPresets(version: ContractSet = DEFAULT_CONTRACT_SET, revision?: string): string[] {
  try {
    return presetsOfSet(version, artifactSource().list(curvePresetDir(version, revision)));
  } catch (e) {
    if (revision !== undefined) return []; // a build without the revision's artifacts recognises none of its templates
    throw e;
  }
}

/**
 * Create a transaction builder over `options.sources`. It builds unsigned transactions only; signing and submission
 * are the caller's (see `finalize` and `submit`). Every served cell is re-verified; a cell that fails a check is refused.
 */
export function createTxBuilder(options: TxBuilderOptions): KassealTxBuilder {
  const { sources } = options;
  const networkId = options.networkId;
  const contexts = new Map<string, BuilderContext>();
  // Mainnet (`treasury.ts`): a caller's context must carry a mainnet treasury; committed presets that do not are
  // left out below, so a testnet build is never launched, traded or graduated on mainnet.
  for (const c of options.contexts ?? []) {
    assertTreasuryAllowedOnNetwork(c);
    contexts.set(c.curve.templateHash, c);
  }
  let presetsLoaded = false;
  const presetNames = options.presets;

  const contextOf = (name: string, version: ContractSet, revision?: string): BuilderContext => {
    const c = createContext(name, networkId, version, revision);
    assertTreasuryAllowedOnNetwork(c);
    return c;
  };
  /** A committed preset's context, or undefined when its treasury is not allowed on this network (mainnet). */
  const baseOf = (name: string, version: ContractSet, revision?: string): BuilderContext | undefined => {
    const c = createContext(name, networkId, version, revision);
    return isTreasuryAllowedOnNetwork(c) ? c : undefined;
  };
  /**
   * The revision a new launch and a token-only operation use unless a launch names one (`BuildCreateParams.revision`):
   * the mainnet build on mainnet, its testnet-10 build on testnet-10 (`launchRevisionOf`). Every other revision's contexts
   * are recognised and traded on, never chosen for those.
   */
  const defaultRevision = launchRevisionOf(networkId ?? NETWORK_ID);
  const isOfRevision = (c: BuilderContext, revision: string | undefined): boolean => c.pool.revision === revision;
  /** Committed presets of every set: the bases a creator's curve is instantiated from. */
  const bases: BuilderContext[] = [];
  const loadPresets = (): void => {
    if (presetsLoaded) return;
    for (const version of BUILDER_CONTRACT_SETS) {
      const names = version === DEFAULT_CONTRACT_SET && presetNames !== undefined ? presetNames : committedPresets(version);
      for (const name of names) {
        const c = baseOf(name, version);
        if (c === undefined) continue;
        bases.push(c);
        if (!contexts.has(c.curve.templateHash)) contexts.set(c.curve.templateHash, c);
      }
    }
    // The network's frozen and staged v1 revisions: the lineages launched on another v1 build keep trading,
    // adding and withdrawing liquidity and graduating, each into its own pool. Registered after every current preset.
    for (const revision of v1RevisionsOn(networkId ?? NETWORK_ID)) {
      for (const name of committedPresets('v1', revision)) {
        const c = baseOf(name, 'v1', revision);
        if (c === undefined) continue;
        bases.push(c);
        if (!contexts.has(c.curve.templateHash)) contexts.set(c.curve.templateHash, c);
      }
    }
    presetsLoaded = true;
  };
  /**
   * The context a new launch uses: the first registered context of that preset and set (the caller's own
   * instantiation, `options.contexts`, is registered first), else the committed preset. Instantiations recognised
   * while trading are registered after the committed presets, so they never win over their preset.
   */
  const contextFor = (preset: string, version: ContractSet = DEFAULT_CONTRACT_SET, revision: string | undefined = defaultRevision): BuilderContext => {
    loadPresets();
    if (revision !== undefined && revision !== defaultRevision && !v1RevisionsOn(networkId ?? NETWORK_ID).includes(revision)) {
      throw new Error(`revision ${revision} is not a ${networkId ?? NETWORK_ID} build`);
    }
    for (const c of contexts.values()) if (c.curve.preset === preset && contextSet(c) === version && isOfRevision(c, revision)) return c;
    const c = contextOf(preset, version, revision);
    contexts.set(c.curve.templateHash, c);
    return c;
  };
  /** Any context of a set (token-only operations use the shared token template; pools use the set's pool template). */
  const anyContextOrUndefined = (version: ContractSet): BuilderContext | undefined => {
    loadPresets();
    for (const c of contexts.values()) if (contextSet(c) === version && isOfRevision(c, defaultRevision)) return c;
    return undefined;
  };
  const anyContext = (version: ContractSet = DEFAULT_CONTRACT_SET): BuilderContext => {
    const c = anyContextOrUndefined(version);
    if (c === undefined) throw new Error(`no ${version} curve context available`);
    return c;
  };
  const decoders = new Map<BuilderContext, CellDecoder>();
  const decoderOf = (ctx: BuilderContext): CellDecoder => {
    let d = decoders.get(ctx);
    if (!d) {
      d = new CellDecoder(ctx.curve, ctx.pool, ctx.token);
      decoders.set(ctx, d);
    }
    return d;
  };
  /** The context whose curve template the program instantiates: a known template, else a creator's instantiation of a committed preset. */
  const contextOfCurveProgram = (program: Uint8Array): BuilderContext => {
    loadPresets();
    for (const c of contexts.values()) {
      try {
        if (decoderOf(c).decode(program).kind === 'curve') return c;
      } catch {
        // not this preset's template
      }
    }
    const inst = contextForCurveProgram(program, bases);
    if (inst !== null) {
      contexts.set(inst.curve.templateHash, inst);
      return inst;
    }
    throw new UnknownCurveTemplate();
  };
  /** The context of the set whose pool template the program instantiates (the pool templates differ in hash and state length). */
  const contextOfPoolProgram = (program: Uint8Array): BuilderContext => {
    for (const version of BUILDER_CONTRACT_SETS) {
      const ctx = anyContextOrUndefined(version);
      if (ctx === undefined) continue;
      const { stateOffset, stateLength, templateHash } = ctx.pool;
      if (program.length >= stateOffset + stateLength && templateHashOfProgram(program, stateOffset, stateLength) === templateHash) return ctx;
    }
    // Another revision's pool (one context per revision serves: pool operations read only its pool and token).
    for (const ctx of contexts.values()) {
      if (isOfRevision(ctx, defaultRevision)) continue;
      const { stateOffset, stateLength, templateHash } = ctx.pool;
      if (program.length >= stateOffset + stateLength && templateHashOfProgram(program, stateOffset, stateLength) === templateHash) return ctx;
    }
    throw new Error('pool program matches no known pool template');
  };

  /**
   * The feerate `GET /fees` answers, floored at the node's minimum and refused (`FeerateOutOfRange`) above
   * `FEERATE_MAX_SOMPI_PER_GRAM`: the API never chooses a higher rate than the cap, however it answers.
   */
  const feeOptions = async (): Promise<{ feeMargin?: bigint; feerate: bigint }> => {
    const feerate = boundedFeerate(await sources.feerate(), 'GET /fees');
    return options.feeMargin === undefined ? { feerate } : { feerate, feeMargin: options.feeMargin };
  };
  const fundingOpts = (extra: SelectFundingOptions = {}): SelectFundingOptions => ({ ...options.fundingOptions, ...extra });

  /** A source cell, re-derived from its redeem script: template hash, kind and state must match what the source sent. */
  function verifiedCell(ctx: BuilderContext, cell: CovenantCell<unknown>): AnyCell {
    const where = `cell ${cell.outpoint.txid}:${cell.outpoint.index}`;
    if (!/^[0-9a-f]{64}$/.test(cell.covenantId)) throw new Error(`${where}: malformed covenant id`);
    if (cell.amount <= 0n) throw new Error(`${where}: non-positive value`);
    const d: DecodedCell = decoderOf(ctx).decode(cell.redeemScript);
    if (d.templateHash !== cell.templateHash) throw new Error(`${where}: source template hash ${cell.templateHash} != recomputed ${d.templateHash}`);
    const base = { outpoint: { txid: cell.outpoint.txid, index: cell.outpoint.index }, value: cell.amount, covenantId: cell.covenantId, program: cell.redeemScript, daaScore: 0n };
    const differs = (sent: Record<string, string | number>, own: Record<string, string | number>): void => {
      if (JSON.stringify(sent) !== JSON.stringify(own)) throw new Error(`${where}: source state differs from the state decoded from its program`);
    };
    switch (d.kind) {
      case 'token':
        differs(tokenStateToJson(cell.state as TokenCell['state']), tokenStateToJson(d.state));
        return { kind: 'token', ...base, state: d.state };
      case 'curve':
        differs(curveStateToJson(cell.state as CurveCell['state']), curveStateToJson(d.state));
        return { kind: 'curve', ...base, state: d.state };
      case 'pool':
        differs(poolStateToJson(cell.state as PoolCell['state']), poolStateToJson(d.state));
        return { kind: 'pool', ...base, state: d.state };
    }
  }
  const tokenCellOf = (ctx: BuilderContext, cell: CovenantCell<unknown>): TokenCell => {
    const c = verifiedCell(ctx, cell);
    if (c.kind !== 'token') throw new Error(`cell ${cell.outpoint.txid}:${cell.outpoint.index}: program is a ${c.kind} cell, expected a token cell`);
    return c;
  };
  const curveCellOf = (ctx: BuilderContext, cell: CovenantCell<unknown>): CurveCell => {
    const c = verifiedCell(ctx, cell);
    if (c.kind !== 'curve') throw new Error(`cell ${cell.outpoint.txid}:${cell.outpoint.index}: program is a ${c.kind} cell, expected a curve cell`);
    return c;
  };
  const poolCellOf = (ctx: BuilderContext, cell: CovenantCell<unknown>): PoolCell => {
    const c = verifiedCell(ctx, cell);
    if (c.kind !== 'pool') throw new Error(`cell ${cell.outpoint.txid}:${cell.outpoint.index}: program is a ${c.kind} cell, expected a pool cell`);
    return c;
  };

  /** The curve the caller trades must be the C its verified launch proof names, when it names one. */
  const requireCurveOfProof = (covenantId: string, expectedCurveId: string | undefined): void => {
    if (expectedCurveId !== undefined && expectedCurveId.toLowerCase() !== covenantId.toLowerCase()) throw new CurveNotOfProof(covenantId, expectedCurveId);
  };
  /** The served curve head, verified; when the caller names the token it trades, the head's lineage must be that token. */
  const curveOf = async (covenantId: string, tokenId?: string): Promise<{ ctx: BuilderContext; curve: CurveCell }> => {
    const head = await sources.curveHead(covenantId);
    if (head.covenantId !== covenantId) throw new Error(`curve head of ${head.covenantId}, asked for ${covenantId}`);
    const ctx = contextOfCurveProgram(head.redeemScript);
    const curve = curveCellOf(ctx, head);
    requireLineage(`curve ${covenantId}`, curve.state.tokenCovId, tokenId);
    return { ctx, curve };
  };
  /**
   * The curve's supply and reserve cells, selected by state: every C-owned cell of T the
   * sources list (`tokenCells(T, C)`) plus the pair `covenantCells` serves, each verified, then filtered by owner,
   * scheme, borrow fields and the amounts the curve pins. A decoy, a donation or a source that serves the cells by
   * position cannot block or misdirect the build; at the crossover (equal amounts) two distinct cells are taken.
   */
  async function curveCellsOf(ctx: BuilderContext, curve: CurveCell, needReserve: true): Promise<{ supply: TokenCell; reserve: TokenCell }>;
  async function curveCellsOf(ctx: BuilderContext, curve: CurveCell, needReserve?: false): Promise<{ supply: TokenCell; reserve: TokenCell | undefined }>;
  async function curveCellsOf(ctx: BuilderContext, curve: CurveCell, needReserve = false): Promise<{ supply: TokenCell; reserve: TokenCell | undefined }> {
    const T = toHex(curve.state.tokenCovId);
    const C = curve.covenantId;
    const [listed, served] = await Promise.all([
      sources.tokenCells(T, C).catch((): CovenantCell[] => []),
      sources.covenantCells(C).then((c) => [c.supply, c.reserve], (): CovenantCell[] => []),
    ]);
    const candidates: TokenCell[] = [];
    for (const c of [...served, ...listed]) {
      try {
        candidates.push(tokenCellOf(ctx, c));
      } catch {
        // not a token cell of a known template: never a candidate
      }
    }
    const p = ctx.curve.params;
    const amounts = { supply: (p.curveLots - curve.state.lotsSold) * p.lot, reserve: p.gradReserve };
    return selectCurveCells(candidates, T, C, amounts, needReserve);
  }
  const userCellsOf = async (ctx: BuilderContext, T: string, owner: Uint8Array): Promise<TokenCell[]> => {
    if (owner.length !== 32) throw new Error('owner must be a 32-byte x-only public key');
    const key = toHex(owner);
    const cells = (await sources.tokenCells(T, key)).map((c) => tokenCellOf(ctx, c));
    for (const c of cells) {
      if (c.covenantId !== T) throw new Error(`token cell ${c.outpoint.txid}:${c.outpoint.index} is not of lineage ${T}`);
      if (toHex(c.state.owner.identifier) !== key) throw new Error(`token cell ${c.outpoint.txid}:${c.outpoint.index} is not owned by ${key}`);
    }
    return spendableCells(cells, T);
  };
  /** The served pool cell, verified; when the caller names the token it trades, the pool's lineage must be that token. */
  const poolOf = async (poolId: string, tokenId?: string, expectedPoolId?: string): Promise<{ ctx: BuilderContext; pool: PoolCell; poolToken: TokenCell; T: string }> => {
    // Compared as hex, case-insensitively, like the curve's.
    if (expectedPoolId !== undefined && expectedPoolId.toLowerCase() !== poolId.toLowerCase()) throw new PoolNotOfProof(poolId, expectedPoolId);
    const src = await sources.poolCell(poolId);
    if (src.covenantId !== poolId) throw new Error(`pool cell of ${src.covenantId}, asked for ${poolId}`);
    const ctx = contextOfPoolProgram(src.redeemScript);
    const pool = poolCellOf(ctx, src);
    poolMathState(pool); // dust rule
    const T = requireLineage(`pool ${poolId}`, pool.state.tokenCovId, tokenId);
    // By state: the P-owned cell of T with the pinned fields and exactly `tokenReserve`; any other P-owned cell is a donation.
    const poolToken = selectPoolReserve((await sources.tokenCells(T, poolId)).map((c) => tokenCellOf(ctx, c)), T, poolId, pool.state.tokenReserve);
    return { ctx, pool, poolToken, T };
  };
  /** A bound v1 pool with its reserve and its L inventory cell (owned by P, holding exactly `LP_SUPPLY - issued`). */
  const boundPoolOf = async (
    poolId: string, quoted: BuildAddLiquidityParams['quoted'], tokenId?: string, expectedPoolId?: string,
  ): Promise<{ ctx: BuilderContext; pool: PoolCell; reserve: TokenCell; inventory: TokenCell; T: string; L: string }> => {
    const { ctx, pool, poolToken, T } = await poolOf(poolId, tokenId, expectedPoolId);
    const L = requireBoundPool(pool);
    if (quoted !== undefined) assertRebuildAllowed(quoted, pool.state);
    const expected = lpInventory({ ...poolMathState(pool), lpShares: pool.state.lpShares }, poolLimitsOf(ctx));
    // The cell the covenant pins (owner P, scheme 0x04, borrow disabled, guard 0^32, exactly `expected`); any other
    // pool-owned L cell is a stray (a transferred share) and is never chosen. Should a second cell
    // meet every pin, the covenant accepts either, so the first is taken.
    const inventory = (await sources.tokenCells(L, poolId)).map((c) => tokenCellOf(ctx, c))
      .find((c) => isCovenantVaultCell(c, L, poolId) && c.state.amount === expected);
    if (inventory === undefined) throw new Error(`no pool-owned L inventory cell holds ${expected} (borrowing disabled, guard 0)`);
    return { ctx, pool, reserve: poolToken, inventory, T, L };
  };
  const fundingFor = async (address: string, needed: bigint, extra: SelectFundingOptions = {}): Promise<FundingUtxo[]> => selectFunding(await sources.funding(address), needed, fundingOpts(extra));

  /** NeedsSplit / NeedsConsolidation for a holder without a cell of exactly `amount`. */
  const needsOf = (cells: readonly TokenCell[], amount: bigint): Error => {
    const plan = planExactCell(cells.map((c) => ({ id: outpointKey(c.outpoint), amount: c.state.amount })), amount);
    const byId = new Map<string, TokenCell>(cells.map((c) => [outpointKey(c.outpoint), c]));
    const first = plan.steps[0];
    if (plan.steps.length === 1 && first?.kind === 'split') return new NeedsSplit(byId.get(first.input)!.outpoint, first.carve);
    const merged = plan.steps.flatMap((s) => (s.kind === 'merge' ? s.inputs : [])).flatMap((id) => (byId.has(id) ? [byId.get(id)!.outpoint] : []));
    return new NeedsConsolidation(merged, plan.steps.length);
  };

  const builder: KassealTxBuilder = {
    async buildCreate(p: BuildCreateParams): Promise<{ prepAndCurveGenesis: BuiltTx; tokenGenesisInit: BuiltTx; registration: RegistrationPayload }> {
      const ctx = contextFor(p.preset, p.contractSet ?? DEFAULT_CONTRACT_SET, p.revision ?? defaultRevision);
      const fee = await feeOptions();
      const prepValue = p.prepValue ?? DEFAULT_PREP_VALUE;
      const curveValue = p.curveValue ?? DEFAULT_CURVE_VALUE;
      // tx01 also funds tx2 through its change: both token cells and both fees.
      const funding = await fundingFor(p.creator, prepValue + curveValue + 2n * ctx.curve.params.tokenCellKas, { feeAllowance: CREATE_FEE_ALLOWANCE });
      const r = buildCreate({
        ctx, creatorAddress: p.creator, metadata: p.metadata, funding, prepValue, curveValue, ...fee,
        ...(p.factoryGate === undefined ? {} : { factoryGate: p.factoryGate }),
        ...(p.kasPrice === undefined ? {} : { kasPrice: p.kasPrice }),

      });
      return { prepAndCurveGenesis: toBuilt(r.prepAndCurveGenesis), tokenGenesisInit: toBuilt(r.tokenGenesisInit), registration: r.registration };
    },

    async buildBuy(p: BuildBuyParams): Promise<BuiltTx> {
      // The launch-proof gate first, before any source is read.
      requireProofBound(`buy(${p.lots})`, p.proofVerdict);
      requireCurveOfProof(p.covenantId, p.expectedCurveId);
      if (p.borrowInto !== undefined) {
        throw new ShapeNotSupported('borrowed receive into an existing cell: the deployed curve buy requires OpCovInputCount(T) == 1 and a user output of exactly n * lot');
      }
      const { ctx, curve } = await curveOf(p.covenantId, p.tokenId);
      const { supply } = await curveCellsOf(ctx, curve);
      const quote = buyPrecheck(ctx, curve, p.lots, p.maxKasIn);
      const V = p.userCellValue ?? DEFAULT_USER_CELL_VALUE;
      const fee = await feeOptions();
      const funding = await fundingFor(p.buyer, quote.total + V);
      return toBuilt(buildBuy({
        ctx, curve, supply, buyer: { xOnlyPubkey: p.buyerXOnlyPubkey, address: p.buyer }, n: p.lots, proofVerdict: p.proofVerdict, funding, userCellValue: V, ...fee,
        ...(p.maxKasIn === undefined ? {} : { maxKasIn: p.maxKasIn }), ...(p.tokenId === undefined ? {} : { tokenId: p.tokenId }), ...(p.maxAllIn === undefined ? {} : { maxAllIn: p.maxAllIn }),
      }));
    },

    async buildSell(p: BuildSellParams): Promise<BuiltTx> {
      const exit = p.allowUnboundExit === true;
      requireProofBound(`sell(${p.lots})`, p.proofVerdict, exit);
      requireCurveOfProof(p.covenantId, p.expectedCurveId);
      const { ctx, curve } = await curveOf(p.covenantId, p.tokenId);
      const amount = p.lots * ctx.curve.params.lot;
      // The size comes from the program's own lot, and must be what the user approved.
      if (p.expectedTokens !== undefined && amount !== p.expectedTokens) throw new TokenAmountMismatch(`sell(${p.lots})`, p.expectedTokens, amount);
      const { supply } = await curveCellsOf(ctx, curve);
      const quote = sellPrecheck(ctx, curve, p.lots, p.minKasOut);
      const T = toHex(curve.state.tokenCovId);
      const cells = await userCellsOf(ctx, T, p.sellerXOnlyPubkey);
      const cell = cells.find((c) => c.state.amount === amount);
      if (!cell) throw needsOf(cells, amount);
      const fee = await feeOptions();
      const topUp = cell.value + quote.total < MIN_PAYOUT + SELL_FEE_BOUND;
      const funding = topUp ? await fundingFor(p.seller, 0n) : [];
      return toBuilt(buildSell({
        ctx, curve, supply, userCell: cell, seller: { address: p.seller }, n: p.lots, proofVerdict: p.proofVerdict, allowUnboundExit: exit, funding, ...fee, ...(p.expectedTokens === undefined ? {} : { expectedTokens: p.expectedTokens }),
        ...(p.minKasOut === undefined ? {} : { minKasOut: p.minKasOut }), ...(p.tokenId === undefined ? {} : { tokenId: p.tokenId }), ...(p.minNetOut === undefined ? {} : { minNetOut: p.minNetOut }),
      }));
    },

    async buildSwap(p: BuildSwapParams): Promise<BuiltTx> {
      // A pool buy needs the caller's launch-proof verdict `bound`, as a curve buy does; a pool sell is never gated.
      if (p.side === 'kas->tok') requireProofBound(`swapKasForTokens(${p.amountIn})`, p.proofVerdict);
      const { ctx, pool, poolToken, T } = await poolOf(p.poolId, p.tokenId, p.expectedPoolId);
      const fee = await feeOptions();
      const lineage = p.tokenId === undefined ? {} : { tokenId: p.tokenId };
      if (p.side === 'kas->tok') {
        const V = DEFAULT_USER_CELL_VALUE;
        const funding = await fundingFor(p.trader, p.amountIn * POOL_KAS_SCALE + V + (p.deliverToScript?.scriptFunding ?? 0n));
        return toBuilt(buildSwapKasForTokens({
          ctx, pool, poolToken, buyer: { xOnlyPubkey: p.traderXOnlyPubkey, address: p.trader }, kasInScaled: p.amountIn, funding, userCellValue: V, ...fee, ...lineage,
          ...(p.deliverToScript === undefined ? {} : { deliverToScript: p.deliverToScript }),
          ...(p.minOut === undefined ? {} : { minTokensOut: p.minOut }), ...(p.maxAllIn === undefined ? {} : { maxAllIn: p.maxAllIn }),
        }));
      }
      const cells = await userCellsOf(ctx, T, p.traderXOnlyPubkey);
      const extra = p.extraCell === undefined ? undefined : cells.find((c) => c.outpoint.txid === p.extraCell!.txid && c.outpoint.index === p.extraCell!.index);
      if (p.extraCell !== undefined && extra === undefined) throw new Error(`cell ${p.extraCell.txid}:${p.extraCell.index} is not a spendable cell of the trader`);
      const cell = cells.find((c) => c.state.amount === p.amountIn && c !== extra);
      if (!cell) throw needsOf(cells, p.amountIn);
      const sold = p.amountIn + (extra?.state.amount ?? 0n);
      const q = poolSellQuote(poolMathState(pool), sold, poolLimitsOf(ctx), poolRoundingOf(ctx));
      const topUp = cell.value + (extra?.value ?? 0n) + q.kasOutScaled * POOL_KAS_SCALE < MIN_PAYOUT + SELL_FEE_BOUND;
      const funding = topUp ? await fundingFor(p.trader, 0n) : [];
      return toBuilt(buildSwapTokensForKas({
        ctx, pool, poolToken, userCell: cell, seller: { address: p.trader }, funding, ...fee, ...lineage,
        ...(extra === undefined ? {} : { extraUserCells: [extra] }),
        ...(p.minOut === undefined ? {} : { minOutScaled: p.minOut }), ...(p.minNetOut === undefined ? {} : { minNetOut: p.minNetOut }),
      }));
    },

    /** A sell of the largest cell a script owns, authorized by one of the script's UTXOs (composable pools). */
    async buildScriptSell(p: BuildScriptSellParams): Promise<BuiltTx> {
      const { ctx, pool, poolToken, T } = await poolOf(p.poolId, p.tokenId, p.expectedPoolId);
      const hash = toHex(scriptHashOf(p.redeem));
      const cells = (await sources.tokenCells(T, `script:${hash}`)).map((c) => tokenCellOf(ctx, c))
        .filter((c) => c.covenantId === T && c.state.owner.schemeByte === 0x03 && toHex(c.state.owner.identifier) === hash);
      if (cells.length === 0) throw new Error(`no cell of ${T} owned by script ${hash}`);
      const cell = cells.reduce((a, b) => (b.state.amount > a.state.amount ? b : a));
      // The address the authority UTXO is read from must be the redeem script's own P2SH.
      const own = addressOfSpk(p2shScript(p.redeem), networkId ?? NETWORK_ID);
      if (own !== p.scriptAddress) throw new UnsafeScript(`the script address ${p.scriptAddress} is not P2SH(redeem) (${own})`);
      const authority = (await sources.funding(p.scriptAddress))[0];
      if (authority === undefined) throw new Error(`no UTXO at the script address ${p.scriptAddress}`);
      const fee = await feeOptions();
      return toBuilt(buildSwapTokensForKas({
        ctx, pool, poolToken, userCell: cell, seller: { address: p.payout }, funding: [], ...fee, tokenId: T,
        scriptAuthority: { redeem: p.redeem, utxo: authority, signerXOnly: toHex(p.signerXOnly), ...(p.allowAnyScript === undefined ? {} : { allowAnyScript: p.allowAnyScript }) },
      }));
    },

    async buildConsolidate(p: BuildConsolidateParams): Promise<BuiltTx[]> {
      const ctx = anyContext();
      const cells = await userCellsOf(ctx, p.covenantId, p.ownerXOnlyPubkey);
      const fee = await feeOptions();
      const funding = await sources.funding(p.owner);
      const chain = buildMergeChain({
        ctx, cells, owner: { xOnlyPubkey: p.ownerXOnlyPubkey, address: p.owner }, funding, fundingOptions: fundingOpts(), ...fee,
        ...(p.target === undefined ? {} : { target: p.target }),
      });
      return chain.transactions.map(toBuilt);
    },

    async buildSplit(p: BuildSplitParams): Promise<BuiltTx> {
      const ctx = anyContext();
      const cells = await userCellsOf(ctx, p.covenantId, p.ownerXOnlyPubkey);
      const cell = cells.find((c) => c.outpoint.txid === p.cell.txid && c.outpoint.index === p.cell.index);
      if (!cell) throw new Error(`cell ${p.cell.txid}:${p.cell.index} is not a spendable cell of this owner`);
      const fee = await feeOptions();
      const funding = await fundingFor(p.owner, splitValues(cell.value).topUp);
      return toBuilt(buildSplit({ ctx, cell, carve: p.carve, changeAddress: p.owner, funding, ...fee }));
    },

    async buildGraduate(p: { covenantId: string; funder: string; keepSupplyDeposit?: boolean }): Promise<BuiltTx> {
      const { ctx, curve } = await curveOf(p.covenantId);
      const { supply, reserve } = await curveCellsOf(ctx, curve, true);
      const fee = await feeOptions();
      const funding = await fundingFor(p.funder, 0n);
      const keep = p.keepSupplyDeposit === true;
      return toBuilt(buildGraduate({ ctx, curve, reserve, supplyEmpty: supply, funding, changeAddress: p.funder, keepSupplyDeposit: keep, ...fee }));
    },

    async buildGraduateAndBind(p: { covenantId: string; funder: string; keepSupplyDeposit?: boolean }): Promise<{ graduate: BuiltTx; bind?: BuiltTx }> {
      const { ctx, curve } = await curveOf(p.covenantId);
      const { supply, reserve } = await curveCellsOf(ctx, curve, true);
      const fee = await feeOptions();
      const keep = p.keepSupplyDeposit === true;
      // graduate's change funds the bind: the inventory cell plus a margin for both fees. A kept supply deposit
      // arrives in that change, so the funder brings that much less.
      const bindNeed = hasOpenLiquidity(contextSet(ctx)) ? LP_INVENTORY_CELL_VALUE + GRADUATE_BIND_FEE_MARGIN : 0n;
      const kept = keep ? ctx.curve.params.tokenCellKas : 0n;
      const needed = bindNeed > kept ? bindNeed - kept : 0n;
      const funding = await fundingFor(p.funder, needed);
      const r = buildGraduateAndBind({ ctx, curve, reserve, supplyEmpty: supply, funding, changeAddress: p.funder, keepSupplyDeposit: keep, ...fee });
      return { graduate: toBuilt(r.graduate), ...(r.bind === undefined ? {} : { bind: toBuilt(r.bind) }) };
    },

    async buildBindLp(p: { poolId: string; funder: string }): Promise<BuiltTx> {
      const { ctx, pool } = await poolOf(p.poolId);
      const fee = await feeOptions();
      const funding = await fundingFor(p.funder, LP_INVENTORY_CELL_VALUE);
      return toBuilt(buildBindLp({ ctx, pool, funding, changeAddress: p.funder, ...fee }));
    },

    async buildAddLiquidity(p: BuildAddLiquidityParams): Promise<BuiltTx> {
      if (p.lpSafe !== true) throw new LpUnsafe(p.lpSafeReason);
      const { ctx, pool, reserve, inventory, T } = await boundPoolOf(p.poolId, p.quoted, p.tokenId, p.expectedPoolId);
      const q = depositQuote(pool, p.shares, poolLimitsOf(ctx));
      const cells = await userCellsOf(ctx, T, p.depositorXOnlyPubkey);
      const cell = cells.find((c) => c.state.amount === q.dTok);
      if (!cell) throw needsOf(cells, q.dTok);
      const fee = await feeOptions();
      const V = p.lpCellValue ?? DEFAULT_LP_CELL_VALUE;
      const funding = await fundingFor(p.depositor, q.dKasScaled * POOL_KAS_SCALE + (V > cell.value ? V - cell.value : 0n));
      return toBuilt(buildAddLiquidity({
        ctx, pool, inventory, reserve, userCell: cell, funding, changeAddress: p.depositor, shares: p.shares, lpSafe: true, lpCellValue: V, ...fee,
        ...(p.tokenId === undefined ? {} : { tokenId: p.tokenId }), ...(p.maxAllIn === undefined ? {} : { maxAllIn: p.maxAllIn }),
      }));
    },

    async buildRemoveLiquidity(p: BuildRemoveLiquidityParams): Promise<BuiltTx> {
      const { ctx, pool, reserve, inventory, L } = await boundPoolOf(p.poolId, p.quoted, p.tokenId, p.expectedPoolId);
      const q = withdrawalQuote(pool, p.shares, p.minKasOut, p.minTokOut, poolLimitsOf(ctx));
      const cells = await userCellsOf(ctx, L, p.withdrawerXOnlyPubkey);
      const cell = cells.find((c) => c.state.amount === p.shares);
      if (!cell) throw needsOf(cells, p.shares);
      const fee = await feeOptions();
      const V = p.tokCellValue ?? defaultTokenCellValue(cell.value);
      const base = {
        ctx, pool, inventory, reserve, userLpCell: cell, changeAddress: p.withdrawer, shares: p.shares, tokCellValue: V, ...fee,
        ...(p.minKasOut === undefined ? {} : { minKasOut: p.minKasOut }), ...(p.minTokOut === undefined ? {} : { minTokOut: p.minTokOut }),
        ...(p.tokenId === undefined ? {} : { tokenId: p.tokenId }), ...(p.minNetOut === undefined ? {} : { minNetOut: p.minNetOut }),
      };
      // Unfunded when the payout is comfortably above the floor; a KAS input otherwise (or when the fee still leaves too little).
      if (!withdrawalNeedsTopUp(cell.value, V, q.dKasScaled)) {
        try {
          return toBuilt(buildRemoveLiquidity({ ...base, funding: [] }));
        } catch (e) {
          if (!(e instanceof ResidualBelowMinimum)) throw e;
        }
      }
      return toBuilt(buildRemoveLiquidity({ ...base, funding: await fundingFor(p.withdrawer, 0n) }));
    },

    async planDeposit(p: BuildAddLiquidityParams): Promise<LiquidityPlanBuilt> {
      if (p.lpSafe !== true) throw new LpUnsafe(p.lpSafeReason);
      const { ctx, pool, reserve, inventory, T } = await boundPoolOf(p.poolId, p.quoted, p.tokenId, p.expectedPoolId);
      const cells = await userCellsOf(ctx, T, p.depositorXOnlyPubkey);
      const fee = await feeOptions();
      const funding = await sources.funding(p.depositor);
      const chain = buildDepositChain({
        ctx, pool, inventory, reserve, cells, owner: { xOnlyPubkey: p.depositorXOnlyPubkey, address: p.depositor }, funding, fundingOptions: fundingOpts(), shares: p.shares, lpSafe: true,
        ...(p.lpCellValue === undefined ? {} : { lpCellValue: p.lpCellValue }), ...fee,
        ...(p.tokenId === undefined ? {} : { tokenId: p.tokenId }), ...(p.maxAllIn === undefined ? {} : { maxAllIn: p.maxAllIn }),
      });
      return { transactions: chain.transactions.map(toBuilt), totalFeeSompi: chain.totalFee, shares: p.shares, dKasScaled: chain.final.dKasScaled, dTok: chain.final.dTok, summary: chain.final.summary };
    },

    async planWithdrawal(p: BuildRemoveLiquidityParams): Promise<LiquidityPlanBuilt> {
      const { ctx, pool, reserve, inventory, L } = await boundPoolOf(p.poolId, p.quoted, p.tokenId, p.expectedPoolId);
      const lpCells = await userCellsOf(ctx, L, p.withdrawerXOnlyPubkey);
      const fee = await feeOptions();
      const funding = await sources.funding(p.withdrawer);
      const chain = buildWithdrawalChain({
        ctx, pool, inventory, reserve, lpCells, owner: { xOnlyPubkey: p.withdrawerXOnlyPubkey, address: p.withdrawer }, funding, fundingOptions: fundingOpts(), shares: p.shares, ...fee,
        ...(p.minKasOut === undefined ? {} : { minKasOut: p.minKasOut }), ...(p.minTokOut === undefined ? {} : { minTokOut: p.minTokOut }),
        ...(p.tokCellValue === undefined ? {} : { tokCellValue: p.tokCellValue }),
        ...(p.tokenId === undefined ? {} : { tokenId: p.tokenId }), ...(p.minNetOut === undefined ? {} : { minNetOut: p.minNetOut }),
      });
      return { transactions: chain.transactions.map(toBuilt), totalFeeSompi: chain.totalFee, shares: p.shares, dKasScaled: chain.final.dKasScaled, dTok: chain.final.dTok, summary: chain.final.summary };
    },

    async buildSweep(p: { covenantId: string; venue: 'curve' | 'pool'; funder: string }): Promise<BuiltTx> {
      const fee = await feeOptions();
      if (p.venue === 'curve') {
        const { ctx, curve } = await curveOf(p.covenantId);
        const funding = await fundingFor(p.funder, 0n);
        return toBuilt(buildSweep({ ctx, curve, funding, changeAddress: p.funder, ...fee }));
      }
      const { ctx, pool } = await poolOf(p.covenantId);
      const funding = await fundingFor(p.funder, 0n);
      return toBuilt(buildPoolSweep({ ctx, pool, funding, changeAddress: p.funder, ...fee }));
    },

    async curveParams(p) {
      const { ctx } = await curveOf(p.covenantId, p.tokenId);
      return ctx.curve.params;
    },

    async buildExactCell(p) {
      const ctx = anyContext();
      const cells = await userCellsOf(ctx, p.covenantId, p.ownerXOnlyPubkey);
      const fee = await feeOptions();
      const funding = await sources.funding(p.owner);
      const chain = buildExactCellChain({ ctx, cells, owner: { xOnlyPubkey: p.ownerXOnlyPubkey, address: p.owner }, funding, fundingOptions: fundingOpts(), target: p.amount, ...(p.mustSpend === undefined ? {} : { mustSpend: p.mustSpend }), ...fee });
      return { transactions: chain.transactions.map(toBuilt), totalFeeSompi: chain.totalFee, cell: chain.cell.outpoint, plan: chain.plan as ExactCellPlan };
    },

    finalize,
    estimate: estimateBuilt,
  };
  return builder;
}
