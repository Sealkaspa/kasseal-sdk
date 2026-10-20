/**
 * Lot rounding for 1,000-token lots (v1): every conversion from what the user
 * typed (KAS to spend, tokens to sell) to whole lots rounds in the user's favour, never up:
 *
 *   buy   `lotsForKas`: the most lots whose cost plus the curve fee fits the KAS given (floor); the leftover stays in
 *         the wallet. Bounded by the lots left and, inside the opening window, by `openWindowMaxLots`.
 *   sell  `lotsForTokens`: whole lots of a token amount (floor); a partial lot is not sold.
 *         `minSellLots`: the smallest sell the curve accepts at a depth (net refund >= 0.1 KAS, `PAYOUT_MIN`).
 *   pool  `poolLegForKas`: the KAS leg of a pool buy in 0.01 KAS units (floor).
 *
 * Quotes are curve-math's (`buyQuote`, `sellQuote`), which the covenant's arithmetic mirrors exactly; these helpers only
 * search over them, so a quote shown is the quote the curve will charge.
 */

import { CURVE_PAYOUT_MIN, KAS_SCALE, buyQuote, sellQuote } from '@kasseal/curve-math';
import type { CurveTemplate } from './program.ts';
import { launchPresetOf } from './shapes/create.ts';

/** The most lots one buy may take at `lotsSold`: the lots left, and the opening window's cap while it lasts. */
export function maxBuyLots(curve: CurveTemplate, lotsSold: bigint): bigint {
  const p = curve.params;
  if (lotsSold < 0n || lotsSold > p.curveLots) throw new Error(`lotsSold ${lotsSold} is outside [0, ${p.curveLots}]`);
  const left = p.curveLots - lotsSold;
  return lotsSold < p.openWindowLots && p.openWindowMaxLots < left ? p.openWindowMaxLots : left;
}

/**
 * The most whole lots `budgetSompi` buys at `lotsSold` (cost plus the curve fee, never above the budget), within
 * `maxBuyLots`; 0 when not even one lot fits. The network fee and the new cell's deposit are not part of the budget.
 */
export function lotsForKas(curve: CurveTemplate, lotsSold: bigint, budgetSompi: bigint): bigint {
  if (budgetSompi <= 0n) return 0n;
  const hi0 = maxBuyLots(curve, lotsSold);
  if (hi0 <= 0n) return 0n;
  const params = launchPresetOf(curve).curve;
  const fits = (n: bigint): boolean => buyQuote(params, lotsSold, n).total <= budgetSompi;
  if (!fits(1n)) return 0n;
  let lo = 1n;
  let hi = hi0;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (fits(mid)) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/** A buy of what `budgetSompi` affords: the lots, the tokens, the curve's charge and the leftover that stays in the wallet. */
export function buyForKas(curve: CurveTemplate, lotsSold: bigint, budgetSompi: bigint): { lots: bigint; tokens: bigint; total: bigint; leftover: bigint } {
  const lots = lotsForKas(curve, lotsSold, budgetSompi);
  const total = lots === 0n ? 0n : buyQuote(launchPresetOf(curve).curve, lotsSold, lots).total;
  return { lots, tokens: lots * curve.params.lot, total, leftover: budgetSompi - total };
}

/** Whole lots of a token amount (floor): the part of a sell the curve can take; the remainder stays with the holder. */
export function lotsForTokens(curve: CurveTemplate, tokens: bigint): bigint {
  if (tokens < 0n) throw new Error('tokens must be non-negative');
  return tokens / curve.params.lot;
}

/**
 * The smallest sell the curve accepts at `lotsSold`: the fewest lots whose net refund (refund minus the curve fee) is at
 * least `PAYOUT_MIN` (0.1 KAS); undefined when even selling every sold lot nets less. The net refund never falls as the
 * lot count grows (the fee is at most 2 % and rounds up by under one sompi per sompi of refund), so a binary search finds
 * it.
 */
export function minSellLots(curve: CurveTemplate, lotsSold: bigint): bigint | undefined {
  if (lotsSold <= 0n) return undefined;
  const params = launchPresetOf(curve).curve;
  const net = (n: bigint): bigint => {
    try {
      return sellQuote(params, lotsSold, n).total;
    } catch {
      return -1n; // below PAYOUT_MIN
    }
  };
  if (net(lotsSold) < CURVE_PAYOUT_MIN) return undefined;
  let lo = 1n;
  let hi = lotsSold;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (net(mid) >= CURVE_PAYOUT_MIN) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/** The KAS leg of a pool buy for `budgetSompi`, in 0.01 KAS units, rounded down (the remainder stays in the wallet). */
export function poolLegForKas(budgetSompi: bigint): bigint {
  return budgetSompi <= 0n ? 0n : budgetSompi / KAS_SCALE;
}
