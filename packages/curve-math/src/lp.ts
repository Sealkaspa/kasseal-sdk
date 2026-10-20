/**
 * Liquidity positions: the v1 pool's `addLiquidity` and `removeLiquidity`
 * arithmetic. KAS amounts here are in scaled units of 0.01 KAS unless a name
 * says sompi; token amounts and shares are whole units.
 *
 * Shares are a fixed denomination. The pool opens at graduation with
 * `lpShares = LOCKED_SHARES` (1e6) against the whole curve escrow; those
 * shares have no cell and no spend path. Deposits issue shares out of a
 * pool-owned inventory cell of a second KCC-20 lineage L (supply `LP_SUPPLY =
 * SHARES_MAX - LOCKED_SHARES`), withdrawals return them, so
 *
 *   inventory + (lpShares - LOCKED_SHARES) == LP_SUPPLY
 *
 * on every add/remove, and `lpShares` can never fall below the floor.
 *
 * Both legs of a deposit round UP (against the depositor), both legs of a
 * withdrawal round DOWN (against the withdrawer):
 *
 *   deposit   dKas = ceil(shares * kasScaled / S)     dTok = ceil(shares * tokenReserve / S)
 *   withdraw  dKas = floor(shares * kasScaled / S)    dTok = floor(shares * tokenReserve / S)
 *
 * so value per share never decreases through add/remove (`kas' * S >= kas *
 * S'`, `tok' * S >= tok * S'`) and an immediate round trip
 * never returns more than it put in. `feeAccruedScaled` and the dust are
 * untouched by both entries; the pool's dust rule and the cell
 * value formula `(kasScaled + feeAccruedScaled) * 1e6 + dust` are unchanged.
 *
 * Every product the covenant forms is bounded by `SHARES_MAX * TOKEN_RESERVE_MAX
 * = 1.2e18`, inside the KCC-1 int range with 7.6x headroom; the
 * covenant's intermediates are computed through the checked int64 helpers.
 * The UI helpers (`sharesForKas`, `sharesForTokens`, `maxDepositShares`,
 * `minDepositShares`, `permanentlyWithdrawableShares`) form products the covenant never does and use plain
 * bigint arithmetic; they only return share counts whose deposit or
 * withdrawal the covenant will accept.
 *
 * `shareValueGrowth` is the one floating-point figure here: a display of
 * past share appreciation from fees, never a forecast.
 */

import {
  ArgumentError, LpFloorError, LpInvariantError, LpInventoryError, LpPayoutTooSmallError, LpReserveCapError,
  LpShareCountError, LpSharesCapError, LpStateError, LpTokenLegTooSmallError,
} from './errors.ts';
import { add, assertBigint, ceilDiv, floorDiv, mul, sub } from './int64.ts';
import {
  LP_SHARES_GENESIS, POOL_KAS_SCALED_MAX, POOL_KAS_VALUE_MAX, POOL_PAYOUT_MIN_SCALED, POOL_SWEEP_MIN_SCALED, POOL_TOKEN_RESERVE_MAX, type BuyResult, type PlatformRounding, type PoolLimits,
  type PoolState, type SellResult, type SweepResult,
  openPool, swapKasForTokens, swapTokensForKas, sweepPool, validatePool,
} from './pool.ts';
import { SOMPI_PER_KAS } from './presets.ts';

// ---- constants -------------------------------------------------------------------------------

