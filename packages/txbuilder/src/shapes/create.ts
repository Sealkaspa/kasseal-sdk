/**
 * Token creation: two transactions, two signatures.
 *
 *   tx01  prep + curve genesis         in0..  creator KAS (P2PK)
 *         payload 0x00 || I-JSON       out0   P2PK(creator) prep outpoint             (KCC-23 section 3.2)
 *                                      out1   CURVE{phase 0} genesis, group (0, [1])  => C
 *                                      out2   change
 *   tx2   token genesis + curve init   in0    tx01:0  (authorizing input of the T group; binds T to the payload)
 *                                      in1    tx01:1  CURVE init(prefix_T, suffix_T)
 *                                      in2..  creator KAS (tx01's change by default)
 *                                      out0   KCC20{CURVE_SUPPLY, owner C, 0x04}  TOKEN_CELL_KAS  group (0, [0, 1]) => T
 *                                      out1   KCC20{GRAD_RESERVE, owner C, 0x04}  TOKEN_CELL_KAS
 *                                      out2   CURVE'{T, 0, 0, 1}  binding (1, C)
 *                                      out3   change
 *
 * Build order for tx2 (as proven on chain): outputs 0/1 are fixed, T is derived
 * client-side from `(tx01:0, [(0, out0), (1, out1)])`, written into out2's
 * state, then the SDK populates the genesis bindings and `finalize()` fixes
 * the txid. The curve's `init` recomputes T from the genesis binding of
 * output 0 and rejects any other amounts, owner or template (sealed supply).
 *
 * The factory gate (`checkFactoryParams`, curve-math) and the curve's own
 * escrow bound are checked before anything is built. The registration
 * payload (`POST /v1/registrations`) is returned with the two transactions.
 */

import { CURVE_TREASURY_SHARE_PCT, checkFactoryParams, validatePreset, type LaunchPreset } from '@kasseal/curve-math';
import { fromHex, reservedNameOf, toHex } from '@kasseal/codec';
import { covenantIdKip20 } from '../blake2b.ts';
import { p2pkScript, type AssembledTx, type FundingUtxo, type TxPlan } from '../assemble.ts';
import { budgetsOf, changeTo, contextSet, curveInput, curveOutput, kasInput, plainOutput, tokenOutput, type BuilderContext, feeModelOf } from '../cells.ts';
import { assertBandForPrice, assertPresetAllowedOnNetwork } from '../instance.ts';
import { assertTreasuryAllowedOnNetwork } from '../treasury.ts';
import { encodeDeclaration, type TokenMetadata } from '../kip24.ts';
import { SOMPI_PER_KAS } from '../mass.ts';
import { PHASE_ACTIVE, PHASE_UNINIT, ZERO32, covenantOwnedToken, curveProgram, tokenStateToJson, type CurveState, type CurveTemplate } from '../program.ts';
import { curveInitSigScript } from '../sigscript.ts';
import type { KasPriceQuote, RegistrationPayload } from '../types.ts';
import { feeFields, finish, type FeeOptions, type Shaped } from './common.ts';

/** The curve-math preset view of a curve template's constants (for quotes, graduation economics and the factory gate). */
export function launchPresetOf(curve: CurveTemplate): LaunchPreset {
  const p = curve.params;
  if (p.gradReserve % p.lot !== 0n) throw new Error(`gradReserve ${p.gradReserve} is not a whole number of lots`);
  return {
    name: curve.preset,
    curve: { p0: p.p0, k: p.k, feeBps: p.feeBps, curveLots: p.curveLots },
    lotSize: p.lot,
    totalSupply: p.curveLots * p.lot + p.gradReserve,
    gradLots: p.gradReserve / p.lot,
    treasurySharePct: CURVE_TREASURY_SHARE_PCT[feeModelOf(curve.version)],
    sweepMinSompi: 10n * SOMPI_PER_KAS,
    tokenCellSompi: p.tokenCellKas,
  };
}


