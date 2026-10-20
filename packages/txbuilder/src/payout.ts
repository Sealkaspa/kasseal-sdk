/**
 * Fee payouts per contract set: who a curve `sweep`, a curve `graduate` and a pool `sweep` pay, and how much.
 *
 *   v1       curve and pool 50 % treasury / 50 % creator (the creator takes the odd sompi).
 *
 * Graduation pays the split only from a minimum accrual up (1 KAS, curve-math's `GRADUATION_PAYOUT_MIN`),
 * otherwise the accrual folds into the pool's escrow.
 *
 * The arithmetic is curve-math's (`curveFeeSplit`, `poolSweepSplit`, `graduationPayout`); this module only routes each
 * set to it, so the builder, the claim planner and the self-checks agree by construction.
 */

import { GRADUATION_PAYOUT_MIN, curveFeeSplit, graduationPayout, poolSweepSplit, type LaunchPreset } from '@kasseal/curve-math';
import { feeModelOf } from '@kasseal/codec';
import type { ContractSet } from './artifacts.ts';

/** A two-way payout; `total` is always the sum of the shares. */
export interface PayoutSplit {
  /** Always `treasury` (a treasury / creator split). */
  readonly kind: 'treasury';
  /** The payout, sompi. */
  readonly total: bigint;
  /** The treasury's share, sompi. */
  readonly treasury: bigint;
  /** The creator's share, sompi. */
  readonly creator: bigint;
}

/** The split of a curve fee payout (`sweep`, `graduate`) of a contract set. */
export function curvePayoutSplit(set: ContractSet, total: bigint): PayoutSplit {
  const s = curveFeeSplit(total, feeModelOf(set));
  return { kind: 'treasury', total, treasury: s.treasury, creator: s.creator };
}

/** The split of a pool sweep's payout (accrual * 1e6 + dust) of a contract set. */
export function poolPayoutSplit(set: ContractSet, total: bigint): PayoutSplit {
  const s = poolSweepSplit(total, feeModelOf(set));
  return { kind: 'treasury', total, treasury: s.treasury, creator: s.creator };
}

/** The Kasseal side of a split (the treasury's share), for displays. */
export function kassealShare(s: PayoutSplit): bigint {
  return s.treasury;
}

/** What `graduate` pays and what the pool opens with (`graduationPayoutOf`). */
export interface GraduationPayoutOf {
  /** The pool cell's opening value: the curve value minus the fees paid out (or all of it on the fold path). */
  readonly escrow: bigint;
  /** The accrual folded into the escrow (below the set's minimum), else 0. */
  readonly pooled: bigint;
  /** The split paid at graduation, or undefined on the fold path. */
  readonly split: PayoutSplit | undefined;
}

/**
 * What `graduate` pays: the set's split when `feeAccrued` reaches its minimum (1 KAS), otherwise the fold path, where
 * the accrual stays in the escrow and no fee output exists.
 */
export function graduationPayoutOf(set: ContractSet, preset: LaunchPreset, curveValue: bigint, feeAccrued: bigint): GraduationPayoutOf {
  feeModelOf(set);
  const g = graduationPayout(preset, curveValue, feeAccrued);
  // The path is the contract's test (`feeAccrued >= GRAD_FEE_MIN`), not `pooled == 0`: a curve swept after it sold out
  // has nothing accrued, folds nothing and pays nothing (no fee outputs).
  return feeAccrued >= GRADUATION_PAYOUT_MIN
    ? { escrow: g.escrow, pooled: 0n, split: { kind: 'treasury', total: feeAccrued, treasury: g.treasury, creator: g.creator } }
    : { escrow: g.escrow, pooled: g.pooled, split: undefined };
}