/** The graduation position: shares that exist only as a counter and a floor, never as a cell. */
export const LOCKED_SHARES = LP_SHARES_GENESIS;
/** `lpShares` can never exceed this; the deposit cap of a contract set. */
export const SHARES_MAX = 1_000_000_000n;
/** Genesis supply of the LP lineage L: every share a deposit can ever issue. */
export const LP_SUPPLY = SHARES_MAX - LOCKED_SHARES;
/** `pool.sil` PAYOUT_MIN: the smallest KAS leg of a withdrawal, 0.1 KAS in scaled units; the sell floor too. */
export const LP_PAYOUT_MIN_SCALED = POOL_PAYOUT_MIN_SCALED;
/** Builder rule: a deposit's KAS leg is at least 1 KAS (100 scaled units). */
export const MIN_DEPOSIT_KAS_SCALED = 100n;
/** Builder rule: a deposit's KAS leg is also at least this many shares' worth of KAS. */
export const MIN_DEPOSIT_SHARE_MULTIPLE = 20n;
/** KAS (sompi) the builder funds a new LP cell with by default, taken from the absorbed token cell. */
export const LP_CELL_KAS_DEFAULT = 5n * SOMPI_PER_KAS;
/** The least KAS (sompi) an LP cell may carry. */
export const LP_CELL_KAS_MIN = (5n * SOMPI_PER_KAS) / 2n;

// ---- limits (capped, v1 uncapped) ----------------------------------------------------------

/**
 * Which pool program the arithmetic mirrors: `'capped'` the pools with a price ceiling (kasScaled and the accrual each at most
 * KAS_SCALED_MAX, every product a checked int64), `'uncapped'` the v1 pool (kasScaled + accrual at most KAS_VALUE_MAX; the program splits or compares the share products in two limbs,
 * so this mirror forms them exactly in bigint). Results are the same integers either way.
 */
export type { PoolLimits };

function prod(a: bigint, b: bigint, what: string, limits: PoolLimits): bigint {
  return limits === 'capped' ? mul(a, b, what) : a * b;
}

/** The largest kasScaled a state may hold next to `feeAccruedScaled` under `limits`. */
function kasMax(feeAccruedScaled: bigint, limits: PoolLimits): bigint {
  return limits === 'capped' ? POOL_KAS_SCALED_MAX : POOL_KAS_VALUE_MAX - feeAccruedScaled;
}

// ---- state -----------------------------------------------------------------------------------

/** The pool state fields the arithmetic reads: the swap fields plus the share count `S`. */
export interface LpPoolState extends PoolState {
  /** Total shares `S = LOCKED_SHARES + issued`, `LOCKED_SHARES <= S <= SHARES_MAX`. */
  readonly lpShares: bigint;
}

/** `requireWellFormed` of the pool: the swap checks, the share range and the reserve caps. */
export function validateLpPool(pool: LpPoolState, limits: PoolLimits = 'capped'): void {
  if (pool === null || typeof pool !== 'object') throw new LpStateError('pool must be an object');
  for (const key of ['kasScaled', 'tokenReserve', 'feeAccruedScaled'] as const) assertBigint(pool[key], key);
  assertBigint(pool.lpShares, 'lpShares');
  if (pool.lpShares < LOCKED_SHARES) throw new LpStateError(`lpShares ${pool.lpShares} is below the locked floor ${LOCKED_SHARES}`);
  if (pool.lpShares > SHARES_MAX) throw new LpStateError(`lpShares ${pool.lpShares} exceeds SHARES_MAX ${SHARES_MAX}`);
  if (limits === 'capped') {
    if (pool.kasScaled > POOL_KAS_SCALED_MAX) throw new LpStateError(`kasScaled ${pool.kasScaled} exceeds KAS_SCALED_MAX ${POOL_KAS_SCALED_MAX}`);
    if (pool.feeAccruedScaled > POOL_KAS_SCALED_MAX) throw new LpStateError(`feeAccruedScaled ${pool.feeAccruedScaled} exceeds KAS_SCALED_MAX ${POOL_KAS_SCALED_MAX}`);
  } else if (pool.kasScaled + pool.feeAccruedScaled > POOL_KAS_VALUE_MAX) {
    throw new LpStateError(`kasScaled + feeAccruedScaled = ${pool.kasScaled + pool.feeAccruedScaled} exceeds KAS_VALUE_MAX ${POOL_KAS_VALUE_MAX}`);
  }
  if (pool.tokenReserve > POOL_TOKEN_RESERVE_MAX) throw new LpStateError(`tokenReserve ${pool.tokenReserve} exceeds TOKEN_RESERVE_MAX ${POOL_TOKEN_RESERVE_MAX}`);
  validatePool(pool);
}

