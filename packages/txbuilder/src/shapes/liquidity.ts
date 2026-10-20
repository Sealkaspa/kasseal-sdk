/**
 * Open liquidity on a bound v1 pool (`pool.sil` `addLiquidity`, `removeLiquidity`). The arithmetic is `@kasseal/curve-math` `lpDeposit` / `lpWithdraw`
 * (deposit legs round up, withdrawal legs round down; accrual and dust untouched); this module places
 * the cells, predicts every successor state and names the signer of each input.
 *
 * addLiquidity(shares, lpUser):
 *   in0   POOL (P)                               addLiquidity(shares, lpUser)
 *   in1   user KCC20 cell of T (T leader)        transfer([mergedT], 00 || sig65)   the wallet signs this P2SH input
 *   in2   pool-owned KCC20 of T (T delegator)    transfer_delegator(empty)
 *   in3   pool-owned KCC20 of L (L leader)       transfer([restL, lpUser], 00)      the inventory
 *   in4.. user KAS (P2PK)                        dKas * 1e6, the LP cell's funding beyond the absorbed T cell, the fee
 *   out0  POOL'    binding (0, P)   value + dKas * 1e6; {kas + dKas, tok + dTok, S + shares, L, accrual, creator}
 *   out1  mergedT  binding (1, T)   owner P, tokenReserve + dTok, value = the reserve cell's
 *   out2  restL    binding (3, L)   owner P, inventory - shares, value = the inventory cell's
 *   out3  lpUser   binding (3, L)   owner = the T cell's key, `shares`, value `lpCellValue` (5 KAS default, 2.5 KAS least)
 *   out4  change
 *
 * removeLiquidity(shares, tokUser):
 *   in0   user KCC20 cell of L (L leader)        transfer([mergedL], 00 || sig65)   the wallet signs this P2SH input
 *   in1   pool-owned KCC20 of L (L delegator)    transfer_delegator(empty)          the inventory
 *   in2   pool-owned KCC20 of T (T leader)       transfer([restT, tokUser], 00)
 *   in3   POOL (P)                               removeLiquidity(shares, tokUser)
 *   [in4.. user KAS, only when the L cell's value plus the KAS leg cannot cover the fee and the payout floor]
 *   out0  mergedL  binding (0, L)   owner P, inventory + shares, value = the inventory cell's
 *   out1  restT    binding (2, T)   owner P, tokenReserve - dTok, value = the reserve cell's
 *   out2  tokUser  binding (2, T)   owner = the L cell's key, dTok, value `tokCellValue` (the absorbed L cell's, at most 5 KAS)
 *   out3  POOL'    binding (3, P)   value - dKas * 1e6; {kas - dKas, tok - dTok, S - shares, ...}
 *   out4  payout   P2PK(user)       dKas * 1e6 + the L cell's value - tokCellValue (+ top-up) - fee
 *
 * Both user cells are absorbed whole: the user's T cell holds exactly `dTok`, the user's L cell
 * exactly `shares`; `select/liquidity.ts` splits or merges first. The pool validates both lineages
 * completely, so the inventory must hold `LP_SUPPLY - (S - LOCKED_SHARES)` and the reserve exactly
 * `tokenReserve` (`requirePoolInventory`, `requirePoolToken`).
 *
 * Refusals (before anything is built): an unbound pool (swap-only until `bindLp`); a deposit without the
 * caller's `lpSafe: true` (the Kasseal API's invariant monitor: `sum of L cells == LP_SUPPLY` and the inventory
 * equation; withdrawals are never gated); a share count outside `lpDeposit` /
 * `lpWithdraw`'s limits; a deposit below `minDepositShares` (at least max(1 KAS, 20 shares' worth),
 * and at least `permanentlyWithdrawableShares`, so the position stays withdrawable on every state the pool
 * can reach); a withdrawal whose KAS leg is below
 * `PAYOUT_MIN` or whose legs miss `minKasOut` / `minTokOut` (the covenant takes no slippage
 * argument on these entries, so a race rejects instead of mis-filling).
 *
 * Rebuilds after a lost singleton race (for example a sandwich): `ratioDrift` compares the quoted
 * reserve ratio with the live one; an automatic rebuild is allowed only below
 * `AUTO_REBUILD_MAX_RATIO_DRIFT` (1 %), otherwise the caller re-quotes and asks the user.
 */