export interface CreateParams extends FeeOptions {
  readonly ctx: BuilderContext;
  readonly creatorAddress: string;
  readonly metadata: TokenMetadata;
  /** Funds tx01 (one or more P2PK UTXOs of the creator). */
  readonly funding: readonly FundingUtxo[];
  /** tx2's extra funding; defaults to tx01's change output. */
  readonly funding2?: readonly FundingUtxo[];
  /** Value of the prep outpoint tx01:0 (default 5 KAS; 1 KAS would cost 10,000 g of storage mass). */
  readonly prepValue?: bigint;
  /** Value of the curve genesis cell (default 5 KAS). The pool escrow at graduation includes it. */
  readonly curveValue?: bigint;
  /**
   * The factory gate (`checkFactoryParams`: caps, supply consistency, final-lot fee >= 0.1 KAS)
   * is enforced by default. Harness presets such as `tiny` fail it (final-lot fee 0.0041 KAS) and may
   * only be created when the caller states a reason, which is recorded on the result.
   */
  readonly factoryGate?: { readonly skip: true; readonly reason: string };

  /**
   * The KAS/USD price the app showed when it picked the band (`assertBandForPrice`): a Standard-family launch must be
   * on the band of this price, and the price must be fresh. Required on mainnet.
   */
  readonly kasPrice?: KasPriceQuote;
  /** The clock the price's freshness is measured against (default `Date.now()`; tests). */
  readonly nowMs?: number;
}

export interface CreateResult {
  readonly tx01: AssembledTx;
  readonly tx2: AssembledTx;
  readonly prepAndCurveGenesis: Shaped;
  readonly tokenGenesisInit: Shaped;
  readonly registration: RegistrationPayload;
  /** Lineage ids, lowercase hex. */
  readonly C: string;
  readonly T: string;
  readonly payload: Uint8Array;
  readonly genesisCurveState: CurveState;
  readonly initCurveState: CurveState;
  /** Set when the factory gate was skipped, with the caller's reason. */
  readonly factoryGateSkipped: string | undefined;
}

/** A launch whose ticker or whole name is reserved (`reservedNameOf` in @kasseal/codec). */
export class ReservedTickerError extends Error {
  readonly word: string;
  readonly field: 'ticker' | 'name';
  constructor(word: string, field: 'ticker' | 'name') {
    super(`buildCreate: the ${field} reads as ${word}, which is reserved`);
    this.name = 'ReservedTickerError';
    this.word = word;
    this.field = field;
  }
}

export const DEFAULT_PREP_VALUE = 5n * SOMPI_PER_KAS;
export const DEFAULT_CURVE_VALUE = 5n * SOMPI_PER_KAS;