/** Pool genesis: `openPool` with `lpShares = LOCKED_SHARES` (the curve's `graduate` rule). */
export function openLpPool(escrowSompi: bigint, tokenReserve: bigint, limits: PoolLimits = 'capped'): LpPoolState {
  const pool: LpPoolState = { ...openPool(escrowSompi, tokenReserve), lpShares: LOCKED_SHARES };
  validateLpPool(pool, limits);
  return pool;
}

/** Shares in user hands: `lpShares - LOCKED_SHARES`. */
export function lpIssued(pool: LpPoolState, limits: PoolLimits = 'capped'): bigint {
  validateLpPool(pool, limits);
  return pool.lpShares - LOCKED_SHARES;
}

/** The amount the pool-owned L cell must hold: `LP_SUPPLY - (lpShares - LOCKED_SHARES)`. */
export function lpInventory(pool: LpPoolState, limits: PoolLimits = 'capped'): bigint {
  return LP_SUPPLY - lpIssued(pool, limits);
}

/** The inventory invariant as the covenant checks it on every add/remove: throws when the L cell's amount disagrees. */
export function checkLpInventory(pool: LpPoolState, inventoryAmount: bigint, limits: PoolLimits = 'capped'): void {
  assertBigint(inventoryAmount, 'inventoryAmount');
  const expected = lpInventory(pool, limits);
  if (inventoryAmount !== expected) {
    throw new LpInventoryError(`L inventory ${inventoryAmount} != LP_SUPPLY - issued = ${expected} (lpShares ${pool.lpShares})`);
  }
}

// ---- entrypoints -----------------------------------------------------------------------------

/** The result of `lpDeposit`. */
export interface LpDepositResult {
  /** KAS the depositor pays, scaled (multiples of 0.01 KAS), `ceil(shares * kasScaled / S)`. */
  readonly dKasScaled: bigint;
  /** Tokens the depositor pays, `ceil(shares * tokenReserve / S)`. */
  readonly dTok: bigint;
  /** The pool after the deposit. */
  readonly pool: LpPoolState;
}

/** The result of `lpWithdraw`. */
export interface LpWithdrawResult {
  /** KAS paid out, scaled, `floor(shares * kasScaled / S)`, at least `LP_PAYOUT_MIN_SCALED`. */
  readonly dKasScaled: bigint;
  /** Tokens paid out, `floor(shares * tokenReserve / S)`, at least 1. */
  readonly dTok: bigint;
  /** The pool after the withdrawal. */
  readonly pool: LpPoolState;
}

/** `kas' * S >= kas * S'` and `tok' * S >= tok * S'`: value per share does not decrease. */
function requireValuePerShareNonDecreasing(before: LpPoolState, after: LpPoolState, limits: PoolLimits): void {
  const kasAfter = prod(after.kasScaled, before.lpShares, "kas' * S", limits);
  const kasBefore = prod(before.kasScaled, after.lpShares, "kas * S'", limits);
  if (kasAfter < kasBefore) throw new LpInvariantError(`KAS value per share would decrease: ${kasAfter} < ${kasBefore}`);
  const tokAfter = mul(after.tokenReserve, before.lpShares, "tok' * S");
  const tokBefore = mul(before.tokenReserve, after.lpShares, "tok * S'");
  if (tokAfter < tokBefore) throw new LpInvariantError(`token value per share would decrease: ${tokAfter} < ${tokBefore}`);
}

function assertShares(shares: bigint): void {
  assertBigint(shares, 'shares');
  if (shares < 1n) throw new LpShareCountError(`shares must be at least 1, got ${shares}`);
}

/**
 * `addLiquidity(shares)`: the depositor names a share count and pays both
 * legs rounded up. Requires `1 <= shares`, (v1) a KAS leg above `PAYOUT_MIN`, `S + shares <= SHARES_MAX`, the
 * reserve caps on the successor, and (defensively) that value per share does
 * not decrease. `feeAccruedScaled` and the dust are carried unchanged.
 */
