/**
 * The bonding curve, priced per lot (one lot is 1,000 tokens on the current contracts).
 *
 *   price(i)    = P0 + K * i                       0 <= i < CURVE_LOTS
 *   cost(s0, n) = n * P0 + K * (n * s0 + n * (n - 1) / 2)
 *   fee         = ceil(cost * FEE_BPS / 10_000)
 *
 * `n * (n - 1)` is always even, so the only division in the price function
 * is exact; the fee is the single rounding point and always rounds up.
 * Selling `n` lots at `s0` lots sold refunds `cost(s0 - n, n)`: the same
 * lots at the same prices, so a round trip loses exactly the two fees.
 *
 * Acceptance domain: the functions here accept
 * exactly the parameter sets and trades the curve covenant's `buy` and `sell`
 * accept (`requireParams`, `requireLotRange`, `PAYOUT_MIN`; identical in
 * the curve) and form only the products the covenant forms.
 * The fee is computed as the covenant's `feeOf` does it, from the quotient and
 * remainder of `cost / 10_000`, so `cost * feeBps` is never formed. Not
 * modelled here: the opening window (a constructor pair the transaction builder
 * checks) and `init`'s escrow bound (`initEscrowFits`).
 */

import { ArgumentError, ParameterError, SellPayoutTooSmallError } from './errors.ts';
import { add, assertBigint, mul, sub } from './int64.ts';

/** The four pricing constants of a curve contract. All amounts are in sompi (1 KAS = 100,000,000 sompi). */
export interface CurveParams {
  /** Price of lot 0, in sompi. */
  readonly p0: bigint;
  /** Price increment per lot, in sompi. */
  readonly k: bigint;
  /** Fee in basis points of the trade cost, on both buys and sells. */
  readonly feeBps: bigint;
  /** Number of lots sold on the curve. */
  readonly curveLots: bigint;
}

/** Basis points per whole: fees are `feeBps / 10_000` of the trade cost. */
export const BPS_DENOMINATOR = 10_000n;
/** `curve.sil` FEE_BPS_MAX: the covenant-enforced fee cap (2 %). */
export const FEE_BPS_MAX = 200n;
/** `curve.sil` P0_MAX: `0 <= P0 <= 1e12` sompi (10,000 KAS). */
export const P0_MAX = 1_000_000_000_000n;
/** `curve.sil` K_MAX: `0 <= K <= 1e10` sompi per lot for curves of at most `CURVE_LOTS_COARSE` lots. */
export const K_MAX = 10_000_000_000n;
/** The K cap of the 8,000-lot curve (100,000-token lots). */
export const K_MAX_8000_LOTS = K_MAX;
/**
 * `curve.sil` K_MAX_FINE: `0 <= K <= 1e6` sompi per lot for curves of more than
 * `CURVE_LOTS_COARSE` lots, so that `K * L * (L - 1) / 2 <= 3.2e17` at L = 800,000 (the same bound as 1e10 at 8,000).
 */
export const K_MAX_FINE = 1_000_000n;
/** The largest lot count the coarse K cap applies to: 8,000 lots of 100,000 tokens. */
export const CURVE_LOTS_COARSE = 8_000n;
/** The lot count of every v1 preset: 800,000 lots of 1,000 tokens. */
export const CURVE_LOTS_DEFAULT = 800_000n;
/**
 * `curve.sil` CURVE_LOTS_MAX: every entry refuses a curve of more lots.
 */
export const CURVE_LOTS_MAX = 800_000n;
/** `curve.sil` PAYOUT_MIN: a sell's net refund (`refund - fee`) is at least 0.1 KAS. */
export const CURVE_PAYOUT_MIN = 10_000_000n;
/**
 * `curve.sil` GRAD_FEE_MIN, the folded fee remainder `init`'s escrow bound allows for: 1 KAS on v1.
 */
export const INIT_GRAD_FEE_MIN = 100_000_000n;
/** `curve.sil` POOL_ESCROW_MAX: the largest escrow graduation can hand the pool, 1e7 KAS. */
export const POOL_ESCROW_MAX = 1_000_000_000_000_000n;

/** The K cap that applies to a lot count: `K_MAX` for 1 .. `CURVE_LOTS_COARSE` lots, `K_MAX_FINE` above, up to `CURVE_LOTS_MAX`. */
export function kCap(curveLots: bigint): bigint {
  assertBigint(curveLots, 'curveLots');
  if (curveLots <= 0n) throw new ParameterError(`curveLots must be positive, got ${curveLots}`);
  if (curveLots <= CURVE_LOTS_COARSE) return K_MAX;
  if (curveLots <= CURVE_LOTS_MAX) return K_MAX_FINE;
  throw new ParameterError(`curveLots ${curveLots} exceeds the covenant's maximum ${CURVE_LOTS_MAX}`);
}