/** Build tx01 and tx2. Both are unsigned; tx01 needs its funding inputs signed, tx2 in0 and its funding inputs (the creator's P2PK inputs). */
export function buildCreate(params: CreateParams): CreateResult {
  const { ctx, creatorAddress, metadata, funding } = params;
  const prepValue = params.prepValue ?? DEFAULT_PREP_VALUE;
  const curveValue = params.curveValue ?? DEFAULT_CURVE_VALUE;
  const fees = feeFields(params);
  const curve = ctx.curve;
  // Network rules first: mainnet launches Standard only.
  contextSet(ctx);
  assertPresetAllowedOnNetwork(ctx);
  // Mainnet: the template's compiled treasury must be a mainnet treasury (never a testnet key).
  assertTreasuryAllowedOnNetwork(ctx);
  assertBandForPrice(ctx, params.kasPrice, params.nowMs ?? Date.now());
  let factoryGateSkipped: string | undefined;
  if (params.factoryGate?.skip) {
    if (!params.factoryGate.reason) throw new Error('factoryGate.skip needs a reason');
    factoryGateSkipped = params.factoryGate.reason;
    validatePreset(launchPresetOf(curve)); // caps and supply consistency still hold; only the final-lot fee rule is waived
  } else {
    checkFactoryParams(launchPresetOf(curve));
  }
  if (funding.length === 0) throw new Error('buildCreate: no funding');
  // The token's name and ticker are the declaration's `name` and `symbol` (KCC-23): a launch without either would
  // show blank everywhere (as a launch with `ticker` instead of `symbol` did).
  for (const k of ['name', 'symbol'] as const) {
    const v = (metadata as unknown as Record<string, unknown>)[k];
    if (typeof v !== 'string' || v.trim() === '') throw new Error(`buildCreate: the declaration needs a non-empty ${k === 'symbol' ? 'ticker (`symbol`)' : 'name (`name`)'}`);
  }
  // Reserved tickers (@kasseal/codec RESERVED_TICKERS): a ticker or whole name that reads as a
  // well-known token, a major coin or Kasseal's own is refused; only the company wallet may launch SEAL and KASSEAL.
  const reserved = reservedNameOf(ctx.networkId, { name: metadata.name, ticker: metadata.symbol }, creatorAddress);
  if (reserved !== null) throw new ReservedTickerError(reserved.word, reserved.field);
  const creatorSpk = p2pkScript(creatorAddress);
  const payload = encodeDeclaration(metadata);

  // tx01 ------------------------------------------------------------------
  const genesisCurveState: CurveState = { tokenCovId: ZERO32, lotsSold: 0n, feeAccrued: 0n, phase: PHASE_UNINIT };
  const genesisProgram = curveProgram(curve, genesisCurveState);
  if (toHex(genesisProgram) !== toHex(curve.bytecode)) throw new Error('curve genesis program differs from the compiled artifact');
  const plan01: TxPlan = {
    name: 'tx01 prep + curve genesis',
    inputs: funding.map((u, i) => kasInput(u, i === 0 ? 'creator KAS (prep + genesis funding)' : `creator KAS ${i}`)),
    outputs: [
      plainOutput('prep outpoint P2PK(creator)', prepValue, creatorSpk),
      curveOutput(ctx, 'CURVE genesis {phase 0}', genesisCurveState, curveValue, undefined, undefined),
    ],
    residual: changeTo(creatorSpk, 'change (creator)'),
    genesisGroups: [{ authorizingInput: 0, outputs: [1] }],
    payload,
    ...fees,
  };
  // The prep outpoint is reserved: tx2 spends it as the T group's authorizing input.
  const prepAndCurveGenesis = finish(plan01, ['prep', 'curve'], 'change', { reserveOutputs: [0] });
  const tx01 = prepAndCurveGenesis.built;
  const C = tx01.genesis[0]!.covenantId;
  if (tx01.residualValue === 0n && params.funding2 === undefined) throw new Error('tx01 has no change output to fund tx2; pass funding2');

  // tx2 -------------------------------------------------------------------
  const changeIndex = tx01.outputs.findIndex((o) => o.label === 'change (creator)');
  const funding2: readonly FundingUtxo[] = params.funding2 ?? [{ outpoint: { txid: tx01.txid, index: changeIndex }, amount: tx01.residualValue, spk: creatorSpk, daaScore: 0n, address: creatorAddress }];
  const g = buildTokenGenesisInit({ ctx, creatorAddress, prepTxid: tx01.txid, C, prepValue, curveValue, funding2, ...fees });
  const { T, initCurveState, supplyState, reserveState } = g;
  const tokenGenesisInit = g.shaped;
  const tx2 = tokenGenesisInit.built;

  const registration = registrationOf(ctx, C, T, payload, [supplyState, reserveState]);
  return { tx01, tx2, prepAndCurveGenesis, tokenGenesisInit, registration, C, T, payload, genesisCurveState, initCurveState, factoryGateSkipped };
}

export interface TokenGenesisInitParams extends FeeOptions {
  readonly ctx: BuilderContext;
  readonly creatorAddress: string;
  /** tx01's txid: tx2 spends its prep outpoint (0) and its curve genesis cell (1). */
  readonly prepTxid: string;
  /** The curve lineage C that tx01 created. */
  readonly C: string;
  readonly prepValue: bigint;
  readonly curveValue: bigint;
  /** The creator's KAS inputs (tx01's change by default in `buildCreate`). */
  readonly funding2: readonly FundingUtxo[];
}

/**
 * tx2 alone, from tx01's outpoints and the curve context (what `buildCreate` builds second). A resumed launch rebuilds
 * the stored tx2 with it and compares (`checkResumedTokenGenesis`).
 */