export function lpDeposit(shares: bigint, pool: LpPoolState, limits: PoolLimits = 'capped'): LpDepositResult {
  validateLpPool(pool, limits);
  assertShares(shares);
  const sharesNext = add(pool.lpShares, shares, 'S + shares');
  if (sharesNext > SHARES_MAX) throw new LpSharesCapError(`S + shares = ${sharesNext} exceeds SHARES_MAX ${SHARES_MAX}`);
  const dKasScaled = ceilDiv(prod(shares, pool.kasScaled, 'shares * kasScaled', limits), pool.lpShares);
  const dTok = ceilDiv(mul(shares, pool.tokenReserve, 'shares * tokenReserve'), pool.lpShares);
  // The v1 pool's minimum deposit: the KAS leg is above PAYOUT_MIN, so a new position is
  // withdrawable at once. The capped arithmetic has no such rule.
  if (limits === 'uncapped' && dKasScaled <= LP_PAYOUT_MIN_SCALED) {
    throw new LpPayoutTooSmallError(`KAS leg ${dKasScaled} (scaled) is not above PAYOUT_MIN ${LP_PAYOUT_MIN_SCALED} (the v1 minimum deposit)`);
  }
  const kasNext = add(pool.kasScaled, dKasScaled, 'kas + dKas');
  const kasCap = kasMax(pool.feeAccruedScaled, limits);
  if (kasNext > kasCap) throw new LpReserveCapError(`kasScaled would be ${kasNext}, above ${limits === 'capped' ? 'KAS_SCALED_MAX' : 'KAS_VALUE_MAX - accrual'} ${kasCap}`);
  const tokNext = add(pool.tokenReserve, dTok, 'tok + dTok');
  if (tokNext > POOL_TOKEN_RESERVE_MAX) throw new LpReserveCapError(`tokenReserve would be ${tokNext}, above TOKEN_RESERVE_MAX ${POOL_TOKEN_RESERVE_MAX}`);
  const next: LpPoolState = {
    kasScaled: kasNext,
    tokenReserve: tokNext,
    lpShares: sharesNext,
    feeAccruedScaled: pool.feeAccruedScaled,
    dust: pool.dust,
  };
  requireValuePerShareNonDecreasing(pool, next, limits);
  validateLpPool(next, limits);
  return { dKasScaled, dTok, pool: next };
}

/**
 * `removeLiquidity(shares)`: pro rata, both legs rounded down. Requires
 * `1 <= shares <= S - LOCKED_SHARES` (the floor), `dKas >= PAYOUT_MIN`,
 * `dTok >= 1`, both reserves positive afterwards and (defensively) that value
 * per share does not decrease. `feeAccruedScaled` and the dust are carried
 * unchanged.
 */
export function lpWithdraw(shares: bigint, pool: LpPoolState, limits: PoolLimits = 'capped'): LpWithdrawResult {
  validateLpPool(pool, limits);
  assertShares(shares);
  const issued = pool.lpShares - LOCKED_SHARES;
  if (shares > issued) throw new LpFloorError(`shares ${shares} exceeds the issued ${issued}: the locked ${LOCKED_SHARES} cannot be withdrawn`);
  const dKasScaled = floorDiv(prod(shares, pool.kasScaled, 'shares * kasScaled', limits), pool.lpShares);
  if (dKasScaled < LP_PAYOUT_MIN_SCALED) {
    throw new LpPayoutTooSmallError(`KAS leg ${dKasScaled} (scaled) is below PAYOUT_MIN ${LP_PAYOUT_MIN_SCALED} (0.1 KAS)`);
  }
  const dTok = floorDiv(mul(shares, pool.tokenReserve, 'shares * tokenReserve'), pool.lpShares);
  if (dTok < 1n) throw new LpTokenLegTooSmallError(`${shares} shares release no whole token at this depth`);
  const kasNext = sub(pool.kasScaled, dKasScaled, 'kas - dKas');
  if (kasNext <= 0n) throw new LpInvariantError(`KAS reserve would be ${kasNext}`);
  const tokNext = sub(pool.tokenReserve, dTok, 'tok - dTok');
  if (tokNext <= 0n) throw new LpInvariantError(`token reserve would be ${tokNext}`);
  const next: LpPoolState = {
    kasScaled: kasNext,
    tokenReserve: tokNext,
    lpShares: sub(pool.lpShares, shares, 'S - shares'),
    feeAccruedScaled: pool.feeAccruedScaled,
    dust: pool.dust,
  };
  requireValuePerShareNonDecreasing(pool, next, limits);
  validateLpPool(next, limits);
  return { dKasScaled, dTok, pool: next };
}