/**
 * The covenant's `requireParams` for the four pricing constants: `0 <= p0 <=
 * P0_MAX`, `0 <= k <= K_MAX`, `0 < curveLots <= CURVE_LOTS_MAX`, `0 <= feeBps
 * <= FEE_BPS_MAX`, with the K cap of the lot count (`kCap`). Inside these caps no
 * expression of `buy`, `sell` or this module leaves the int range (`cost(0, L)
 * <= 8e5 * 1e12 + 3.2e17 = 1.12e18` at the fine-tier corner, `3.3e17` on the coarse
 * tier; `curve.sil`'s overflow budget). The factory's own rules (presets, the final-lot fee) are
 * `checkFactoryParams`.
 */
export function validateCurveParams(p: CurveParams): void {
  if (p === null || typeof p !== 'object') throw new ParameterError('curve params must be an object');
  for (const key of ['p0', 'k', 'feeBps', 'curveLots'] as const) assertBigint(p[key], key);
  if (p.p0 < 0n) throw new ParameterError(`p0 must be non-negative, got ${p.p0}`);
  if (p.p0 > P0_MAX) throw new ParameterError(`p0 ${p.p0} exceeds the cap ${P0_MAX}`);
  if (p.k < 0n) throw new ParameterError(`k must be non-negative, got ${p.k}`);
  const cap = kCap(p.curveLots);
  if (p.k > cap) throw new ParameterError(`k ${p.k} exceeds the cap ${cap}`);
  if (p.feeBps < 0n) throw new ParameterError(`feeBps must be non-negative, got ${p.feeBps}`);
  if (p.feeBps > FEE_BPS_MAX) throw new ParameterError(`feeBps ${p.feeBps} exceeds the cap ${FEE_BPS_MAX}`);
}

/**
 * `init`'s escrow bound: `cellValue + cost(0, curveLots) + GRAD_FEE_MIN <= 1e15`
 * sompi, so the escrow graduation hands the pool always fits the pool's
 * `kasScaled` cap. `gradFeeMin` is the set's GRAD_FEE_MIN: `INIT_GRAD_FEE_MIN`
 * (1 KAS, the default: v1). A curve whose genesis cell fails it can never be initialised
 * (e.g. a test-only preset with every cap at its maximum); `buy` and `sell` do not re-check it, so
 * the quotes do not either.
 */
export function initEscrowFits(p: CurveParams, cellValue: bigint, gradFeeMin: bigint = INIT_GRAD_FEE_MIN): boolean {
  validateCurveParams(p);
  assertBigint(cellValue, 'cellValue');
  assertBigint(gradFeeMin, 'gradFeeMin');
  if (cellValue < 0n) throw new ArgumentError(`cellValue must be non-negative, got ${cellValue}`);
  if (gradFeeMin !== INIT_GRAD_FEE_MIN) throw new ArgumentError(`gradFeeMin must be the contract set's GRAD_FEE_MIN (1 KAS), got ${gradFeeMin}`);
  const total = add(add(cellValue, costUnchecked(p, 0n, p.curveLots), 'value + cost'), gradFeeMin, 'value + cost + GRAD_FEE_MIN');
  return total <= POOL_ESCROW_MAX;
}

function assertLotIndex(p: CurveParams, i: bigint): void {
  assertBigint(i, 'lot index');
  if (i < 0n || i >= p.curveLots) throw new ArgumentError(`lot index ${i} is outside [0, ${p.curveLots})`);
}

/** price(i) = P0 + K * i. */
export function lotPrice(p: CurveParams, i: bigint): bigint {
  validateCurveParams(p);
  assertLotIndex(p, i);
  return add(p.p0, mul(p.k, i, 'K * i'), 'P0 + K * i');
}

function assertRange(p: CurveParams, s0: bigint, n: bigint): void {
  assertBigint(s0, 's0');
  assertBigint(n, 'n');
  if (s0 < 0n) throw new ArgumentError(`s0 must be non-negative, got ${s0}`);
  if (n < 0n) throw new ArgumentError(`n must be non-negative, got ${n}`);
  if (s0 + n > p.curveLots) throw new ArgumentError(`s0 + n = ${s0 + n} exceeds curveLots ${p.curveLots}`);
}

/** The contract's expression, term by term, each term range-checked. */
function costUnchecked(p: CurveParams, s0: bigint, n: bigint): bigint {
  const nP0 = mul(n, p.p0, 'n * P0');
  const nS0 = mul(n, s0, 'n * s0');
  const tri = mul(n, n - 1n, 'n * (n - 1)') / 2n; // exact: one factor is even
  const inner = add(nS0, tri, 'n * s0 + n * (n - 1) / 2');
  const kTerm = mul(p.k, inner, 'K * (n * s0 + n * (n - 1) / 2)');
  return add(nP0, kTerm, 'cost');
}

