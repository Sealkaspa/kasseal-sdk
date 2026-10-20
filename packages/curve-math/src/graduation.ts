/**
 * Graduation economics.
 *
 * At `lotsSold == CURVE_LOTS` the curve has raised `cost(0, L)`; the pool
 * opens with that escrow (less fees still accrued) against `GRAD_RESERVE`
 * tokens, so its opening price per lot is `raise / GRAD_LOTS`. The fee rules:
 * `sweep` runs only while the curve is open, `graduate` pays the
 * treasury/creator split only when `feeAccrued >= 1 KAS` and otherwise folds
 * the remainder into the pool, and the factory rejects parameter sets whose
 * final-tranche fee is below 0.1 KAS, so the two fee outputs can always be mined
 * (the P2PK output floor is 0.0201 KAS).
 *
 * Fee model, named `'v2'` after the contract generation that introduced it and
 * used by the v1 contracts: curve split 50 / 50; the pool sweep
 * pays half of the accrual (0.05 % of every pool trade's KAS leg) to the
 * creator named in the pool state. The split rounds the treasury share down;
 * the creator takes the remainder.
 */

import { ParameterError } from './errors.ts';
import { assertBigint, mul, sub } from './int64.ts';
import { finalLotFee, finalLotsFee, fullRaise, lastLotPrice } from './curve.ts';
import { BPS_DENOMINATOR } from './curve.ts';
import { SOMPI_PER_KAS, type LaunchPreset, validatePreset } from './presets.ts';
import { POOL_CREATOR_FEE_BPS_V2 } from './pool.ts';

/**
 * The launch factory rejects parameter sets whose final-tranche fee is below 0.1 KAS (this constant, in sompi). The
 * rule is applied in token terms: the fee on the final `FINAL_FEE_TOKENS` bought in one buy. Measuring it on the final
 * 10,000,000 tokens lets the Standard family stay valid up to KAS = $5.
 */
export const MIN_FINAL_LOT_FEE = SOMPI_PER_KAS / 10n;
/** The token amount the final-tranche fee rule measures (whole tokens). */
export const FINAL_FEE_TOKENS = 10_000_000n;
/** `graduate` pays the fee split only when the accrued fees reach this amount (1 KAS, in sompi). */
export const GRADUATION_PAYOUT_MIN = SOMPI_PER_KAS;

/** The two-way fee model (`'v2'`, the 50/50 split v1 uses). */
export type FeeModelVersion = 'v2';

/** Treasury share of a curve fee payout, in percent. */
export const CURVE_TREASURY_SHARE_PCT: Readonly<Record<FeeModelVersion, bigint>> = Object.freeze({ v2: 50n });

/** What a preset's curve raises and how the pool opens at graduation; amounts in sompi. */
export interface GraduationEconomics {
  /** cost(0, L) in sompi. */
  readonly raise: bigint;
  /** price(L - 1) in sompi. */
  readonly lastLotPrice: bigint;
  /** Tokens the pool opens with. */
  readonly reserveTokens: bigint;
  /** Opening price of one lot in the pool, `raise / GRAD_LOTS`, as an exact ratio. */
  readonly openPricePerLot: { readonly numerator: bigint; readonly denominator: bigint };
  /** Opening price per lot, floored to sompi. */
  readonly openPricePerLotFloor: bigint;
  /** `(open - last) / last` in basis points, floored toward zero; negative when the pool opens below the last lot. */
  readonly premiumBps: bigint;
  /** The fee on the smallest completing buy. */
  readonly finalLotFee: bigint;
}

/** The graduation figures of `preset`; throws `ParameterError` for an invalid preset or a free (zero-price) last lot. */
export function graduationEconomics(preset: LaunchPreset): GraduationEconomics {
  validatePreset(preset);
  const raise = fullRaise(preset.curve);
  const last = lastLotPrice(preset.curve);
  const reserveTokens = mul(preset.gradLots, preset.lotSize, 'GRAD_RESERVE');
  const lastTimesLots = mul(last, preset.gradLots, 'last * GRAD_LOTS');
  // The covenant accepts p0 = k = 0 (a free curve); its premium over a zero last price is undefined.
  if (lastTimesLots === 0n) throw new ParameterError('the last lot is free (p0 = k = 0): no graduation premium is defined');
  const premiumBps = ((raise - lastTimesLots) * BPS_DENOMINATOR) / lastTimesLots;
  return {
    raise,
    lastLotPrice: last,
    reserveTokens,
    openPricePerLot: { numerator: raise, denominator: preset.gradLots },
    openPricePerLotFloor: raise / preset.gradLots,
    premiumBps,
    finalLotFee: finalLotFee(preset.curve),
  };
}

/**
 * The launch factory's gate: covenant caps, supply consistency, and
 * the final-tranche-fee rule (`MIN_FINAL_LOT_FEE`). Throws ParameterError on the first violation.
 */
export function checkFactoryParams(preset: LaunchPreset): void {
  validatePreset(preset);
  const f = finalTrancheFee(preset);
  if (f < MIN_FINAL_LOT_FEE) {
    throw new ParameterError(
      `final-tranche fee ${f} sompi (the final ${FINAL_FEE_TOKENS} tokens) is below the ${MIN_FINAL_LOT_FEE} sompi (0.1 KAS) minimum`,
    );
  }
}

/** The final-tranche fee, in sompi: the fee on the final `FINAL_FEE_TOKENS` tokens (at least one lot) bought in one buy. */
export function finalTrancheFee(preset: LaunchPreset): bigint {
  validatePreset(preset);
  const lots = FINAL_FEE_TOKENS / preset.lotSize;
  return finalLotsFee(preset.curve, lots < 1n ? 1n : lots > preset.curve.curveLots ? preset.curve.curveLots : lots);
}

