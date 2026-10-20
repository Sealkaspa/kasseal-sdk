/**
 * Slippage bounds: the most a buyer pays and the least a seller receives, from the quote and the tolerance the
 * user chose. On the curve the bound is a builder pre-check (`maxKasIn`, `minKasOut`; the curve takes no slippage
 * argument), so it is the only thing between a moved price and a signed trade; on the pool it is also the on-chain
 * minimum (`minOut`).
 *
 * Every helper refuses rather than clamps. A tolerance that is negative, not finite, finer than one basis point, or
 * above `MAX_SLIPPAGE_BPS` throws `SlippageOutOfRange`, and so does a negative amount. The rounding never widens the
 * bound: the slippage amount is `floor(total * bps / 10^4)`, so
 *
 *   maxWithSlippage(total, bps) * 10^4 <= total * (10^4 + bps)     (never more paid than approved)
 *   minWithSlippage(total, bps) * 10^4 >= total * (10^4 - bps)     (never less received than approved)
 *
 * and `0 <= minWithSlippage(total, bps) <= total <= maxWithSlippage(total, bps)`.
 */

/** The widest tolerance the helpers accept: 10 %, the maximum of the trade and liquidity sliders. */
export const MAX_SLIPPAGE_BPS = 1_000;

const BPS = 10_000n;

/** A slippage tolerance or an amount outside what the helpers accept; nothing was computed. */
export class SlippageOutOfRange extends Error {
  /** The refused value. */
  readonly value: number | bigint;
  constructor(value: number | bigint, detail: string) {
    super(`slippage: ${String(value)} ${detail}`);
    this.name = 'SlippageOutOfRange';
    this.value = value;
  }
}

/** Throws `SlippageOutOfRange` unless `bps` is an integer in `[0, MAX_SLIPPAGE_BPS]`. */
export function assertSlippageBps(bps: number): void {
  if (typeof bps !== 'number' || !Number.isInteger(bps)) throw new SlippageOutOfRange(bps, 'bps is not an integer');
  if (bps < 0) throw new SlippageOutOfRange(bps, 'bps is negative');
  if (bps > MAX_SLIPPAGE_BPS) throw new SlippageOutOfRange(bps, `bps is above the ${MAX_SLIPPAGE_BPS} bps maximum`);
}

/**
 * A percentage as the sliders send it (`2` for 2 %, `0.5` for 0.5 %) in whole basis points. Refuses a value that is
 * not finite, negative, above `MAX_SLIPPAGE_BPS`, or finer than 0.01 % (rounding it either way would change what the
 * user chose).
 */
export function slippageBpsOfPercent(pct: number): number {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) throw new SlippageOutOfRange(pct, '% is not a finite number');
  if (pct < 0) throw new SlippageOutOfRange(pct, '% is negative');
  const scaled = pct * 100;
  const bps = Math.round(scaled);
  if (Math.abs(scaled - bps) > 1e-6) throw new SlippageOutOfRange(pct, '% is finer than one basis point');
  assertSlippageBps(bps);
  return bps;
}

function assertAmount(total: bigint): void {
  if (typeof total !== 'bigint') throw new SlippageOutOfRange(Number(total), 'amount is not a bigint');
  if (total < 0n) throw new SlippageOutOfRange(total, 'amount is negative');
}

/** Buy side: `total + floor(total * bps / 10^4)`, the most the user pays. */
export function maxWithSlippage(total: bigint, bps: number): bigint {
  assertAmount(total);
  assertSlippageBps(bps);
  return total + (total * BigInt(bps)) / BPS;
}

/** Sell side: `total - floor(total * bps / 10^4)`, the least the user receives. */
export function minWithSlippage(total: bigint, bps: number): bigint {
  assertAmount(total);
  assertSlippageBps(bps);
  return total - (total * BigInt(bps)) / BPS;
}

/** `maxWithSlippage` from a slider percentage. */
export function maxWithSlippagePct(total: bigint, pct: number): bigint {
  return maxWithSlippage(total, slippageBpsOfPercent(pct));
}

/** `minWithSlippage` from a slider percentage. */
export function minWithSlippagePct(total: bigint, pct: number): bigint {
  return minWithSlippage(total, slippageBpsOfPercent(pct));
}
