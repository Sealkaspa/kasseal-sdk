/**
 * Fee sweeps; anyone may submit them and pay the fee.
 *
 * curve sweep():
 *   in0   CURVE (C)        sweep()            no T input (`OpCovInputCount(T) == 0`)
 *   in1.. anyone's KAS     fee
 *   out0  CURVE' {feeAccrued 0}  binding (0, C)   value = in0 - feeAccrued
 *   out1  treasury       floor(feeAccrued * 50 / 100) to the constructor's treasury script
 *   out2  creator        the remainder to the constructor's creator script
 *   out3  change
 *   Allowed while `lotsSold < curveLots` and `feeAccrued >= 10 KAS`.
 *
 * pool sweep(), payout = feeAccruedScaled * 1e6 + dust:
 *   in0   POOL (P)         sweep()            no T input
 *   in1.. anyone's KAS
 *   out0  POOL' {feeAccruedScaled 0}  binding (0, P)  value = kasScaled * 1e6 (the dust leaves with the payout)
 *   out1  treasury floor(payout / 2), out2 creator (the pool state's creatorSpk) the remainder, out3 change
 *   The state carries `lpShares` and `lpCovId` unchanged (the pool's sweep forbids any L input, a no-op while unbound).
 */

import { canSweep, sweepPool } from '@kasseal/curve-math';
import { p2pkScript, type CurveCell, type FundingUtxo, type PoolCell, type TxPlan } from '../assemble.ts';
import { budgetsOf, changeTo, contextSet, curveInput, curveOutput, kasInput, poolInput, poolOutput, type BuilderContext } from '../cells.ts';
import { curvePayoutSplit, kassealShare, poolPayoutSplit, type PayoutSplit } from '../payout.ts';
import { POOL_KAS_SCALE, type CurveState, type PoolCellState } from '../program.ts';
import { curveSweepSigScript, poolSweepSigScript } from '../sigscript.ts';
import { feeFields, finish, payoutOutputs, requireActiveCurve, requirePoolOfContext, type FeeOptions, type Shaped, requireOwnLineages } from './common.ts';
import type { OutputRole } from '../types.ts';
import { launchPresetOf } from './create.ts';
import { poolMathState } from './swap.ts';

/** Inputs of `buildSweep` (a curve sweep). Anyone may sweep; the funder pays the fee. */
export interface SweepParams extends FeeOptions {
  /** The network's builder context. */
  readonly ctx: BuilderContext;
  /** The curve cell. */
  readonly curve: CurveCell;
  /** The funder's P2PK UTXOs. */
  readonly funding: readonly FundingUtxo[];
  /** P2PK address for change. */
  readonly changeAddress: string;
}

/** The shares a sweep pays. */
export interface SweepShares {
  /** The treasury's share, sompi. */
  readonly treasury: bigint;
  /** The creator's share, sompi. */
  readonly creator: bigint;
  /** The whole split, as the covenant computes it. */
  readonly split: PayoutSplit;
}

/** The built curve sweep. */
export interface SweepResult extends Shaped, SweepShares {
  /** The curve's predicted state (`feeAccrued` 0). */
  readonly curveNext: CurveState;
}

/** The share fields of a split. */
export function sharesOf(split: PayoutSplit): SweepShares {
  return { treasury: split.treasury, creator: split.creator, split };
}

