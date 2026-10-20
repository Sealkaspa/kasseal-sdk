/**
 * graduate(poolPrefix, poolSuffix), always with the empty supply cell:
 *
 *   in0   CURVE (C)                      graduate(poolPrefix, poolSuffix)   lotsSold == curveLots
 *   in1   reserve cell (T leader)        transfer([reserve'], 00)           owner C, amount gradReserve
 *   in2   empty supply cell (T delegator) transfer_delegator(empty)         owner C, amount 0
 *   in3.. KAS (P2PK); in3 is the authorizing input of the P genesis group and pays the fee
 *   out0  POOL genesis  group (3, [0]) => P   {T, floor(escrow / 1e6), gradReserve, LOCKED_SHARES, lpCovId 0^32, 0, creatorSpk}, value = escrow
 *   out1  reserve'      binding (1, T)        {gradReserve, owner P, 0x04}, value = reserve + empty supply cell values
 *                                             (only the reserve's with `keepSupplyDeposit`: the supply cell's then joins the change)
 *   out2  treasury, out3 creator             only when feeAccrued >= 1 KAS (50 / 50)
 *   out4  change                              (no CURVE' output: graduation is terminal)
 *   No output but out0 is bound to P (the change is a plain P2PK output).
 *
 * The empty supply cell is always consumed: a graduation that omits it leaves
 * 10 KAS locked under a C that no longer exists. Its deposit goes into the
 * reserve output, or, with `keepSupplyDeposit`, into the change: the curve only requires the reserve to hold `tokenCellKas`
 * (curve.sil graduate), and the deposit offsets the 10 KAS the bind's inventory
 * cell locks.
 * The budgets come from the two-T-input shape measured on chain.
 *
 * The pool genesis state carries the curve's own creatorSpk (the pool's sweep
 * pays it half of the accrual). The output layout is pinned by the covenant:
 * pool at 0, reserve at 1, fee outputs at 2 and 3 when due, at most one change
 * output, no other output bound to P; the 139-byte v1 pool genesis state is created
 * unbound: `lpCovId = 0^32` because a state naming L cannot exist in the
 * transaction that creates L; the pool's `bindLp` names it.
 */

import type { TokenState } from '@kasseal/codec';
import { LOCKED_SHARES, openPool } from '@kasseal/curve-math';
import { covenantIdKip20 } from '../blake2b.ts';
import { p2pkScript, type CurveCell, type FundingUtxo, type TokenCell, type TxPlan } from '../assemble.ts';
import { budgetsOf, changeTo, contextSet, curveInput, kasInput, poolOutput, tokenDelegatorCovenantInput, tokenLeaderCovenantInput, tokenOutput, type BuilderContext } from '../cells.ts';
import { graduationPayoutOf } from '../payout.ts';
import { BUDGETS } from '../mass.ts';
import { POOL_UNBOUND_LP_COV_ID, covenantOwnedToken, isCovenantOwnedBy, type PoolCellState } from '../program.ts';
import { curveGraduateSigScript } from '../sigscript.ts';
import type { OutputRole } from '../types.ts';
import { WITNESS_COVENANT, checkTokenFamily, curveOwnedCellValue, feeFields, finish, payoutOutputs, requireActiveCurve, type FeeOptions, type Shaped, requireOwnLineages } from './common.ts';
import { launchPresetOf } from './create.ts';
import { sharesOf, type SweepShares } from './sweep.ts';

/** Inputs of `buildGraduate`. Anyone may graduate a sold-out curve; the funder pays the fee. */
export interface GraduateParams extends FeeOptions {
  /** The network's builder context. */
  readonly ctx: BuilderContext;
  /** The sold-out curve cell. */
  readonly curve: CurveCell;
  /** The curve-owned reserve cell (amount GRAD_RESERVE). */
  readonly reserve: TokenCell;
  /** The curve-owned, empty supply cell. Always included: its deposit is otherwise locked forever. */
  readonly supplyEmpty: TokenCell;
  /**
   * Pay the empty supply cell's deposit (`tokenCellKas`) to the change instead of the pool's reserve. Default false:
   * the reserve absorbs it, as the app's "Open the pool" does.
   */
  readonly keepSupplyDeposit?: boolean;
  /** The funder's P2PK UTXOs; the first authorizes the pool genesis group. */
  readonly funding: readonly FundingUtxo[];
  /** P2PK address for change. */
  readonly changeAddress: string;
}

/** The built graduation and the new pool. */
export interface GraduateResult extends Shaped, Omit<SweepShares, 'split'> {
  /** The new pool's covenant id P, hex. */
  readonly P: string;
  /** The pool's genesis state. */
  readonly poolNext: PoolCellState;
  /** The reserve's new state (owned by P). */
  readonly reserveNext: TokenState;
  /** The pool cell's value, sompi. */
  readonly escrow: bigint;
  /** Sompi below one scaled unit carried by the pool cell. */
  readonly dust: bigint;
  /** The accrual folded into the escrow (fold path), else 0. */
  readonly pooled: bigint;
}

const FUNDING_INDEX = 3;