// ---- the entries that carry lpShares unchanged -------------------------------------------

/** `BuyResult` with the share count carried. */
export interface LpBuyResult extends Omit<BuyResult, 'pool'> { readonly pool: LpPoolState; }
/** `SellResult` with the share count carried. */
export interface LpSellResult extends Omit<SellResult, 'pool'> { readonly pool: LpPoolState; }
/** `SweepResult` with the share count carried. */
export interface LpSweepResult extends Omit<SweepResult, 'pool'> { readonly pool: LpPoolState; }

/** `swapKasForTokens`: the swap arithmetic; `lpShares` is carried unchanged. */
export function lpSwapKasForTokens(pool: LpPoolState, kasInScaled: bigint, limits: PoolLimits = 'capped', rounding: PlatformRounding = 'floor'): LpBuyResult {
  validateLpPool(pool, limits);
  const r = swapKasForTokens(pool, kasInScaled, limits, rounding);
  const next: LpPoolState = { ...r.pool, lpShares: pool.lpShares };
  validateLpPool(next, limits);
  return { ...r, pool: next };
}

/** `swapTokensForKas`: the swap arithmetic; `lpShares` is carried unchanged. */
export function lpSwapTokensForKas(pool: LpPoolState, tokenIn: bigint, limits: PoolLimits = 'capped', rounding: PlatformRounding = 'floor'): LpSellResult {
  validateLpPool(pool, limits);
  const r = swapTokensForKas(pool, tokenIn, limits, rounding);
  const next: LpPoolState = { ...r.pool, lpShares: pool.lpShares };
  validateLpPool(next, limits);
  return { ...r, pool: next };
}

/** `sweep`: the payout (accrual plus dust); `lpShares` is carried unchanged. */
export function lpSweepPool(pool: LpPoolState, sweepMinScaled: bigint = POOL_SWEEP_MIN_SCALED, limits: PoolLimits = 'capped'): LpSweepResult {
  validateLpPool(pool, limits);
  const r = sweepPool(pool, sweepMinScaled);
  return { ...r, pool: { ...r.pool, lpShares: pool.lpShares } };
}

// ---- UI and builder helpers ----------------------------------------------------------------

function min(first: bigint, ...rest: readonly bigint[]): bigint {
  let m = first;
  for (const v of rest) if (v < m) m = v;
  return m;
}

/**
 * The largest share count `lpDeposit` accepts on this state: bounded by
 * `SHARES_MAX` and by both reserve caps. 0 when nothing can be deposited.
 */
export function maxDepositShares(pool: LpPoolState, limits: PoolLimits = 'capped'): bigint {
  validateLpPool(pool, limits);
  const S = pool.lpShares;
  // ceil(n * kas / S) <= KAS_MAX - kas  <=>  n <= floor((KAS_MAX - kas) * S / kas); likewise for tokens.
  const byShares = SHARES_MAX - S;
  const byKas = ((kasMax(pool.feeAccruedScaled, limits) - pool.kasScaled) * S) / pool.kasScaled;
  const byTok = ((POOL_TOKEN_RESERVE_MAX - pool.tokenReserve) * S) / pool.tokenReserve;
  return min(byShares, byKas, byTok);
}

