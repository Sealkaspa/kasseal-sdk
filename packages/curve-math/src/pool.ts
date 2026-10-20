/**
 * The constant-product pool a token graduates into.
 *
 * The KAS reserve is stored scaled by 1e6 (`kasScaled = floor(value / 1e6)`,
 * every KAS leg is a multiple of 0.01 KAS), which keeps `kasScaled *
 * tokenReserve` six orders of magnitude inside the int range and lets the
 * covenant check `kas' * tok' >= kas * tok` directly, with no swap-delta
 * reformulation and no trade-size cap.
 *
 * Dust: the graduation escrow is an arbitrary sompi amount (the curve's fees
 * are ceiling-rounded), so the pool cell's value is `(kasScaled +
 * feeAccruedScaled) * 1e6 + dust` with `0 <= dust < 1e6`. Swaps move value in
 * exact multiples of 1e6 and carry the dust unchanged; `sweepPool` pays it to
 * the treasury together with the accrual, after which the dust is 0.
 *
 * Fee: 30 bps as a haircut on the user's KAS leg -- the KAS paid in on a
 * buy, the KAS paid out on a sell -- of which 20 bps stay in the reserves
 * and 10 bps accrue (`feeAccruedScaled`). Every division rounds against the
 * user, so the product never decreases. The sweep pays the accrual half to
 * the treasury and half to the creator named in the pool state, 5 bps of the
 * leg each (`poolSweepSplit`).
 *
 * Acceptance domain: the swaps accept
 * exactly what `pool.sil` `swapTokensForKas` / `swapKasForTokens` accept with
 * `minOutScaled = 0` (identical in every pool build): the state caps of
 * `requireWellFormed`, the leg caps, a successor inside the caps and a sell's
 * net payout of at least `PAYOUT_MIN` (`POOL_PAYOUT_MIN_SCALED`, 0.1 KAS).
 */

import { ArgumentError, PoolError, PoolPayoutTooSmallError } from './errors.ts';
import { INT_MAX, add, assertBigint, floorDiv, mul, sub } from './int64.ts';
import { BPS_DENOMINATOR } from './curve.ts';
import type { FeeModelVersion } from './graduation.ts';

/** Sompi per scaled KAS unit: the pool stores KAS in units of 0.01 KAS (1e6 sompi). */
export const KAS_SCALE = 1_000_000n;
/** The pool's total swap fee, in basis points of the user's KAS leg (0.3 %). */
export const POOL_FEE_BPS = 30n;
/** The part of the swap fee that stays in the reserves (0.2 %). */
export const POOL_RESERVE_FEE_BPS = 20n;
/** The part of the swap fee that accrues for the sweep (0.1 %). */
export const POOL_PLATFORM_FEE_BPS = 10n;
/** Fee model `'v2'`: the creator's part of the accrued 10 bps, paid by the sweep (half of it). */
export const POOL_CREATOR_FEE_BPS_V2 = 5n;
/** `lpShares` at genesis (the v1 pool's LOCKED_SHARES floor). */
export const LP_SHARES_GENESIS = 1_000_000n;
/** `pool.sil` SWEEP_MIN: 10 KAS in scaled units. */
export const POOL_SWEEP_MIN_SCALED = 1_000n;
/**
 * The KAS_SCALED_MAX of earlier pool programs: 10,000,000 KAS in scaled units, a cap on
 * `kasScaled`, `feeAccruedScaled` and a KAS leg. The v1 pool has no reserve cap: see `POOL_KAS_VALUE_MAX` and
 * `POOL_KAS_IN_MAX`.
 */
export const POOL_KAS_SCALED_MAX = 1_000_000_000n;
/** `pool.sil` KAS_VALUE_MAX: `kasScaled + feeAccruedScaled` at most 9e12 scaled (90,000,000,000 KAS), the cell value's bound. */
export const POOL_KAS_VALUE_MAX = 9_000_000_000_000n;
/** `pool.sil` KAS_IN_MAX: one buy's KAS leg at most 7e9 scaled (70,000,000 KAS). */
export const POOL_KAS_IN_MAX = 7_000_000_000n;
/** `pool.sil` TOKEN_RESERVE_MAX: the largest supply the factory mints; caps `tokenReserve` and a token leg. */
export const POOL_TOKEN_RESERVE_MAX = 1_200_000_000n;
/** `pool.sil` PAYOUT_MIN: the smallest net KAS a sell (and a withdrawal) pays, 0.1 KAS in scaled units. */
export const POOL_PAYOUT_MIN_SCALED = 10n;