/** Build `graduate` on a sold-out curve; refuses a curve that is not sold out and reserve or supply cells it does not own. */
export function buildGraduate(params: GraduateParams): GraduateResult {
  const { ctx, curve, reserve, supplyEmpty, funding } = params;
  const p = ctx.curve.params;
  const T = requireActiveCurve(ctx, curve);
  if (curve.state.lotsSold !== p.curveLots) throw new Error(`graduate needs lotsSold == ${p.curveLots}, have ${curve.state.lotsSold}`);
  for (const [name, cell] of [['reserve', reserve], ['supply', supplyEmpty]] as const) {
    if (cell.covenantId !== T) throw new Error(`${name} cell is not of lineage T`);
    if (!isCovenantOwnedBy(cell.state, curve.covenantId)) throw new Error(`${name} cell is not curve-owned`);
  }
  if (reserve.state.amount !== p.gradReserve) throw new Error(`reserve cell holds ${reserve.state.amount}, expected ${p.gradReserve}`);
  if (supplyEmpty.state.amount !== 0n) throw new Error(`supply cell holds ${supplyEmpty.state.amount} tokens, expected 0`);
  // The reserve absorbs the empty supply cell (two token cell values), or keeps one and the change takes the
  // supply cell's. Both cells are held to the token cell floor either way.
  const both = curveOwnedCellValue(ctx, [{ cell: reserve, name: 'reserve' }, { cell: supplyEmpty, name: 'supply' }]);
  const reserveValue = params.keepSupplyDeposit === true ? both - p.tokenCellKas : both;
  if (funding.length === 0) throw new Error('graduate needs a KAS input as the pool genesis authorizing input');

  const version = contextSet(ctx);
  const payout = graduationPayoutOf(version, launchPresetOf(ctx.curve), curve.value, curve.state.feeAccrued);
  const escrow = payout.escrow;
  const pool = openPool(escrow, p.gradReserve);
  // The 139-byte unbound state, naming the curve's creator.
  const poolNext: PoolCellState = { tokenCovId: curve.state.tokenCovId, kasScaled: pool.kasScaled, tokenReserve: p.gradReserve, lpShares: LOCKED_SHARES, lpCovId: Uint8Array.from(POOL_UNBOUND_LP_COV_ID), feeAccruedScaled: 0n, creatorSpk: Uint8Array.from(p.creatorSpk) };
  const out0 = poolOutput(ctx, 'POOL genesis', poolNext, escrow, undefined, undefined);
  const P = covenantIdKip20(funding[0]!.outpoint.txid, funding[0]!.outpoint.index, [{ index: 0, value: escrow, scriptVersion: 0, script: out0.spk }]);
  if (P === curve.covenantId || P === T) throw new Error('pool id collides with C or T');
  const reserveNext = covenantOwnedToken(p.gradReserve, P);
  checkTokenFamily(T, [reserve, supplyEmpty], [reserveNext], WITNESS_COVENANT);
  const pct = launchPresetOf(ctx.curve).treasurySharePct;
  const payees = payout.split === undefined ? { outputs: [], roles: [] } : payoutOutputs(payout.split, p, { treasury: `treasury (${pct} %)`, creator: `creator (${100n - pct} %)` });
  const plan: TxPlan = {
    name: 'graduate',
    inputs: [
      curveInput(curve, 'CURVE graduate(poolPrefix, poolSuffix)', budgetsOf(ctx).curveGraduate, curveGraduateSigScript(ctx.curve, curve.program, ctx.pool)),
      tokenLeaderCovenantInput(reserve, [reserveNext], 'KCC20 reserve cell (T leader, witness 00)', BUDGETS.tokenLeaderCovenant1Out),
      tokenDelegatorCovenantInput(supplyEmpty, 'KCC20 empty supply cell (T delegator, empty witness)'),
      ...funding.map((u, i) => kasInput(u, i === 0 ? 'KAS (P genesis authorizing input, fee)' : 'KAS')),
    ],
    outputs: [
      { ...out0, cell: out0.cell ? { ...out0.cell, covenantId: P } : undefined },
      tokenOutput(ctx, "reserve' (owner P)", reserveNext, reserveValue, T, 1),
      ...payees.outputs,
    ],
    residual: changeTo(p2pkScript(params.changeAddress)),
    genesisGroups: [{ authorizingInput: FUNDING_INDEX, outputs: [0] }],
    payload: new Uint8Array(0),
    ...feeFields(params),
  };
  if (plan.inputs.length - funding.length !== FUNDING_INDEX) throw new Error('unexpected input layout');
  const roles: OutputRole[] = ['pool', 'token-reserve', ...payees.roles];
  requireOwnLineages(plan, [curve.covenantId, T]);
  const s = finish(plan, roles, 'change');
  if (s.built.genesis[0]!.covenantId !== P) throw new Error(`pool genesis id ${s.built.genesis[0]!.covenantId} != client-side P ${P}`);
  // The layout the covenant pins: 2 or 4 fixed outputs, then at most one change output, none bound to P.
  const fixed = 2 + payees.outputs.length;
  if (s.built.outputs.length > fixed + 1 || s.built.outputs.some((o, i) => i > 0 && o.binding?.covenantId === P)) throw new Error('graduate: output layout is not the pinned one');
  const sh = payout.split === undefined ? undefined : sharesOf(payout.split);
  return {
    ...s, P, poolNext, reserveNext, escrow, dust: pool.dust, pooled: payout.pooled,
    treasury: sh?.treasury ?? 0n, creator: sh?.creator ?? 0n,
  };
}