/**
 * The largest share count whose deposit's KAS leg fits `kasScaledBudget`
 * (scaled units) and that the covenant accepts. 0 when the budget buys no
 * share. The token leg is not considered; combine with `sharesForTokens`.
 */
export function sharesForKas(kasScaledBudget: bigint, pool: LpPoolState, limits: PoolLimits = 'capped'): bigint {
  validateLpPool(pool, limits);
  assertBigint(kasScaledBudget, 'kasScaledBudget');
  if (kasScaledBudget < 0n) throw new ArgumentError(`kasScaledBudget must be non-negative, got ${kasScaledBudget}`);
  // ceil(n * kas / S) <= B  <=>  n * kas <= B * S  <=>  n <= floor(B * S / kas).
  const byBudget = (kasScaledBudget * pool.lpShares) / pool.kasScaled;
  return min(byBudget, maxDepositShares(pool, limits));
}

/**
 * The largest share count whose deposit's token leg fits `tokBudget` and that
 * the covenant accepts. 0 when the budget buys no share. The KAS leg is not
 * considered; combine with `sharesForKas`.
 */
export function sharesForTokens(tokBudget: bigint, pool: LpPoolState, limits: PoolLimits = 'capped'): bigint {
  validateLpPool(pool, limits);
  assertBigint(tokBudget, 'tokBudget');
  if (tokBudget < 0n) throw new ArgumentError(`tokBudget must be non-negative, got ${tokBudget}`);
  const byBudget = (tokBudget * pool.lpShares) / pool.tokenReserve;
  return min(byBudget, maxDepositShares(pool, limits));
}

/**
 * The smallest share count `lpWithdraw` pays out on this state: both
 * `floor(shares * kasScaled / S) >= PAYOUT_MIN` and `floor(shares *
 * tokenReserve / S) >= 1`: 1 share on Standard, 3 on Set A at
 * graduation. May exceed the issued count on a pool nobody has deposited
 * into; compare with `lpIssued` before offering a withdrawal.
 */
export function minWithdrawableShares(pool: LpPoolState, limits: PoolLimits = 'capped'): bigint {
  validateLpPool(pool, limits);
  // floor(s * kas / S) >= M  <=>  s * kas >= M * S  <=>  s >= ceil(M * S / kas).
  const byKas = ceilDiv(LP_PAYOUT_MIN_SCALED * pool.lpShares, pool.kasScaled);
  const byTok = ceilDiv(pool.lpShares, pool.tokenReserve);
  const m = byKas > byTok ? byKas : byTok;
  return m < 1n ? 1n : m;
}

/**
 * An upper bound of every KAS that will ever exist, in scaled units (0.01 KAS): 29,000,000,000 KAS, above the total
 * supply of about 28.7 billion. No pool can hold more, so on the uncapped pools (v1) it bounds `kas / S` for the
 * withdrawability floor instead of the cell-value bound KAS_VALUE_MAX (90 billion KAS), which no pool can reach
 * (this lowers the minimum deposit on a Standard pool from about 225 KAS to about 73 KAS).
 */
export const KAS_SUPPLY_BOUND_SCALED = 2_900_000_000_000n;