/** A pool cell's reserves, as the pool covenant stores them. */
export interface PoolState {
  /** The KAS reserve in scaled units (0.01 KAS). */
  readonly kasScaled: bigint;
  /** The token reserve, whole tokens. */
  readonly tokenReserve: bigint;
  /** Fees accrued for the next sweep, scaled units (0.01 KAS). */
  readonly feeAccruedScaled: bigint;
  /** Sompi below one scaled unit held in the cell, `0 <= dust < KAS_SCALE`; not part of the invariant. */
  readonly dust: bigint;
}

/** `sompi / 1e6`; the leg must be a non-negative multiple of 0.01 KAS. */
export function toKasScaled(sompi: bigint): bigint {
  assertBigint(sompi, 'sompi');
  if (sompi < 0n) throw new PoolError(`KAS leg must be non-negative, got ${sompi}`);
  if (sompi % KAS_SCALE !== 0n) throw new PoolError(`KAS leg ${sompi} sompi is not a multiple of ${KAS_SCALE} (0.01 KAS)`);
  return sompi / KAS_SCALE;
}

/** Scaled units (0.01 KAS) to sompi: `kasScaled * 1e6`. */
export function fromKasScaled(kasScaled: bigint): bigint {
  assertBigint(kasScaled, 'kasScaled');
  if (kasScaled < 0n) throw new PoolError(`kasScaled must be non-negative, got ${kasScaled}`);
  return mul(kasScaled, KAS_SCALE, 'kasScaled * 1e6');
}

/** Throw `PoolError` unless `pool` is a well-formed pool state the covenant would accept. */
export function validatePool(pool: PoolState): void {
  if (pool === null || typeof pool !== 'object') throw new PoolError('pool must be an object');
  for (const key of ['kasScaled', 'tokenReserve', 'feeAccruedScaled', 'dust'] as const) {
    assertBigint(pool[key], key);
    if (pool[key] < 0n) throw new PoolError(`${key} must be non-negative, got ${pool[key]}`);
  }
  if (pool.kasScaled === 0n || pool.tokenReserve === 0n) throw new PoolError('pool reserves must both be positive');
  if (pool.kasScaled + pool.feeAccruedScaled > POOL_KAS_VALUE_MAX) {
    throw new PoolError(`kasScaled + feeAccruedScaled ${pool.kasScaled + pool.feeAccruedScaled} exceeds KAS_VALUE_MAX ${POOL_KAS_VALUE_MAX}`);
  }
  if (pool.tokenReserve > POOL_TOKEN_RESERVE_MAX) throw new PoolError(`tokenReserve ${pool.tokenReserve} exceeds TOKEN_RESERVE_MAX ${POOL_TOKEN_RESERVE_MAX}`);
  if (pool.dust >= KAS_SCALE) throw new PoolError(`dust ${pool.dust} is not below ${KAS_SCALE}`);
  invariant(pool);
}

/** The pool cell's value in sompi: `(kasScaled + feeAccruedScaled) * 1e6 + dust`, as `pool.sil` enforces it. */
export function poolCellValue(pool: PoolState): bigint {
  validatePool(pool);
  return add(mul(add(pool.kasScaled, pool.feeAccruedScaled, 'kas + accrued'), KAS_SCALE, '(kas + accrued) * 1e6'), pool.dust, 'value + dust');
}

/**
 * `k = kasScaled * tokenReserve`, exact. The pool compares it as two 62-bit limbs (`mulGe`), so it may exceed the
 * script integer range here.
 */
export function invariant(pool: PoolState): bigint {
  return pool.kasScaled * pool.tokenReserve;
}

/**
 * Pool genesis from the graduation escrow (sompi) and the reserve tokens:
 * `kasScaled = floor(escrow / 1e6)`, `dust = escrow % 1e6` (the curve's
 * `graduate` rule; the pool cell's value is the whole escrow).
 */
export function openPool(escrowSompi: bigint, tokenReserve: bigint): PoolState {
  assertBigint(escrowSompi, 'escrowSompi');
  if (escrowSompi < 0n) throw new PoolError(`escrow must be non-negative, got ${escrowSompi}`);
  const pool = { kasScaled: escrowSompi / KAS_SCALE, tokenReserve, feeAccruedScaled: 0n, dust: escrowSompi % KAS_SCALE };
  validatePool(pool);
  return pool;
}

/** The result of `sweepPool`. */
export interface SweepResult {
  /** The pool after the sweep. */
  readonly pool: PoolState;
  /** Sompi paid to the treasury: `feeAccruedScaled * 1e6 + dust`. */
  readonly payout: bigint;
}

/**
 * Platform sweep (`pool.sil` `sweep`): pays the accrual and the dust carried
 * since graduation to the treasury; the continuation holds exactly
 * `kasScaled * 1e6`. `sweepMinScaled` is the pool's threshold (1,000 = 10 KAS).
 */