import { poolLimitsOf } from '../cells.ts';
import { hasOpenLiquidity } from '../artifacts.ts';
import type { PoolLimits } from '@kasseal/curve-math';
import { kcc0020Fields, toHex, type TokenState } from '@kasseal/codec';
import {
  LP_CELL_KAS_DEFAULT, LP_CELL_KAS_MIN, LP_PAYOUT_MIN_SCALED, lpDeposit, lpInventory, lpWithdraw, maxDepositShares, minDepositShares, poolCellValue,
  type LpDepositResult, type LpPoolState, type LpWithdrawResult,
} from '@kasseal/curve-math';
import { p2pkScript, type FundingUtxo, type PoolCell, type TokenCell, type TxPlan } from '../assemble.ts';
import {
  budgetsV3Of, changeTo, kasInput, payoutTo, poolInput, poolOutput, tokenDelegatorCovenantInput, tokenLeaderCovenantInput, tokenLeaderSignedInput, tokenOutput, type BuilderContext,
} from '../cells.ts';
import { BUDGETS, SOMPI_PER_KAS, signedLeaderBudget } from '../mass.ts';
import { POOL_KAS_SCALE, covenantOwnedToken, isCovenantOwnedBy, isPoolBound, lpExtensionOf, userToken, type PoolCellState } from '../program.ts';
import { kcc20Full, poolAddLiquiditySigScript, poolRemoveLiquiditySigScript } from '../sigscript.ts';
import {
  DEFAULT_USER_CELL_VALUE, MIN_PAYOUT, MIN_USER_CELL_VALUE, WITNESS_COVENANT, WITNESS_SIGNED, assertAllIn, assertNetOut, checkTokenFamily, feeFields, finish, fundingSum,
  requireLineage, requirePoolOfContext, requirePoolToken, requireUserCell, type FeeOptions, type Shaped, requireOwnLineages,
} from './common.ts';
import { poolMathState } from './swap.ts';

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

/** Input and output indices of `addLiquidity` (see the module comment): the pool input. */
export const ADD_POOL_IN = 0;
/** `addLiquidity`: the depositor's T cell (T leader). */
export const ADD_USER_TOKEN_IN = 1;
/** `addLiquidity`: the pool-owned T reserve cell. */
export const ADD_RESERVE_IN = 2;
/** `addLiquidity`: the pool-owned L inventory cell. */
export const ADD_INVENTORY_IN = 3;
/** `addLiquidity`: the first P2PK funding input. */
export const ADD_FUNDING_IN = 4;
/** `addLiquidity`: the pool continuation. */
export const ADD_POOL_OUT = 0;
/** `addLiquidity`: the merged T reserve. */
export const ADD_MERGED_TOKEN_OUT = 1;
/** `addLiquidity`: the L inventory's rest. */
export const ADD_REST_LP_OUT = 2;
/** `addLiquidity`: the depositor's new LP cell. */
export const ADD_LP_USER_OUT = 3;

/** Input and output indices of `removeLiquidity` (see the module comment): the withdrawer's L cell (L leader). */
export const REMOVE_USER_LP_IN = 0;
/** `removeLiquidity`: the pool-owned L inventory cell. */
export const REMOVE_INVENTORY_IN = 1;
/** `removeLiquidity`: the pool-owned T reserve cell. */
export const REMOVE_RESERVE_IN = 2;
/** `removeLiquidity`: the pool input. */
export const REMOVE_POOL_IN = 3;
/** `removeLiquidity`: the first optional P2PK top-up input. */
export const REMOVE_FUNDING_IN = 4;
/** `removeLiquidity`: the merged L inventory. */
export const REMOVE_MERGED_LP_OUT = 0;
/** `removeLiquidity`: the T reserve's rest. */
export const REMOVE_REST_TOKEN_OUT = 1;
/** `removeLiquidity`: the withdrawer's new token cell. */
export const REMOVE_TOKEN_USER_OUT = 2;
/** `removeLiquidity`: the pool continuation. */
export const REMOVE_POOL_OUT = 3;
/** `removeLiquidity`: the withdrawer's P2PK payout. */
export const REMOVE_PAYOUT_OUT = 4;

/** The value of a new LP cell by default, sompi (5 KAS, funded from the absorbed T cell and the depositor's KAS). */
export const DEFAULT_LP_CELL_VALUE = LP_CELL_KAS_DEFAULT;
/** The least value the builder gives an LP cell, sompi (2.5 KAS). */
export const MIN_LP_CELL_VALUE = LP_CELL_KAS_MIN;

/* -------------------------------------------------------------------------- */
/* Preconditions and quotes                                                    */
/* -------------------------------------------------------------------------- */

/** The curve-math view of an open-liquidity pool cell: the swap fields, the dust and the share count. */
export function lpPoolMathState(pool: PoolCell): LpPoolState {
  return { ...poolMathState(pool), lpShares: pool.state.lpShares };
}

/** Require a pool whose `bindLp` has run; returns L (hex). Unbound pools are swap-only and are refused. */
export function requireBoundPool(pool: PoolCell): string {
  if (pool.state.lpCovId === undefined) throw new Error(`pool ${pool.covenantId} has the 108-byte state: swap-only, no liquidity entries`);
  if (!isPoolBound(pool.state)) throw new Error(`pool ${pool.covenantId} is unbound (lpCovId 0^32): swap-only until bindLp`);
  return toHex(pool.state.lpCovId);
}

