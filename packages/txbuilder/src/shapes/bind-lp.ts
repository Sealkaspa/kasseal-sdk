/**
 * bindLp(tokenPrefix, tokenSuffix) (the v1 pool): the pool's first spend after graduation genesis-mints the LP-share lineage
 * L and writes its id into the pool state. Permissionless, once per pool; anyone may submit it.
 *
 *   in0   POOL (P, unbound: lpCovId 0^32, lpShares LOCKED_SHARES)   bindLp(tokenPrefix, tokenSuffix)
 *   in1.. KAS (P2PK); in1 is the authorizing input of the L genesis group, funds the inventory cell and pays the fee
 *   out0  POOL'  binding (0, P)   {.., lpCovId = L, ..}, value == in0 value (dust and accrual travel with it)
 *   out1  L inventory  genesis group (1, [1]) => L   KCC20{H_T, LP_SUPPLY, owner P, 0x04, 0x00, 0^32, ext}, value TOKEN_CELL_KAS (10 KAS)
 *         ext = P (L bound to its pool, inherited by every L cell; `lpExtensionOf`)
 *   out2  change (plain P2PK; bound to neither L nor P), at most one; tx.outputs.length <= 3
 *
 * No T input (the covenant requires `OpCovInputCount(T) == 0`), no L input (`OpCovInputCount(L) == 0`:
 * L is a genesis of this transaction, the counterfeit guard applied at creation). L is computed per
 * KIP-20 section 3.2 over the authorizing outpoint and the single member output, as the builder
 * already computes P at graduation, and asserted against the SDK's binding by `assemble`.
 *
 * Between graduation and the bind the pool is swap-only; after it, `addLiquidity` and
 * `removeLiquidity` are open (shapes/liquidity.ts).
 */

import { hasOpenLiquidity } from '../artifacts.ts';
import { fromHex, toHex, type TokenState } from '@kasseal/codec';
import { LOCKED_SHARES, LP_SUPPLY } from '@kasseal/curve-math';
import { covenantIdKip20 } from '../blake2b.ts';
import { p2pkScript, type FundingUtxo, type PoolCell, type TxPlan } from '../assemble.ts';
import { budgetsV3Of, changeTo, contextSet, kasInput, poolInput, poolOutput, tokenOutput, type BuilderContext } from '../cells.ts';
import { SOMPI_PER_KAS } from '../mass.ts';
import { POOL_UNBOUND_LP_COV_ID, covenantOwnedToken, isPoolBound, lpExtensionOf, poolProgram, type PoolCellState } from '../program.ts';
import { predictedFunding } from '../select/funding.ts';
import { buildGraduate, type GraduateParams, type GraduateResult } from './graduate.ts';
import { poolBindLpSigScript } from '../sigscript.ts';
import { feeFields, finish, requirePoolOfContext, type FeeOptions, type Shaped, requireOwnLineages } from './common.ts';

/** `TOKEN_CELL_KAS` of the v1 `pool.sil`, sompi: the least value of the L inventory cell `bindLp` creates (the curve's floor for every owned token cell). */
export const LP_INVENTORY_CELL_VALUE = 10n * SOMPI_PER_KAS;
/** The pinned output layout of `bindLp` (`pool.sil`): the pool continuation's index. */
export const BIND_POOL_OUT = 0;
/** `bindLp`: the L inventory cell's index. */
export const BIND_LP_OUT = 1;
/** `bindLp`: the most outputs the covenant allows. */
export const BIND_MAX_OUTS = 3;
/** The authorizing input of the L genesis group: the first funding input. */
const L_AUTHORIZING_INPUT = 1;

/** Inputs of `buildBindLp`. */
export interface BindLpParams extends FeeOptions {
  /** The network's builder context. */
  readonly ctx: BuilderContext;
  /** The unbound pool cell. */
  readonly pool: PoolCell;
  /** The signer's KAS: the first UTXO authorizes the L genesis group; together they fund the inventory cell and the fee. */
  readonly funding: readonly FundingUtxo[];
  /** P2PK address for change. */
  readonly changeAddress: string;
  /** Value of the L inventory cell (default and minimum `TOKEN_CELL_KAS`, 10 KAS). */
  readonly inventoryValue?: bigint;
}

/** The built bind and the pool's new state. */
export interface BindLpResult extends Shaped {
  /** The LP-share lineage the transaction creates (hex). */
  readonly L: string;
  /** The pool's predicted state (`lpCovId = L`). */
  readonly poolNext: PoolCellState;
  /** The inventory cell's state: `{H_T, LP_SUPPLY, owner P, 0x04, 0x00, 0^32, 0^32}`. */
  readonly inventoryNext: TokenState;
  /** Compute budgets per input (the pool's `poolBindLp` row, then `BUDGETS.p2pk` per funding input). */
  readonly budgets: readonly number[];
  /** The fee paid, sompi (the mass model's minimum plus the margin). */
  readonly fee: bigint;
}