export function sweepPool(pool: PoolState, sweepMinScaled: bigint = POOL_SWEEP_MIN_SCALED): SweepResult {
  validatePool(pool);
  assertBigint(sweepMinScaled, 'sweepMinScaled');
  if (pool.feeAccruedScaled < sweepMinScaled) throw new PoolError(`accrual ${pool.feeAccruedScaled} is below the sweep threshold ${sweepMinScaled}`);
  const payout = add(fromKasScaled(pool.feeAccruedScaled), pool.dust, 'accrued * 1e6 + dust');
  return { pool: { ...pool, feeAccruedScaled: 0n, dust: 0n }, payout };
}

/** How a pool sweep's payout is split, in sompi. */
export interface PoolSweepSplit {
  /** Sompi to the treasury: `floor(payout / 2)`. */
  readonly treasury: bigint;
  /** Sompi to the creator named in the pool state: `payout - floor(payout / 2)`. */
  readonly creator: bigint;
}

/** How a pool sweep's payout (`sweepPool(...).payout`) is paid out in a contract set. */
export function poolSweepSplit(payout: bigint, version: FeeModelVersion): PoolSweepSplit {
  assertBigint(payout, 'payout');
  if (payout < 0n) throw new PoolError(`payout must be non-negative, got ${payout}`);
  if (version === 'v2') {
    const treasury = payout / 2n;
    return { treasury, creator: payout - treasury };
  }
  throw new PoolError(`unknown fee model version ${String(version)}`);
}

/** A swap's fee, in scaled KAS units (0.01 KAS). */
export interface PoolFee {
  /** Total haircut on the user's KAS leg (>= 30 bps, rounded against the user). */
  readonly total: bigint;
  /** The part left in the reserves. */
  readonly reserve: bigint;
  /** The part accrued to the platform. */
  readonly platform: bigint;
}

/** The result of `swapKasForTokens`. */
export interface BuyResult {
  /** The pool after the swap. */
  readonly pool: PoolState;
  /** Whole tokens the buyer receives. */
  readonly tokenOut: bigint;
  /** KAS fee, scaled. */
  readonly fee: PoolFee;
}

/** The result of `swapTokensForKas`. */
export interface SellResult {
  /** The pool after the swap. */
  readonly pool: PoolState;
  /** KAS the seller receives, scaled. */
  readonly kasOutScaled: bigint;
  /** KAS fee, scaled. */
  readonly fee: PoolFee;
}

/**
 * How a pool program rounds the platform share of a swap's KAS leg (its `feeSplit`). `floor`: earlier v1 pool
 * builds. `nearest`: the current v1 pool builds: `floor((leg * 10 + 5000) / 10000)`, half up. The total fee and so every quote (tokens out, KAS out) are the
 * same under both; only the split between the reserve and the accrual differs.
 */
export type PlatformRounding = 'floor' | 'nearest';

function haircut(grossScaled: bigint, rounding: PlatformRounding = 'floor'): { net: bigint; fee: PoolFee } {
  const net = floorDiv(mul(grossScaled, BPS_DENOMINATOR - POOL_FEE_BPS, 'gross * (10000 - 30)'), BPS_DENOMINATOR);
  const scaled = mul(grossScaled, POOL_PLATFORM_FEE_BPS, 'gross * 10');
  const platform = floorDiv(rounding === 'nearest' ? scaled + BPS_DENOMINATOR / 2n : scaled, BPS_DENOMINATOR);
  const total = grossScaled - net;
  return { net, fee: { total, reserve: total - platform, platform } };
}

/**
 * Which pool program's limits a swap follows. `uncapped`: the v1 pool: no reserve cap, one buy's leg at most KAS_IN_MAX, every product exact. `capped`:
 * every pool build before it (none is recognised any more): KAS_SCALED_MAX caps the leg, and a product outside the
 * script integer range refuses the swap (the program's own OpMul failure).
 */
export type PoolLimits = 'uncapped' | 'capped';

function assertNonDecreasing(before: PoolState, after: PoolState, limits: PoolLimits): void {
  const k0 = limits === 'capped' ? mul(before.kasScaled, before.tokenReserve, 'kasScaled * tokenReserve') : invariant(before);
  const k1 = limits === 'capped' ? mul(after.kasScaled, after.tokenReserve, "kasScaled' * tokenReserve'") : invariant(after);
  if (k1 < k0) throw new PoolError(`invariant violated: ${k1} < ${k0}`);
}