/**
 * The pool-owned L inventory cell: of lineage L, owned by P with scheme 0x04, holding exactly
 * `LP_SUPPLY - (lpShares - LOCKED_SHARES)` (the inventory invariant the covenant checks on every add/remove).
 * Returns L (hex).
 */
export function requirePoolInventory(pool: PoolCell, inventory: TokenCell, limits: PoolLimits = 'capped'): string {
  const L = requireBoundPool(pool);
  if (inventory.covenantId !== L) throw new Error(`inventory cell lineage ${inventory.covenantId} is not the pool's L ${L}`);
  if (!isCovenantOwnedBy(inventory.state, pool.covenantId)) throw new Error('inventory cell is not pool-owned');
  const expected = lpInventory(lpPoolMathState(pool), limits);
  if (inventory.state.amount !== expected) throw new Error(`L inventory holds ${inventory.state.amount}, the state implies ${expected} (LP_SUPPLY - issued); the pool is not spendable through add/remove`);
  return L;
}

/**
 * Deposit quote with the builder's share-count rules (the minimum deposit, the covenant's caps); the covenant's own
 * checks run inside `lpDeposit`. `limits`: the pool program's arithmetic (`poolLimitsOf(ctx)`: `'uncapped'` for v1,
 * `'capped'` for earlier pool programs).
 */
export function depositQuote(pool: PoolCell, shares: bigint, limits: PoolLimits = 'capped'): LpDepositResult {
  requireBoundPool(pool);
  const s = lpPoolMathState(pool);
  if (shares < 1n) throw new Error(`shares must be at least 1, got ${shares}`);
  const max = maxDepositShares(s, limits);
  if (shares > max) throw new Error(`${shares} shares exceed the ${max} this pool can still issue (SHARES_MAX or a reserve cap)`);
  const min = minDepositShares(s, limits);
  if (shares < min) throw new Error(`deposit of ${shares} shares is below the minimum of ${min} (at least max(1 KAS, 20 shares' worth of KAS), and enough shares to stay withdrawable whatever the price does later)`);
  return lpDeposit(shares, s, limits);
}

/** Withdrawal quote: the covenant's floor and payout rules (`lpWithdraw`) plus the caller's slippage bounds. */
export function withdrawalQuote(pool: PoolCell, shares: bigint, minKasOutScaled?: bigint, minTokOut?: bigint, limits: PoolLimits = 'capped'): LpWithdrawResult {
  requireBoundPool(pool);
  if (shares < 1n) throw new Error(`shares must be at least 1, got ${shares}`);
  const q = lpWithdraw(shares, lpPoolMathState(pool), limits);
  if (q.dKasScaled < LP_PAYOUT_MIN_SCALED) throw new Error(`KAS leg ${q.dKasScaled} scaled is below the pool's PAYOUT_MIN ${LP_PAYOUT_MIN_SCALED}`);
  if (minKasOutScaled !== undefined && q.dKasScaled < minKasOutScaled) throw new Error(`KAS leg ${q.dKasScaled} scaled is below minKasOut ${minKasOutScaled}`);
  if (minTokOut !== undefined && q.dTok < minTokOut) throw new Error(`token leg ${q.dTok} is below minTokOut ${minTokOut}`);
  return q;
}

const extOf = (c: TokenCell): Uint8Array => kcc0020Fields(c.state).extensionCommitment;

/**
 * On the current v1 builds every cell of L carries P as its extension commitment and the pool refuses an inventory that
 * does not; earlier frozen builds carry 0^32. Refuses an inventory with the wrong one.
 */
export function requireLpCommitment(ctx: Pick<BuilderContext, 'pool'>, pool: PoolCell, inventory: TokenCell): void {
  const want = toHex(lpExtensionOf(ctx.pool, pool.covenantId));
  const got = toHex(extOf(inventory));
  if (got !== want) throw new Error(`L inventory extension commitment ${got} is not the ${want === pool.covenantId ? "pool's id" : '0^32 of this build'} (${want})`);
}

