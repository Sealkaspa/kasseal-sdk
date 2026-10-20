/**
 * Typed failures. Every function in this package is total: invalid input
 * raises one of these, and no function returns NaN, undefined or a silently
 * clamped value.
 */

/** Base class of every error this package throws; `name` is the concrete class name. */
export class CurveMathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** An argument is not a bigint, not an integer, or outside its domain (n <= 0, s0 + n > L, ...). */
export class ArgumentError extends CurveMathError {}

/**
 * A curve sell whose net refund (`cost - fee`) is below the covenant's
 * `PAYOUT_MIN` (0.1 KAS): `curve.sil` `sell` refuses it.
 */
export class SellPayoutTooSmallError extends ArgumentError {}

/** A parameter set violates a covenant cap or a launch-factory rule (for example the minimum final-tranche fee). */
export class ParameterError extends CurveMathError {}

/** An intermediate or result left the KCC-1 int range [-(2^63 - 1), 2^63 - 1]. */
export class OverflowError extends CurveMathError {}

/** A pool operation is not executable: zero output, non-scaled KAS leg, invariant violation. */
export class PoolError extends CurveMathError {}

/**
 * A pool sell whose net KAS payout is below the covenant's `PAYOUT_MIN` (10
 * scaled units, 0.1 KAS): `pool.sil` `swapTokensForKas` refuses it.
 */
export class PoolPayoutTooSmallError extends PoolError {}

/**
 * Liquidity-position failures (the v1 pool). One class per `require` the covenant's `addLiquidity` and
 * `removeLiquidity` can reject on, so a caller can tell the user which rule
 * their request broke without parsing a message.
 */
export class LpError extends CurveMathError {}

/** The pool state is malformed: `lpShares` outside `[LOCKED_SHARES, SHARES_MAX]`, or a reserve above its cap. */
export class LpStateError extends LpError {}

/** `shares < 1`. */
export class LpShareCountError extends LpError {}

/** `addLiquidity`: `lpShares + shares > SHARES_MAX`. */
export class LpSharesCapError extends LpError {}

/** `addLiquidity`: the deposit would push `kasScaled` above `KAS_SCALED_MAX` or `tokenReserve` above `TOKEN_RESERVE_MAX`. */
export class LpReserveCapError extends LpError {}

/** `removeLiquidity`: `shares > lpShares - LOCKED_SHARES`, the graduation floor. */
export class LpFloorError extends LpError {}

/** `removeLiquidity`: the KAS leg `floor(shares * kasScaled / S)` is below `PAYOUT_MIN` (0.1 KAS). */
export class LpPayoutTooSmallError extends LpError {}

/** `removeLiquidity`: the token leg `floor(shares * tokenReserve / S)` is zero. */
export class LpTokenLegTooSmallError extends LpError {}

/**
 * A defensive covenant check failed: value per share would decrease, or a
 * reserve would reach zero. True by construction of the rounding directions;
 * reaching this means the arithmetic above it is wrong.
 */
export class LpInvariantError extends LpError {}

/** The pool-owned L cell's amount is not `LP_SUPPLY - (lpShares - LOCKED_SHARES)`. */
export class LpInventoryError extends LpError {}