/**
 * The smallest position (in shares) that stays withdrawable on every state this pool can
 * still reach, whatever the price does later.
 *
 * `Q = kasScaled * tokenReserve / S^2` never decreases: swaps keep `S` and do
 * not lower `kas * tok` (the covenant's invariant check), `addLiquidity` and
 * `removeLiquidity` do not lower the value per share on either leg (also
 * checked), sweeps change none of the three. And on every state `tok / S <=
 * TOKEN_RESERVE_MAX / LOCKED_SHARES` (1,200) and `kas / S <= KAS_SCALED_MAX /
 * LOCKED_SHARES` (1,000; uncapped pools: `KAS_SUPPLY_BOUND_SCALED / LOCKED_SHARES`, as no pool holds more KAS than
 * exists). So on any later state `kas' / S' = Q' * S' / tok' >=
 * Q / 1,200` and `tok' / S' >= Q / 1,000`, and `n` shares pay `floor(n * kas'
 * / S') >= PAYOUT_MIN` and `floor(n * tok' / S') >= 1` whenever
 *
 *   n >= ceil(PAYOUT_MIN * 1,200 / Q)   and   n >= ceil(1,000 / Q).
 *
 * At graduation this is 1 share on Standard, 7 on Set A and 179 on the tiny
 * testnet preset; it grows only after the price has risen far above its
 * graduation level. A state with a much lower KAS reserve at the same token
 * reserve lowers `kas * tok` and so cannot be reached by the pool.
 */
export function permanentlyWithdrawableShares(pool: LpPoolState, limits: PoolLimits = 'capped'): bigint {
  validateLpPool(pool, limits);
  const S2 = pool.lpShares * pool.lpShares;
  const kt = pool.kasScaled * pool.tokenReserve;
  // n * kas * tok * LOCKED >= M * TOKEN_MAX * S^2  and  n * kas * tok * LOCKED >= KAS_MAX * S^2 (plain bigint: a UI bound).
  const byKas = ceilDiv(LP_PAYOUT_MIN_SCALED * POOL_TOKEN_RESERVE_MAX * S2, kt * LOCKED_SHARES);
  // The largest kas / S any reachable state can have: KAS_SCALED_MAX / LOCKED (capped), or (uncapped) the KAS supply
  // bound / LOCKED: no pool holds more KAS than exists, well under KAS_VALUE_MAX.
  const byTok = ceilDiv((limits === 'capped' ? POOL_KAS_SCALED_MAX : KAS_SUPPLY_BOUND_SCALED) * S2, kt * LOCKED_SHARES);
  const m = byKas > byTok ? byKas : byTok;
  return m < 1n ? 1n : m;
}

/**
 * Builder rule, in scaled KAS: a deposit's KAS leg is at least
 * `max(1 KAS, 20 * kasScaled / S)` (the value of 20 shares, rounded up), and
 * at least the leg of `permanentlyWithdrawableShares`, so the position
 * stays withdrawable on every state the pool can reach. Builder policy, not a
 * covenant check.
 */
export function minDepositKasScaled(pool: LpPoolState, limits: PoolLimits = 'capped'): bigint {
  validateLpPool(pool, limits);
  const twentyShares = ceilDiv(MIN_DEPOSIT_SHARE_MULTIPLE * pool.kasScaled, pool.lpShares);
  const permanent = ceilDiv(permanentlyWithdrawableShares(pool, limits) * pool.kasScaled, pool.lpShares);
  let m = MIN_DEPOSIT_KAS_SCALED;
  if (twentyShares > m) m = twentyShares;
  if (permanent > m) m = permanent;
  return m;
}

/**
 * The smallest share count the builder accepts for a deposit: the least `n`
 * with `ceil(n * kasScaled / S) >= minDepositKasScaled`, and at least
 * `permanentlyWithdrawableShares`. May exceed `maxDepositShares` on a pool at
 * its caps, in which case no deposit meets the rule.
 */
export function minDepositShares(pool: LpPoolState, limits: PoolLimits = 'capped'): bigint {
  const M = minDepositKasScaled(pool, limits);
  // ceil(n * kas / S) >= M  <=>  n * kas > (M - 1) * S  <=>  n >= floor((M - 1) * S / kas) + 1.
  const byKas = ((M - 1n) * pool.lpShares) / pool.kasScaled + 1n;
  const permanent = permanentlyWithdrawableShares(pool, limits);
  return byKas > permanent ? byKas : permanent;
}

/**
 * Whether withdrawing `shares` of a `held` share position would leave a
 * remainder that may stop being withdrawable later (`0 < held - shares <
 * permanentlyWithdrawableShares`). Withdrawing everything never does. A
 * remainder at or above the threshold stays withdrawable on every reachable
 * state; one below it can still be recovered later by merging it with more
 * shares (a plain KCC-20 transfer; the builder's exact-cell plan does it).
 */