/** `n` sompi as a KAS string with up to eight decimals, for the summaries. */
export function kasString(sompi: bigint): string {
  const neg = sompi < 0n;
  const a = neg ? -sompi : sompi;
  const whole = a / SOMPI_PER_KAS;
  const frac = (a % SOMPI_PER_KAS).toString().padStart(8, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac.length > 0 ? `.${frac}` : ''}`;
}

/* -------------------------------------------------------------------------- */
/* addLiquidity                                                                */
/* -------------------------------------------------------------------------- */

/** Inputs of `buildAddLiquidity`: the cells and funding, already selected (see `select/liquidity.ts`). */
export interface AddLiquidityParams extends FeeOptions {
  /** The network's builder context. */
  readonly ctx: BuilderContext;
  /** The bound pool cell. */
  readonly pool: PoolCell;
  /** The pool-owned L inventory cell (`LP_SUPPLY - issued`). */
  readonly inventory: TokenCell;
  /** The pool-owned T reserve cell (`tokenReserve`). */
  readonly reserve: TokenCell;
  /** The depositor's T cell; key-owned, holding exactly `dTok` (absorbed whole). Its key owns the new LP cell. */
  readonly userCell: TokenCell;
  /** The depositor's KAS: the KAS leg, the LP cell's funding beyond the T cell's value, the fee. At least one. */
  readonly funding: readonly FundingUtxo[];
  /** P2PK address of the depositor: change. */
  readonly changeAddress: string;
  /** LP shares to mint. */
  readonly shares: bigint;
  /** Value of the new LP cell, sompi (default 5 KAS, least 2.5 KAS). */
  readonly lpCellValue?: bigint;
  /**
   * The caller asserts that the Kasseal API's invariant monitor confirms this pool (`sum of L cells == LP_SUPPLY`,
   * `inventory + issued == LP_SUPPLY`, one P-owned cell per lineage). Deposits are refused without it.
   */
  readonly lpSafe: true;
  /** The token lineage of the pool; the pool must name it (`LineageMismatch`). */
  readonly tokenId?: string;
  /** Refuse (`NetBoundExceeded`) when `KAS leg + (V - the absorbed cell's value) + network fee` exceeds it. */
  readonly maxAllIn?: bigint;
}

/** The built deposit and its predicted successor states. */
export interface AddLiquidityResult extends Shaped {
  /** LP shares minted. */
  readonly shares: bigint;
  /** The KAS leg in 0.01 KAS units (`ceil(shares * kasScaled / S)`). */
  readonly dKasScaled: bigint;
  /** The token leg (`ceil(shares * tokenReserve / S)`), the amount the absorbed T cell holds. */
  readonly dTok: bigint;
  /** L (hex). */
  readonly L: string;
  /** The pool's predicted state. */
  readonly poolNext: PoolCellState;
  /** The merged T reserve's state. */
  readonly mergedTokenNext: TokenState;
  /** The L inventory rest's state. */
  readonly restLpNext: TokenState;
  /** The depositor's new LP cell's state. */
  readonly lpUserNext: TokenState;
  /** KAS value of the new LP cell. */
  readonly lpCellValue: bigint;
  /** Compute budgets per input. */
  readonly budgets: readonly number[];
  /** The fee paid, sompi. */
  readonly fee: bigint;
  /** One line for the confirmation screen. */
  readonly summary: string;
  /** Everything that leaves the depositor's wallet: the KAS leg, the LP cell's funding beyond the absorbed cell and the fee. */
  readonly allIn: bigint;
}

/**
 * Build `addLiquidity`. Refuses (throws) an unbound pool, a missing `lpSafe`, a share count outside the deposit limits
 * or below `minDepositShares`, a user cell that does not hold exactly `dTok`, and an all-in cost above `maxAllIn`.
 */
export function buildAddLiquidity(params: AddLiquidityParams): AddLiquidityResult {
  const { ctx, pool, inventory, reserve, userCell, funding, shares } = params;
  if (!hasOpenLiquidity(requirePoolOfContext(ctx, pool))) throw new Error('addLiquidity exists in the v1 pool only');
  if (params.lpSafe !== true) throw new Error('deposit refused: the caller must assert lpSafe (the indexer confirms the L supply and the inventory equation of this pool)');
  requireLineage(`pool ${pool.covenantId}`, pool.state.tokenCovId, params.tokenId);
  const L = requirePoolInventory(pool, inventory, poolLimitsOf(ctx));
  requireLpCommitment(ctx, pool, inventory);
  const T = requirePoolToken(pool, reserve);
  const P = pool.covenantId;
  requireUserCell(userCell, T, P);
  if (funding.length === 0) throw new Error('addLiquidity needs at least one KAS input (the KAS leg and the fee)');
  const V = params.lpCellValue ?? DEFAULT_LP_CELL_VALUE;
  if (V < MIN_LP_CELL_VALUE) throw new Error(`LP cell value ${V} is below the ${MIN_LP_CELL_VALUE} sompi minimum`);

  const q = depositQuote(pool, shares, poolLimitsOf(ctx));
  if (userCell.state.amount !== q.dTok) throw new Error(`user cell holds ${userCell.state.amount} tokens, a deposit of ${shares} shares takes exactly ${q.dTok}; split or merge first`);
  const tokenExt = extOf(reserve);
  if (toHex(extOf(userCell)) !== toHex(tokenExt)) throw new Error("user cell's extension commitment differs from the pool reserve's");

  const poolNext: PoolCellState = { ...pool.state, kasScaled: q.pool.kasScaled, tokenReserve: q.pool.tokenReserve, lpShares: q.pool.lpShares };
  const mergedTokenNext = covenantOwnedToken(q.pool.tokenReserve, P, tokenExt);
  const lpExt = extOf(inventory);
  const restLpNext = covenantOwnedToken(inventory.state.amount - shares, P, lpExt);
  const lpUserNext = userToken(shares, userCell.state.owner.identifier, { extensionCommitment: lpExt });
  checkTokenFamily(T, [userCell, reserve], [mergedTokenNext], WITNESS_SIGNED);
  checkTokenFamily(L, [inventory], [restLpNext, lpUserNext], WITNESS_COVENANT);
  const poolValue = poolCellValue(q.pool);
  if (poolValue !== pool.value + q.dKasScaled * POOL_KAS_SCALE) throw new Error('pool value arithmetic mismatch');

  const budgets = budgetsV3Of(ctx);
  const plan: TxPlan = {
    name: `addLiquidity(${shares})`,
    inputs: [
      poolInput(pool, `POOL addLiquidity(${shares}, lpUser)`, budgets.poolAddLiquidity, poolAddLiquiditySigScript(ctx.pool, pool.program, shares, kcc20Full(lpUserNext, ctx.token.templateHash))),
      tokenLeaderSignedInput(userCell, [mergedTokenNext], 'KCC20 user cell of T (T leader, 00 || sig)', signedLeaderBudget(2, 1)),
      tokenDelegatorCovenantInput(reserve, 'KCC20 pool reserve (T delegator, empty witness)'),
      tokenLeaderCovenantInput(inventory, [restLpNext, lpUserNext], 'KCC20 L inventory (L leader, witness 00)', BUDGETS.tokenLeaderCovenant2Out),
      ...funding.map((u) => kasInput(u, 'KAS (depositor: KAS leg, LP cell funding, fee)')),
    ],
    outputs: [
      poolOutput(ctx, "POOL' {+dKas, +dTok, +shares}", poolNext, poolValue, P, ADD_POOL_IN),
      tokenOutput(ctx, 'mergedT (owner P)', mergedTokenNext, reserve.value, T, ADD_USER_TOKEN_IN),
      tokenOutput(ctx, 'restL inventory (owner P)', restLpNext, inventory.value, L, ADD_INVENTORY_IN),
      tokenOutput(ctx, 'lpUser (LP cell)', lpUserNext, V, L, ADD_INVENTORY_IN),
    ],
    residual: changeTo(p2pkScript(params.changeAddress), 'change (depositor)'),
    genesisGroups: [],
    payload: new Uint8Array(0),
    ...feeFields(params),
  };
  requireOwnLineages(plan, [P, T, L]);
  const s = finish(plan, ['pool', 'token-rest', 'token-reserve', 'token-user'], 'change');
  // What the wallet pays: its P2PK inputs minus the change (= KAS leg + V - the absorbed cell's value + fee).
  const allIn = fundingSum(funding) - s.built.residualValue;
  assertAllIn(plan.name, allIn, s.built.fee, params.maxAllIn);
  const summary = `Deposit ${shares} shares: ${kasString(q.dKasScaled * POOL_KAS_SCALE)} KAS + ${q.dTok} tokens into the pool (shares ${pool.state.lpShares} -> ${q.pool.lpShares}); `
    + `your ${kasString(userCell.value)} KAS token cell becomes a ${kasString(V)} KAS LP cell; network fee ${kasString(s.built.fee)} KAS.`;
  return { ...s, shares, dKasScaled: q.dKasScaled, dTok: q.dTok, L, poolNext, mergedTokenNext, restLpNext, lpUserNext, lpCellValue: V, budgets: s.built.budgets, fee: s.built.fee, summary, allIn };
}

/* -------------------------------------------------------------------------- */
/* removeLiquidity                                                             */
/* -------------------------------------------------------------------------- */

/** Inputs of `buildRemoveLiquidity`: the cells and optional funding, already selected (see `select/liquidity.ts`). */
export interface RemoveLiquidityParams extends FeeOptions {
  /** The network's builder context. */
  readonly ctx: BuilderContext;
  /** The bound pool cell. */
  readonly pool: PoolCell;
  /** The pool-owned L inventory cell. */
  readonly inventory: TokenCell;
  /** The pool-owned T reserve cell. */
  readonly reserve: TokenCell;
  /** The withdrawer's L cell; key-owned, holding exactly `shares` (absorbed whole). Its key owns the token leg. */
  readonly userLpCell: TokenCell;
  /** Extra KAS, only when the L cell's value plus the KAS leg cannot cover the fee and the payout floor. */
  readonly funding?: readonly FundingUtxo[];
  /** P2PK address of the withdrawer: the payout (the KAS leg plus what the L cell's value leaves). */
  readonly changeAddress: string;
  /** LP shares to redeem. */
  readonly shares: bigint;
  /** Builder pre-check in 0.01 KAS units (the unit of `dKasScaled`); the covenant has `PAYOUT_MIN` only. */
  readonly minKasOut?: bigint;
  /** Builder pre-check on the token leg. */
  readonly minTokOut?: bigint;
  /** Value of the new token cell (default: the absorbed L cell's value less `WITHDRAWAL_FEE_HEADROOM`, at most 5 KAS, at least the 0.1 KAS user-cell floor). */
  readonly tokCellValue?: bigint;
  /** The token lineage of the pool; the pool must name it (`LineageMismatch`). */
  readonly tokenId?: string;
  /** Refuse (`NetBoundExceeded`) when the payout minus any top-up input is below it. */
  readonly minNetOut?: bigint;
}

/** The built withdrawal and its predicted successor states. */
export interface RemoveLiquidityResult extends Shaped {
  /** LP shares redeemed. */
  readonly shares: bigint;
  /** The KAS leg in 0.01 KAS units (`floor(shares * kasScaled / S)`, at least `PAYOUT_MIN`). */
  readonly dKasScaled: bigint;
  /** The token leg (`floor(shares * tokenReserve / S)`, at least 1). */
  readonly dTok: bigint;
  /** L (hex). */
  readonly L: string;
  /** The pool's predicted state. */
  readonly poolNext: PoolCellState;
  /** The merged L inventory's state. */
  readonly mergedLpNext: TokenState;
  /** The T reserve rest's state. */
  readonly restTokenNext: TokenState;
  /** The withdrawer's new token cell's state. */
  readonly tokenUserNext: TokenState;
  /** KAS value of the new token cell. */
  readonly tokCellValue: bigint;
  /** The P2PK payout at output 4: `dKas * 1e6` plus the L cell's value beyond the token cell's, minus the fee (plus any top-up); never below `dKas * 1e6`. */
  readonly payout: bigint;
  /** The payout minus the top-up KAS the wallet put in. */
  readonly netOut: bigint;
  /** Compute budgets per input. */
  readonly budgets: readonly number[];
  /** The fee paid, sompi. */
  readonly fee: bigint;
  /** One line for the confirmation screen. */
  readonly summary: string;
}

/**
 * KAS of the absorbed L cell a withdrawal keeps back from the new token cell for the network fee (0.5 KAS; a v1
 * withdrawal costs about 0.05 KAS at the minimum feerate). The v1 pool pays the whole KAS leg to the owner, so the
 * fee comes from this headroom or from a top-up input, never from the KAS leg.
 */
export const WITHDRAWAL_FEE_HEADROOM = SOMPI_PER_KAS / 2n;

/** Default value of the token cell a withdrawal creates: the absorbed L cell's KAS less the fee headroom, capped at 5 KAS, at least the user-cell floor. */
export function defaultTokenCellValue(lpCellValue: bigint): bigint {
  const spare = lpCellValue - WITHDRAWAL_FEE_HEADROOM;
  const v = spare > DEFAULT_USER_CELL_VALUE ? DEFAULT_USER_CELL_VALUE : spare;
  return v < MIN_USER_CELL_VALUE ? MIN_USER_CELL_VALUE : v;
}

/**
 * Below this payout the P2PK output's storage term (`1e12 / value` grams, KIP-9) outweighs the shape's transient mass
 * (about 48,000 g for the 24 KB of programs) and the fee climbs steeply: a 0.1 KAS payout alone costs about 0.13 KAS.
 * The builder and the planner then top the withdrawal up from the user's KAS, which lifts the payout out of that range.
 */
export const WITHDRAWAL_PAYOUT_COMFORT = SOMPI_PER_KAS / 2n;

/** Whether a withdrawal should carry a KAS input: the payout before the fee (`L cell value - token cell value + dKas * 1e6`) is below `WITHDRAWAL_PAYOUT_COMFORT`. */
export function withdrawalNeedsTopUp(lpCellValue: bigint, tokCellValue: bigint, dKasScaled: bigint): boolean {
  return lpCellValue - tokCellValue + dKasScaled * POOL_KAS_SCALE < WITHDRAWAL_PAYOUT_COMFORT;
}

/**
 * Build `removeLiquidity`. Refuses (throws) an unbound pool, a share count outside the withdrawal limits, a KAS leg
 * below `PAYOUT_MIN` or `minKasOut`, a token leg below `minTokOut`, and a net payout below `minNetOut`.
 */
export function buildRemoveLiquidity(params: RemoveLiquidityParams): RemoveLiquidityResult {
  const { ctx, pool, inventory, reserve, userLpCell, shares } = params;
  if (!hasOpenLiquidity(requirePoolOfContext(ctx, pool))) throw new Error('removeLiquidity exists in the v1 pool only');
  requireLineage(`pool ${pool.covenantId}`, pool.state.tokenCovId, params.tokenId);
  const L = requirePoolInventory(pool, inventory, poolLimitsOf(ctx));
  requireLpCommitment(ctx, pool, inventory);
  const T = requirePoolToken(pool, reserve);
  const P = pool.covenantId;
  if (userLpCell.covenantId !== L) throw new Error(`LP cell lineage ${userLpCell.covenantId} is not the pool's L ${L}`);
  requireUserCell(userLpCell, L, P);
  const V = params.tokCellValue ?? defaultTokenCellValue(userLpCell.value);
  if (V < MIN_USER_CELL_VALUE) throw new Error(`token cell value ${V} is below the ${MIN_USER_CELL_VALUE} sompi minimum`);

  const q = withdrawalQuote(pool, shares, params.minKasOut, params.minTokOut, poolLimitsOf(ctx));
  if (userLpCell.state.amount !== shares) throw new Error(`LP cell holds ${userLpCell.state.amount} shares, removeLiquidity(${shares}) absorbs exactly ${shares}; split or merge first`);
  const lpExt = extOf(inventory);
  if (toHex(extOf(userLpCell)) !== toHex(lpExt)) throw new Error("LP cell's extension commitment differs from the inventory's");
  // The pool pays the KAS leg at output 4 to the redeemed cell's owner, at least dKas * 1e6: this
  // builder signs key-owned positions only, so the payout is P2PK(owner) and the fee never comes out of the leg.
  const owner = userLpCell.state.owner;
  if (owner.schemeByte !== 0x00) throw new Error(`LP cell owner scheme ${owner.schemeByte} is not p2pk-schnorr/v1; the builder withdraws key-owned positions only`);
  const payoutSpk = p2pkScript(params.changeAddress);
  if (toHex(payoutSpk) !== `20${toHex(owner.identifier)}ac`) throw new Error("the payout address is not the LP cell owner's key: the pool pays the KAS leg to the owner");

  const poolNext: PoolCellState = { ...pool.state, kasScaled: q.pool.kasScaled, tokenReserve: q.pool.tokenReserve, lpShares: q.pool.lpShares };
  const mergedLpNext = covenantOwnedToken(inventory.state.amount + shares, P, lpExt);
  const tokenExt = extOf(reserve);
  const restTokenNext = covenantOwnedToken(q.pool.tokenReserve, P, tokenExt);
  const tokenUserNext = userToken(q.dTok, userLpCell.state.owner.identifier, { extensionCommitment: tokenExt });
  checkTokenFamily(L, [userLpCell, inventory], [mergedLpNext], WITNESS_SIGNED);
  checkTokenFamily(T, [reserve], [restTokenNext, tokenUserNext], WITNESS_COVENANT);
  const poolValue = poolCellValue(q.pool);
  if (poolValue !== pool.value - q.dKasScaled * POOL_KAS_SCALE) throw new Error('pool value arithmetic mismatch');

  const budgets = budgetsV3Of(ctx);
  const plan: TxPlan = {
    name: `removeLiquidity(${shares})`,
    inputs: [
      tokenLeaderSignedInput(userLpCell, [mergedLpNext], 'KCC20 user cell of L (L leader, 00 || sig)', signedLeaderBudget(2, 1)),
      tokenDelegatorCovenantInput(inventory, 'KCC20 L inventory (L delegator, empty witness)'),
      tokenLeaderCovenantInput(reserve, [restTokenNext, tokenUserNext], 'KCC20 pool reserve (T leader, witness 00)', BUDGETS.tokenLeaderCovenant2Out),
      poolInput(pool, `POOL removeLiquidity(${shares}, tokUser)`, budgets.poolRemoveLiquidity, poolRemoveLiquiditySigScript(ctx.pool, pool.program, shares, kcc20Full(tokenUserNext, ctx.token.templateHash))),
      ...(params.funding ?? []).map((u) => kasInput(u, 'KAS (withdrawer top-up)')),
    ],
    outputs: [
      tokenOutput(ctx, 'mergedL inventory (owner P)', mergedLpNext, inventory.value, L, REMOVE_USER_LP_IN),
      tokenOutput(ctx, 'restT (owner P)', restTokenNext, reserve.value, T, REMOVE_RESERVE_IN),
      tokenOutput(ctx, 'tokUser (token cell)', tokenUserNext, V, T, REMOVE_RESERVE_IN),
      poolOutput(ctx, "POOL' {-dKas, -dTok, -shares}", poolNext, poolValue, P, REMOVE_POOL_IN),
    ],
    residual: payoutTo(payoutSpk, 'payout (withdrawer)', q.dKasScaled * POOL_KAS_SCALE > MIN_PAYOUT ? q.dKasScaled * POOL_KAS_SCALE : MIN_PAYOUT),
    genesisGroups: [],
    payload: new Uint8Array(0),
    ...feeFields(params),
  };
  requireOwnLineages(plan, [P, T, L]);
  // The pool pins the payout right after its own continuation (output 4 on earlier frozen builds): both hold here.
  if (plan.outputs.length !== REMOVE_PAYOUT_OUT || REMOVE_PAYOUT_OUT !== REMOVE_POOL_OUT + 1) throw new Error(`removeLiquidity payout must be output ${REMOVE_PAYOUT_OUT}, right after the pool`);
  const s = finish(plan, ['token-reserve', 'token-rest', 'token-user', 'pool'], 'payout');
  const payout = s.built.residualValue;
  const netOut = payout - fundingSum(params.funding);
  assertNetOut(plan.name, netOut, s.built.fee, params.minNetOut);
  const summary = `Withdraw ${shares} shares: ${kasString(q.dKasScaled * POOL_KAS_SCALE)} KAS + ${q.dTok} tokens out of the pool (shares ${pool.state.lpShares} -> ${q.pool.lpShares}); `
    + `your ${kasString(userLpCell.value)} KAS LP cell becomes a ${kasString(V)} KAS token cell and a ${kasString(payout)} KAS payout; network fee ${kasString(s.built.fee)} KAS.`;
  return {
    ...s, shares, dKasScaled: q.dKasScaled, dTok: q.dTok, L, poolNext, mergedLpNext, restTokenNext, tokenUserNext, tokCellValue: V, payout, netOut, budgets: s.built.budgets, fee: s.built.fee, summary,
  };
}

/* -------------------------------------------------------------------------- */
/* Ratio-drift guard for rebuilds                                              */
/* -------------------------------------------------------------------------- */

/** The two reserve fields the ratio is formed from (a `PoolCellState`, an `LpPoolState` or a quote both qualify). */
export interface ReserveRatioState {
  /** KAS reserve, 0.01 KAS units. */
  readonly kasScaled: bigint;
  /** Token reserve, whole tokens. */
  readonly tokenReserve: bigint;
}

/** An automatic rebuild after a lost race is allowed only while the reserve ratio moved less than this (1 %). */
export const AUTO_REBUILD_MAX_RATIO_DRIFT = 0.01;
/** The same bound in basis points, the unit `ratioDriftBps` compares exactly. */
export const AUTO_REBUILD_MAX_RATIO_DRIFT_BPS = 100n;

function ratioTerms(quoted: ReserveRatioState, live: ReserveRatioState): { readonly num: bigint; readonly den: bigint } {
  for (const [what, s] of [['quoted', quoted], ['live', live]] as const) {
    if (s.kasScaled <= 0n || s.tokenReserve <= 0n) throw new Error(`${what} state has non-positive reserves`);
  }
  // |live.kas / live.tok - quoted.kas / quoted.tok| / (quoted.kas / quoted.tok) = |live.kas * quoted.tok - quoted.kas * live.tok| / (quoted.kas * live.tok)
  const a = live.kasScaled * quoted.tokenReserve;
  const b = quoted.kasScaled * live.tokenReserve;
  return { num: a > b ? a - b : b - a, den: b };
}

/** Relative change of `kasScaled / tokenReserve` from the quoted state to the live one, in basis points rounded up (exact bigint). */
export function ratioDriftBps(quoted: ReserveRatioState, live: ReserveRatioState): bigint {
  const { num, den } = ratioTerms(quoted, live);
  return (num * 10_000n + den - 1n) / den;
}

/** Relative change of `kasScaled / tokenReserve` from the quoted state to the live one (0.01 = 1 %), to nine decimals. */
export function ratioDrift(quoted: ReserveRatioState, live: ReserveRatioState): number {
  const { num, den } = ratioTerms(quoted, live);
  return Number((num * 1_000_000_000n) / den) / 1e9;
}

/** The rebuild rule: `ratioDrift < AUTO_REBUILD_MAX_RATIO_DRIFT`, compared exactly (`num * 10000 < 100 * den`). */
export function canRebuildAutomatically(quoted: ReserveRatioState, live: ReserveRatioState): boolean {
  const { num, den } = ratioTerms(quoted, live);
  return num * 10_000n < AUTO_REBUILD_MAX_RATIO_DRIFT_BPS * den;
}

/** The live reserve ratio drifted too far from the quote for an automatic rebuild: the caller re-quotes and asks the user. */
export class RatioDriftError extends Error {
  /** The drift (0.01 = 1 %). */
  readonly drift: number;
  /** The quoted reserves. */
  readonly quoted: ReserveRatioState;
  /** The live reserves. */
  readonly live: ReserveRatioState;
  constructor(quoted: ReserveRatioState, live: ReserveRatioState) {
    const drift = ratioDrift(quoted, live);
    super(`reserve ratio moved ${(drift * 100).toFixed(3)} % since the quote (limit ${AUTO_REBUILD_MAX_RATIO_DRIFT * 100} %): re-quote before rebuilding`);
    this.name = 'RatioDriftError';
    this.drift = drift;
    this.quoted = { kasScaled: quoted.kasScaled, tokenReserve: quoted.tokenReserve };
    this.live = { kasScaled: live.kasScaled, tokenReserve: live.tokenReserve };
  }
}

/** Throws `RatioDriftError` unless `canRebuildAutomatically`. */
export function assertRebuildAllowed(quoted: ReserveRatioState, live: ReserveRatioState): void {
  if (!canRebuildAutomatically(quoted, live)) throw new RatioDriftError(quoted, live);
}