/** Build a curve `sweep()`; refuses while fees are below 10 KAS and once the curve sold out. */
export function buildSweep(params: SweepParams): SweepResult {
  const { ctx, curve, funding } = params;
  requireActiveCurve(ctx, curve);
  const version = contextSet(ctx);
  const preset = launchPresetOf(ctx.curve);
  if (!canSweep(preset, curve.state.lotsSold, curve.state.feeAccrued)) throw new Error(`sweep not allowed: lotsSold ${curve.state.lotsSold}, feeAccrued ${curve.state.feeAccrued}`);
  if (funding.length === 0) throw new Error('sweep needs a funding input for the fee');
  const split = curvePayoutSplit(version, curve.state.feeAccrued);
  const pct = preset.treasurySharePct;
  const payees = payoutOutputs(split, ctx.curve.params, { treasury: `treasury (${pct} %)`, creator: `creator (${100n - pct} %)` });
  const curveNext: CurveState = { ...curve.state, feeAccrued: 0n };
  const plan: TxPlan = {
    name: 'sweep',
    inputs: [
      curveInput(curve, 'CURVE sweep()', budgetsOf(ctx).curveSweep, curveSweepSigScript(ctx.curve, curve.program)),
      ...funding.map((u) => kasInput(u, 'KAS (fee)')),
    ],
    outputs: [
      curveOutput(ctx, "CURVE' {feeAccrued 0}", curveNext, curve.value - curve.state.feeAccrued, curve.covenantId, 0),
      ...payees.outputs,
    ],
    residual: changeTo(p2pkScript(params.changeAddress)),
    genesisGroups: [],
    payload: new Uint8Array(0),
    ...feeFields(params),
  };
  if (kassealShare(split) + split.creator !== curve.state.feeAccrued) throw new Error('sweep shares do not add up to the accrual');
  requireOwnLineages(plan, [curve.covenantId]);
  return { ...finish(plan, ['curve', ...payees.roles], 'change'), curveNext, ...sharesOf(split) };
}

/** Inputs of `buildPoolSweep`. Anyone may sweep; the funder pays the fee. */
export interface PoolSweepParams extends FeeOptions {
  /** The network's builder context. */
  readonly ctx: BuilderContext;
  /** The pool cell. */
  readonly pool: PoolCell;
  /** The funder's P2PK UTXOs. */
  readonly funding: readonly FundingUtxo[];
  /** P2PK address for change. */
  readonly changeAddress: string;
}

/** The built pool sweep. */
export interface PoolSweepResult extends Shaped, SweepShares {
  /** The pool's predicted state (accrual 0, dust 0). */
  readonly poolNext: PoolCellState;
  /** Accrual + dust, in sompi. */
  readonly payout: bigint;
}

/** Build a pool `sweep()`; refuses while the accrual is below 10 KAS. */
export function buildPoolSweep(params: PoolSweepParams): PoolSweepResult {
  const { ctx, pool, funding } = params;
  if (funding.length === 0) throw new Error('pool sweep needs a funding input for the fee');
  const version = contextSet(ctx);
  requirePoolOfContext(ctx, pool);
  const r = sweepPool(poolMathState(pool));
  const split = poolPayoutSplit(version, r.payout);
  const poolNext: PoolCellState = { ...pool.state, feeAccruedScaled: 0n };
  // Every pool pays the creator its state names.
  const treasuryOnly = false;
  if (pool.state.creatorSpk === undefined) throw new Error(`a ${version} pool state without a creator`);
  const scripts = { treasurySpk: ctx.pool.treasurySpk, creatorSpk: pool.state.creatorSpk ?? new Uint8Array(0) };
  const payees = payoutOutputs(split, scripts, { treasury: treasuryOnly ? 'treasury (accrual + dust)' : 'treasury (half of accrual + dust)', creator: 'creator (half of accrual + dust)' }, treasuryOnly);
  const plan: TxPlan = {
    name: 'pool sweep',
    inputs: [
      poolInput(pool, 'POOL sweep()', budgetsOf(ctx).poolSweep, poolSweepSigScript(ctx.pool, pool.program)),
      ...funding.map((u) => kasInput(u, 'KAS (fee)')),
    ],
    outputs: [
      poolOutput(ctx, "POOL' {feeAccruedScaled 0}", poolNext, pool.state.kasScaled * POOL_KAS_SCALE, pool.covenantId, 0),
      ...payees.outputs,
    ],
    residual: changeTo(p2pkScript(params.changeAddress)),
    genesisGroups: [],
    payload: new Uint8Array(0),
    ...feeFields(params),
  };
  if (kassealShare(split) + split.creator !== r.payout) throw new Error('pool sweep shares do not add up to the payout');
  const roles: OutputRole[] = ['pool', ...payees.roles];
  requireOwnLineages(plan, [pool.covenantId]);
  return { ...finish(plan, roles, 'change'), poolNext, payout: r.payout, ...sharesOf(split) };
}