/** cost(s0, n): the exact sum of price(s0) .. price(s0 + n - 1). `n = 0` costs 0. */
export function cost(p: CurveParams, s0: bigint, n: bigint): bigint {
  validateCurveParams(p);
  assertRange(p, s0, n);
  return costUnchecked(p, s0, n);
}

/**
 * fee = ceil(cost * feeBps / 10_000), rounding up on both buys and sells,
 * computed as the covenant's `feeOf`: with `cost = q * 10_000 + r`, `q *
 * feeBps + ceil(r * feeBps / 10_000)`. Equal to `ceilDiv(cost * feeBps,
 * 10_000)` without forming that product.
 */
export function fee(costValue: bigint, feeBps: bigint): bigint {
  assertBigint(costValue, 'cost');
  assertBigint(feeBps, 'feeBps');
  if (costValue < 0n) throw new ArgumentError(`cost must be non-negative, got ${costValue}`);
  if (feeBps < 0n || feeBps > FEE_BPS_MAX) throw new ParameterError(`feeBps ${feeBps} is outside [0, ${FEE_BPS_MAX}]`);
  const q = costValue / BPS_DENOMINATOR;
  const r = costValue % BPS_DENOMINATOR;
  return add(mul(q, feeBps, 'q * feeBps'), (r * feeBps + (BPS_DENOMINATOR - 1n)) / BPS_DENOMINATOR, 'fee');
}

/** A curve trade quote, all in sompi. */
export interface Quote {
  /** The curve amount: what the escrow gains (buy) or pays out (sell). */
  readonly cost: bigint;
  /** The trade fee: `ceil(cost * feeBps / 10_000)`. */
  readonly fee: bigint;
  /** Buy: `cost + fee`, what the buyer pays. Sell: `cost - fee`, what the seller receives. */
  readonly total: bigint;
}

/** Buy `n > 0` lots at `s0` lots sold; requires `s0 + n <= curveLots`. */
export function buyQuote(p: CurveParams, s0: bigint, n: bigint): Quote {
  validateCurveParams(p);
  assertRange(p, s0, n);
  if (n === 0n) throw new ArgumentError('a buy must take at least one lot');
  const c = costUnchecked(p, s0, n);
  const f = fee(c, p.feeBps);
  return { cost: c, fee: f, total: add(c, f, 'cost + fee') };
}

/**
 * Sell `n > 0` lots at `s0` lots sold; requires `n <= s0`. Refunds `cost(s0 -
 * n, n)`. Throws `SellPayoutTooSmallError` when the net refund `cost - fee`
 * is below the covenant's `PAYOUT_MIN` (0.1 KAS): the chain refuses that sell.
 */
export function sellQuote(p: CurveParams, s0: bigint, n: bigint): Quote {
  validateCurveParams(p);
  assertBigint(s0, 's0');
  assertBigint(n, 'n');
  if (n <= 0n) throw new ArgumentError('a sell must return at least one lot');
  if (s0 > p.curveLots) throw new ArgumentError(`s0 ${s0} exceeds curveLots ${p.curveLots}`);
  if (n > s0) throw new ArgumentError(`cannot sell ${n} lots when only ${s0} are sold`);
  const c = costUnchecked(p, s0 - n, n);
  const f = fee(c, p.feeBps);
  const total = sub(c, f, 'cost - fee');
  if (total < CURVE_PAYOUT_MIN) {
    throw new SellPayoutTooSmallError(`net refund ${total} is below the contract's 0.1 KAS payout minimum (PAYOUT_MIN ${CURVE_PAYOUT_MIN} sompi)`);
  }
  return { cost: c, fee: f, total };
}

/** cost(0, curveLots): what the curve has raised when it completes. */
export function fullRaise(p: CurveParams): bigint {
  return cost(p, 0n, p.curveLots);
}

/** price(curveLots - 1). */
export function lastLotPrice(p: CurveParams): bigint {
  validateCurveParams(p);
  return lotPrice(p, p.curveLots - 1n);
}

/** The fee on the smallest possible completing buy: one lot at the last price. */
export function finalLotFee(p: CurveParams): bigint {
  return fee(lastLotPrice(p), p.feeBps);
}

/** The fee on the last `n` lots bought in one buy: `fee(cost(L - n, n))`. */
export function finalLotsFee(p: CurveParams, n: bigint): bigint {
  validateCurveParams(p);
  if (n <= 0n || n > p.curveLots) throw new ArgumentError(`n ${n} is outside [1, ${p.curveLots}]`);
  return fee(cost(p, p.curveLots - n, n), p.feeBps);
}