export function withdrawalLeavesSmallPosition(held: bigint, shares: bigint, pool: LpPoolState, limits: PoolLimits = 'capped'): boolean {
  assertBigint(held, 'held');
  assertBigint(shares, 'shares');
  if (shares < 0n || shares > held) throw new ArgumentError(`shares ${shares} is outside [0, ${held}]`);
  const rest = held - shares;
  return rest > 0n && rest < permanentlyWithdrawableShares(pool, limits);
}

/** What a position of `shares` is worth now (`positionValue`). */
export interface PositionValue {
  /** KAS a withdrawal of these shares would pay now, scaled, `floor(shares * kasScaled / S)`. */
  readonly kasScaled: bigint;
  /** Tokens a withdrawal would pay now, `floor(shares * tokenReserve / S)`. */
  readonly tok: bigint;
  /** Whether `lpWithdraw(shares)` would be accepted now: `shares >= 1`, `kasScaled >= PAYOUT_MIN`, `tok >= 1`. */
  readonly withdrawable: boolean;
}

/**
 * What `removeLiquidity(shares)` would return against this state: the
 * floored legs. `shares` may be 0 (an empty position) and at most the issued
 * count. Does not check the payout floors; `withdrawable` reports them.
 */
export function positionValue(shares: bigint, pool: LpPoolState, limits: PoolLimits = 'capped'): PositionValue {
  validateLpPool(pool, limits);
  assertBigint(shares, 'shares');
  if (shares < 0n) throw new ArgumentError(`shares must be non-negative, got ${shares}`);
  const issued = pool.lpShares - LOCKED_SHARES;
  if (shares > issued) throw new LpFloorError(`shares ${shares} exceeds the issued ${issued}`);
  const kasScaled = floorDiv(prod(shares, pool.kasScaled, 'shares * kasScaled', limits), pool.lpShares);
  const tok = floorDiv(mul(shares, pool.tokenReserve, 'shares * tokenReserve'), pool.lpShares);
  return { kasScaled, tok, withdrawable: shares >= 1n && kasScaled >= LP_PAYOUT_MIN_SCALED && tok >= 1n };
}

/** `k = kasScaled * tokenReserve` of a state, for `shareValueGrowth` (inside the script range under the caps). */
export function lpInvariant(pool: LpPoolState, limits: PoolLimits = 'capped'): bigint {
  validateLpPool(pool, limits);
  return prod(pool.kasScaled, pool.tokenReserve, 'kasScaled * tokenReserve', limits);
}

/**
 * Share value growth from retained fees over a window (the Uniswap v2
 * whitepaper's sec 2.4 measure):
 *
 *   sqrt(kNow / kRef) * (sRef / sNow) - 1
 *
 * `k = kasScaled * tokenReserve` and `S = lpShares` at the window's start
 * (`kRef`, `sRef`) and now. Swaps raise `k` with `S` fixed; add/remove change
 * both and leave the ratio `sqrt(k) / S` non-decreasing, so the figure
 * isolates what fees (and depositors' rounding) added to a share. It is a
 * statement about the past window only. It is not a rate, not annualised and
 * not a forecast; a position's KAS value also moves with the pair's price
 * (divergence loss), which this figure does not include. Floating point: the
 * one non-integer result in this package.
 */
export function shareValueGrowth(kRef: bigint, sRef: bigint, kNow: bigint, sNow: bigint): number {
  for (const [what, v] of [['kRef', kRef], ['sRef', sRef], ['kNow', kNow], ['sNow', sNow]] as const) {
    assertBigint(v, what);
    if (v <= 0n) throw new ArgumentError(`${what} must be positive, got ${v}`);
  }
  return Math.sqrt(Number(kNow) / Number(kRef)) * (Number(sRef) / Number(sNow)) - 1;
}