/** A fee payout split between the treasury and the creator, in sompi. */
export interface FeeSplit {
  /** The treasury's part, rounded down. */
  readonly treasury: bigint;
  /** The creator's part: the remainder. */
  readonly creator: bigint;
}

/**
 * `treasury = floor(amount * pct / 100)`, creator takes the remainder (the
 * covenant's sweep rule). Computed from the quotient and remainder
 * of `amount / 100`, `q * pct + floor(r * pct / 100)`, so `amount * pct` is
 * never formed: for 50 % this equals the curve's `total / 2`.
 */
export function feeSplit(amount: bigint, treasurySharePct: bigint): FeeSplit {
  assertBigint(amount, 'amount');
  assertBigint(treasurySharePct, 'treasurySharePct');
  if (amount < 0n) throw new ParameterError(`amount must be non-negative, got ${amount}`);
  if (treasurySharePct < 0n || treasurySharePct > 100n) throw new ParameterError(`treasurySharePct ${treasurySharePct} is outside [0, 100]`);
  const q = amount / 100n;
  const r = amount % 100n;
  const treasury = mul(q, treasurySharePct, 'q * pct') + (r * treasurySharePct) / 100n;
  return { treasury, creator: amount - treasury };
}

/** The curve fee split (curve `sweep` and `graduate`): 50/50. */
export function curveFeeSplit(amount: bigint, version: FeeModelVersion): FeeSplit {
  const pct = CURVE_TREASURY_SHARE_PCT[version];
  if (pct === undefined) throw new ParameterError(`unknown fee model version ${String(version)}`);
  return feeSplit(amount, pct);
}


/** A creator's earnings rates, in basis points. */
export interface CreatorEarnings {
  /** The creator's share of every curve trade, in basis points of the trade's KAS (Standard: 50 = 0.5 %). */
  readonly curveBps: bigint;
  /** The creator's share of every pool trade, in basis points of its KAS leg (5 = 0.05 %). */
  readonly poolBps: bigint;
}

/**
 * What a launch's creator earns, from the preset's constants: the curve fee
 * times the creator's share of the split, and the pool's creator share.
 * Throws if the curve share is not a whole number of basis points.
 */
export function creatorEarnings(preset: LaunchPreset, version: FeeModelVersion = 'v2'): CreatorEarnings {
  validatePreset(preset);
  const scaled = preset.curve.feeBps * (100n - preset.treasurySharePct);
  if (scaled % 100n !== 0n) throw new ParameterError(`the creator's curve share ${scaled}/100 bps is not a whole number of basis points`);
  if (CURVE_TREASURY_SHARE_PCT[version] === undefined) throw new ParameterError(`unknown fee model version ${String(version)}`);
  return { curveBps: scaled / 100n, poolBps: POOL_CREATOR_FEE_BPS_V2 };
}

/** Whether `sweep` may run: fees at or above the threshold and the curve still open. */
export function canSweep(preset: LaunchPreset, lotsSold: bigint, feeAccrued: bigint): boolean {
  validatePreset(preset);
  assertBigint(lotsSold, 'lotsSold');
  assertBigint(feeAccrued, 'feeAccrued');
  if (lotsSold < 0n || lotsSold > preset.curve.curveLots) throw new ParameterError(`lotsSold ${lotsSold} is outside [0, ${preset.curve.curveLots}]`);
  if (feeAccrued < 0n) throw new ParameterError(`feeAccrued must be non-negative, got ${feeAccrued}`);
  return lotsSold < preset.curve.curveLots && feeAccrued >= preset.sweepMinSompi;
}

/** How `graduate` distributes the accrued fees and what the pool opens with; amounts in sompi. */
export interface GraduationPayout extends FeeSplit {
  /** The remainder folded into the pool's KAS reserve when it is below the payout minimum. */
  readonly pooled: bigint;
  /**
   * `curveValue - feeAccrued + pooled`: the pool cell's opening value, in sompi.
   * Any sompi amount: the pool opens with `kasScaled = floor(escrow / 1e6)`
   * and carries `escrow % 1e6` as dust (`openPool`), which its first `sweep`
   * pays to the treasury. Neither the curve's genesis value nor the folded
   * fees are multiples of 1e6 in general.
   */
  readonly escrow: bigint;
}

/**
 * Pay the split (`preset.treasurySharePct`) only when the
 * remainder is at least 1 KAS; otherwise leave it in the pool. `curveValue` is the curve cell's
 * value at graduation, which holds the raise plus the accrued fees. The
 * sold-out supply cell's KAS is not part of `curveValue`: `graduate`
 * recovers it into the pool-owned reserve cell, not into the escrow.
 */
export function graduationPayout(preset: LaunchPreset, curveValue: bigint, feeAccrued: bigint): GraduationPayout {
  validatePreset(preset);
  assertBigint(curveValue, 'curveValue');
  assertBigint(feeAccrued, 'feeAccrued');
  if (feeAccrued < 0n) throw new ParameterError(`feeAccrued must be non-negative, got ${feeAccrued}`);
  if (curveValue < feeAccrued) throw new ParameterError(`curve value ${curveValue} is below the accrued fees ${feeAccrued}`);
  const base = sub(curveValue, feeAccrued, 'curveValue - feeAccrued');
  if (feeAccrued >= GRADUATION_PAYOUT_MIN) {
    return { ...feeSplit(feeAccrued, preset.treasurySharePct), pooled: 0n, escrow: base };
  }
  return { treasury: 0n, creator: 0n, pooled: feeAccrued, escrow: curveValue };
}