export function buildTokenGenesisInit(params: TokenGenesisInitParams): { shaped: Shaped; T: string; initCurveState: CurveState; supplyState: ReturnType<typeof covenantOwnedToken>; reserveState: ReturnType<typeof covenantOwnedToken> } {
  const { ctx, creatorAddress, prepTxid, C, prepValue, curveValue, funding2 } = params;
  const curve = ctx.curve;
  const p = curve.params;
  const creatorSpk = p2pkScript(creatorAddress);
  const genesisCurveState: CurveState = { tokenCovId: ZERO32, lotsSold: 0n, feeAccrued: 0n, phase: PHASE_UNINIT };
  const genesisProgram = curveProgram(curve, genesisCurveState);
  const curveSupply = p.curveLots * p.lot;
  const supplyState = covenantOwnedToken(curveSupply, C);
  const reserveState = covenantOwnedToken(p.gradReserve, C);
  const out0 = tokenOutput(ctx, 'KCC20 supply cell {CURVE_SUPPLY, owner C}', supplyState, p.tokenCellKas, undefined, undefined);
  const out1 = tokenOutput(ctx, 'KCC20 reserve cell {GRAD_RESERVE, owner C}', reserveState, p.tokenCellKas, undefined, undefined);
  const prepOutpoint = { txid: prepTxid, index: 0 };
  // T is a pure function of (prep outpoint, out0, out1), all fixed here.
  const T = covenantIdKip20(prepOutpoint.txid, prepOutpoint.index, [
    { index: 0, value: out0.value, scriptVersion: 0, script: out0.spk },
    { index: 1, value: out1.value, scriptVersion: 0, script: out1.spk },
  ]);
  if (T === C) throw new Error('token lineage id collides with the curve id');
  const initCurveState: CurveState = { tokenCovId: fromHex(T), lotsSold: 0n, feeAccrued: 0n, phase: PHASE_ACTIVE };
  const prepUtxo: FundingUtxo = { outpoint: prepOutpoint, amount: prepValue, spk: creatorSpk, daaScore: 0n, address: creatorAddress };
  const curveCell = { kind: 'curve' as const, outpoint: { txid: prepTxid, index: 1 }, value: curveValue, covenantId: C, program: genesisProgram, state: genesisCurveState, daaScore: 0n };
  const plan2: TxPlan = {
    name: 'tx2 token genesis + curve init',
    inputs: [
      kasInput(prepUtxo, 'tx01:0 prep outpoint (authorizing input of the T group)'),
      curveInput(curveCell, 'tx01:1 CURVE init(prefix, suffix)', budgetsOf(ctx).curveInit, curveInitSigScript(curve, genesisProgram, ctx.token.prefix, ctx.token.suffix)),
      ...funding2.map((u, i) => kasInput(u, i === 0 ? 'creator KAS (cell funding + fee)' : `creator KAS ${i}`)),
    ],
    outputs: [
      { ...out0, cell: out0.cell ? { ...out0.cell, covenantId: T } : undefined },
      { ...out1, cell: out1.cell ? { ...out1.cell, covenantId: T } : undefined },
      curveOutput(ctx, "CURVE' {T, 0, 0, active}", initCurveState, curveValue, C, 1),
    ],
    residual: changeTo(creatorSpk, 'change (creator)'),
    genesisGroups: [{ authorizingInput: 0, outputs: [0, 1] }],
    payload: new Uint8Array(0),
    ...feeFields(params),
  };
  const shaped = finish(plan2, ['token-rest', 'token-reserve', 'curve'], 'change');
  if (shaped.built.genesis[0]!.covenantId !== T) throw new Error(`tx2 genesis id ${shaped.built.genesis[0]!.covenantId} != client-side T ${T}`);
  return { shaped, T, initCurveState, supplyState, reserveState };
}

/** `POST /v1/registrations`: the curve part and the token part of one creation. */
export function registrationOf(ctx: BuilderContext, C: string, T: string, declaration: Uint8Array, genesisStates: readonly Parameters<typeof tokenStateToJson>[0][]): RegistrationPayload {
  const c = ctx.curve;
  const p = c.params;
  return {
    expectedCurveId: C,
    curveTemplate: { prefix: toHex(c.prefix), suffix: toHex(c.suffix) },
    params: {
      preset: c.preset,
      templateHash: c.templateHash,
      p0: p.p0.toString(), k: p.k.toString(), lot: p.lot.toString(), curveLots: p.curveLots.toString(), gradReserve: p.gradReserve.toString(),
      feeBps: p.feeBps.toString(), tokenCellKas: p.tokenCellKas.toString(), openWindowLots: p.openWindowLots.toString(), openWindowMaxLots: p.openWindowMaxLots.toString(),
      tokenH: p.tokenH, poolH: p.poolH,
    },
    ...(p.treasurySpk === undefined ? {} : { treasurySpk: toHex(p.treasurySpk) }),
    contractSet: c.version,
    creatorSpk: toHex(p.creatorSpk),
    declaration: toHex(declaration),
    expectedTokenId: T,
    genesisStates: genesisStates.map(tokenStateToJson),
  };
}