/** Build `bindLp` on an unbound v1 pool; refuses a bound pool, a pool without liquidity entries and an inventory below 10 KAS. */
export function buildBindLp(params: BindLpParams): BindLpResult {
  const { ctx, pool, funding } = params;
  if (!hasOpenLiquidity(requirePoolOfContext(ctx, pool))) throw new Error('bindLp exists in the v1 pool only');
  if (isPoolBound(pool.state)) throw new Error(`pool ${pool.covenantId} is already bound to L ${toHex(pool.state.lpCovId!)}`);
  if (pool.state.lpShares !== LOCKED_SHARES) throw new Error(`an unbound pool is at the graduation share count ${LOCKED_SHARES}, this one says ${pool.state.lpShares}`);
  if (funding.length === 0) throw new Error('bindLp needs a KAS input as the L genesis authorizing input');
  const V = params.inventoryValue ?? LP_INVENTORY_CELL_VALUE;
  if (V < LP_INVENTORY_CELL_VALUE) throw new Error(`inventory cell value ${V} is below TOKEN_CELL_KAS (${LP_INVENTORY_CELL_VALUE} sompi)`);
  const P = pool.covenantId;
  const T = toHex(pool.state.tokenCovId);

  // The inventory: the whole sealed supply, owned by P, on the reference template (ctx H_T); its extension commitment is
  // P on the current v1 builds, 0^32 on the earlier frozen builds the pool program was compiled for.
  const inventoryNext = covenantOwnedToken(LP_SUPPLY, P, lpExtensionOf(ctx.pool, P));
  const out1 = tokenOutput(ctx, 'L inventory (genesis, owner P)', inventoryNext, V, undefined, undefined);
  const auth = funding[0]!;
  const L = covenantIdKip20(auth.outpoint.txid, auth.outpoint.index, [{ index: BIND_LP_OUT, value: V, scriptVersion: 0, script: out1.spk }]);
  if (L === toHex(POOL_UNBOUND_LP_COV_ID) || L === P || L === T) throw new Error('L collides with 0^32, P or T');

  const poolNext: PoolCellState = { ...pool.state, lpCovId: fromHex(L) };
  const out0 = poolOutput(ctx, "POOL' {lpCovId L}", poolNext, pool.value, P, BIND_POOL_OUT);
  const plan: TxPlan = {
    name: 'bindLp',
    inputs: [
      poolInput(pool, 'POOL bindLp(tokenPrefix, tokenSuffix)', budgetsV3Of(ctx).poolBindLp, poolBindLpSigScript(ctx.pool, pool.program, ctx.token)),
      ...funding.map((u, i) => kasInput(u, i === 0 ? 'KAS (L genesis authorizing input, inventory funding, fee)' : 'KAS')),
    ],
    outputs: [out0, { ...out1, cell: out1.cell ? { ...out1.cell, covenantId: L } : undefined }],
    residual: changeTo(p2pkScript(params.changeAddress)),
    genesisGroups: [{ authorizingInput: L_AUTHORIZING_INPUT, outputs: [BIND_LP_OUT] }],
    payload: new Uint8Array(0),
    ...feeFields(params),
  };
  requireOwnLineages(plan, [P]);
  const s = finish(plan, ['pool', 'token-reserve'], 'change');
  if (s.built.genesis[0]!.covenantId !== L) throw new Error(`L genesis id ${s.built.genesis[0]!.covenantId} != client-side L ${L}`);
  if (s.built.outputs.length > BIND_MAX_OUTS) throw new Error(`bindLp has ${s.built.outputs.length} outputs, the covenant allows ${BIND_MAX_OUTS}`);
  if (s.built.outputs[BIND_POOL_OUT]!.value !== pool.value) throw new Error('pool value must be unchanged by the bind');
  return { ...s, L, poolNext, inventoryNext, budgets: s.built.budgets, fee: s.built.fee };
}

/** Inputs of `buildGraduateAndBind`. */
export interface GraduateAndBindParams extends GraduateParams {
  /** Value of the L inventory cell (default and minimum `TOKEN_CELL_KAS`, 10 KAS). */
  readonly inventoryValue?: bigint;
}

/** A graduation and, where the pool has liquidity entries, its chained bind. */
export interface GraduateAndBindResult {
  /** The graduation. */
  readonly graduate: GraduateResult;
  /** The bindLp spending the pool graduate creates and graduate's change; absent for a pool without liquidity entries (none of the v1 builds). */
  readonly bind?: BindLpResult;
  /** The pool cell graduate creates (output 0), as bindLp spends it. */
  readonly pool: PoolCell;
}

/**
 * Graduation, then the pool's `bindLp` at once (every pool opens liquidity without anyone waiting). The bind spends graduate's pool output and graduate's change while graduate is still pending (a chained
 * pair: submit graduate first, then the bind), so the funding must leave a change of at least the inventory cell's
 * value plus the bind's fee; the bind is built on exactly that change and nothing else. On a set without liquidity
 * entries only graduate is built.
 */
export function buildGraduateAndBind(params: GraduateAndBindParams): GraduateAndBindResult {
  const { ctx, changeAddress } = params;
  const graduate = buildGraduate(params);
  const g = graduate.built;
  const pool: PoolCell = {
    kind: 'pool', outpoint: { txid: g.txid, index: 0 }, value: g.outputs[0]!.value, covenantId: graduate.P,
    program: poolProgram(ctx.pool, graduate.poolNext), state: graduate.poolNext, daaScore: 0n,
  };
  if (!hasOpenLiquidity(contextSet(ctx))) return { graduate, pool };
  // graduate's change is its last output when it pays one (the residual); the bind is funded by it alone.
  const changeSpk = p2pkScript(changeAddress);
  const last = g.outputs.length - 1;
  if (g.residualValue <= 0n || toHex(g.outputs[last]!.spk) !== toHex(changeSpk)) {
    throw new Error('graduate pays no change to fund the bind: fund it with at least the inventory value plus both fees');
  }
  const change = predictedFunding({ txid: g.txid, index: last }, g.outputs[last]!.value, changeSpk, changeAddress);
  const bind = buildBindLp({
    ctx, pool, funding: [change], changeAddress,
    ...(params.inventoryValue === undefined ? {} : { inventoryValue: params.inventoryValue }),
    ...(params.feeMargin === undefined ? {} : { feeMargin: params.feeMargin }), ...(params.feerate === undefined ? {} : { feerate: params.feerate }),
  });
  return { graduate, bind, pool };
}