/** KAS -> token. `kasInScaled` is the user's gross KAS leg, scaled, at most `KAS_IN_MAX`. */
export function swapKasForTokens(pool: PoolState, kasInScaled: bigint, limits: PoolLimits = 'uncapped', rounding: PlatformRounding = 'floor'): BuyResult {
  validatePool(pool);
  assertBigint(kasInScaled, 'kasInScaled');
  if (kasInScaled <= 0n) throw new ArgumentError(`kasInScaled must be positive, got ${kasInScaled}`);
  if (limits === 'capped' && kasInScaled > POOL_KAS_SCALED_MAX) throw new PoolError(`KAS leg ${kasInScaled} (scaled) exceeds KAS_SCALED_MAX ${POOL_KAS_SCALED_MAX}`);
  if (limits === 'uncapped' && kasInScaled > POOL_KAS_IN_MAX) throw new PoolError(`KAS leg ${kasInScaled} (scaled) exceeds KAS_IN_MAX ${POOL_KAS_IN_MAX}`);
  const { net, fee } = haircut(kasInScaled, rounding);
  // tokenOut = floor(tok * net / (kas + net)): rounds against the user.
  const denominator = add(pool.kasScaled, net, 'kas + net');
  const tokenOut = floorDiv(mul(pool.tokenReserve, net, 'tok * net'), denominator);
  if (tokenOut <= 0n) throw new PoolError(`${kasInScaled} scaled KAS buys no whole token at this depth`);
  const next: PoolState = {
    kasScaled: sub(add(pool.kasScaled, kasInScaled, 'kas + in'), fee.platform, 'kas + in - platform'),
    tokenReserve: sub(pool.tokenReserve, tokenOut, 'tok - out'),
    feeAccruedScaled: add(pool.feeAccruedScaled, fee.platform, 'accrued + platform'),
    dust: pool.dust,
  };
  validatePool(next);
  assertNonDecreasing(pool, next, limits);
  return { pool: next, tokenOut, fee };
}

/**
 * token -> KAS. The haircut applies to the gross KAS the trade would release.
 * Throws `PoolPayoutTooSmallError` when the net payout is below `PAYOUT_MIN`
 * (10 scaled units, 0.1 KAS): the covenant refuses that sell.
 */
export function swapTokensForKas(pool: PoolState, tokenIn: bigint, limits: PoolLimits = 'uncapped', rounding: PlatformRounding = 'floor'): SellResult {
  validatePool(pool);
  assertBigint(tokenIn, 'tokenIn');
  if (tokenIn <= 0n) throw new ArgumentError(`tokenIn must be positive, got ${tokenIn}`);
  if (tokenIn > POOL_TOKEN_RESERVE_MAX) throw new PoolError(`token leg ${tokenIn} exceeds TOKEN_RESERVE_MAX ${POOL_TOKEN_RESERVE_MAX}`);
  // gross = floor(kas * tokenIn / (tok + tokenIn)): rounds against the user. Exact; the pool forms it as
  // q * tokenIn + (r * tokenIn) / D, which is the same integer.
  const denominator = add(pool.tokenReserve, tokenIn, 'tok + in');
  const gross = limits === 'capped' ? floorDiv(mul(pool.kasScaled, tokenIn, 'kas * in'), denominator) : (pool.kasScaled * tokenIn) / denominator;
  const { net, fee } = haircut(gross, rounding);
  if (net <= 0n) throw new PoolPayoutTooSmallError(`${tokenIn} tokens release no scaled KAS at this depth`);
  if (net < POOL_PAYOUT_MIN_SCALED) {
    throw new PoolPayoutTooSmallError(`net payout ${net} scaled is below the pool's 0.1 KAS minimum (PAYOUT_MIN ${POOL_PAYOUT_MIN_SCALED})`);
  }
  const next: PoolState = {
    kasScaled: sub(sub(pool.kasScaled, net, 'kas - net'), fee.platform, 'kas - net - platform'),
    tokenReserve: denominator,
    feeAccruedScaled: add(pool.feeAccruedScaled, fee.platform, 'accrued + platform'),
    dust: pool.dust,
  };
  validatePool(next);
  assertNonDecreasing(pool, next, limits);
  return { pool: next, kasOutScaled: net, fee };
}

/** Marginal price of one lot in sompi, floored: `kasScaled * 1e6 * lotSize / tokenReserve`. */
export function spotPricePerLot(pool: PoolState, lotSize: bigint): bigint {
  validatePool(pool);
  assertBigint(lotSize, 'lotSize');
  if (lotSize <= 0n) throw new ArgumentError(`lotSize must be positive, got ${lotSize}`);
  const kasSompi = fromKasScaled(pool.kasScaled);
  // kasSompi * lotSize can exceed the int range for extreme pools; the covenant never forms this product.
  const numerator = kasSompi * lotSize;
  if (numerator > INT_MAX * pool.tokenReserve) throw new PoolError('spot price is not representable');
  return numerator / pool.tokenReserve;
}
