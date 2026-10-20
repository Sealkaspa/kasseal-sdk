/**
 * Pool swaps: the curve buy and sell shapes with the pool in place of the curve.
 *
 * swapKasForTokens(kasInScaled, [minTokensOut,] user):
 *   in0   POOL (P)                        swapKasForTokens(kasInScaled, minTokensOut, user)   legs in 0.01 KAS (MIN_LEG = 1e6 sompi);
 *                                         minTokensOut only on pools with the bounded buy
 *   in1   pool token cell (T leader)      transfer([rest, user], 00)
 *   in2.. buyer KAS (P2PK)
 *   out0  POOL'  binding (0, P)           value + kasInScaled * 1e6 (the dust carried)
 *   out1  rest   binding (1, T)           owner P, tokenReserve'
 *   out2  user   binding (1, T)           owner buyer, tokensOut, value V (default 5 KAS)
 *   out3  change
 *
 * swapTokensForKas(tokensIn, minOutScaled):
 *   in0   user cell (T leader)            transfer([merged], 00 || sig65)   the wallet signs this P2SH input
 *   in1   pool token cell (T delegator)   transfer_delegator(empty)
 *   in2   POOL (P)                        swapTokensForKas(tokensIn, minOutScaled)
 *   out0  merged  binding (0, T)          owner P, tokenReserve + tokensIn
 *   out1  POOL'   binding (2, P)          value - kasOutNet * 1e6
 *   out2  payout  P2PK(seller)
 *
 * On-chain bounds: the sell's `minOutScaled` and, on pools with the bounded buy, the buy's
 * `minTokensOut` carry the caller's minimum, else the exact quote. Unchained, a swap binds one exact pool outpoint, so a
 * race rejects instead of mis-filling; the bound is what keeps a swap built on a pending pool tip (pool chaining) from
 * landing worse than the signer accepted.
 *
 * `v1-kasseal-mainnet-2` (composable swaps): the same two shapes; the buy names
 * the reserve's and its successor's positions (`APP_BUY_POSITIONS`: 0, 0) instead of the user cell, the sell adds
 * `APP_SELL_POSITIONS` (reserve 1, merged 0). The pool no longer checks the user cell, so the builder's own
 * `checkTokenFamily` (no self-owned covenant cell) is what protects the buyer's output; its budgets are
 * `BUDGETS_V1_COMPOSABLE`.
 *
 * v1 pools (bound or unbound): the same two shapes with the v1 budgets; the
 * successor state carries `lpShares` and `lpCovId` unchanged (the v1 `pool.sil`),
 * and no L cell is ever an input of a swap.
 */

import { poolLimitsOf, poolRoundingOf } from '../cells.ts';
import type { TokenState } from '@kasseal/codec';
import {
  POOL_PAYOUT_MIN_SCALED, poolCellValue, swapKasForTokens as poolBuyQuote, swapTokensForKas as poolSellQuote, type PoolState as PoolMathState,
} from '@kasseal/curve-math';
import { p2pkScript, type FundingUtxo, type InputPlan, type PoolCell, type TokenCell, type TxPlan } from '../assemble.ts';
import {
  budgetsOf, changeTo, kasInput, payoutTo, plainOutput, poolInput, poolOutput, tokenDelegatorCovenantInput, tokenDelegatorSignedInput, tokenLeaderCovenantInput, tokenLeaderSignedInput, tokenOutput, type BuilderContext,
} from '../cells.ts';
import { BUDGETS, signedLeaderBudget } from '../mass.ts';
import { POOL_KAS_SCALE, covenantOwnedToken, isComposablePool, scriptHashOf, scriptOwnedToken, userToken, type PoolCellState } from '../program.ts';
import { APP_BUY_POSITIONS, WITNESS_PATH_NORMAL, ZERO_SIG65, kcc20Full, poolSwapKasForTokensSigScript, poolSwapTokensForKasSigScript, pushMinimal, tokenLeaderSigScript } from '../sigscript.ts';
import { p2shScript } from '../blake2b.ts';
import { concat, toHex } from '@kasseal/codec';
import {
  DEFAULT_USER_CELL_VALUE, MIN_PAYOUT, MIN_USER_CELL_VALUE, WITNESS_COVENANT, WITNESS_SIGNED, assertAllIn, assertNetOut, checkTokenFamily, feeFields, finish, fundingSum,
  requireLineage, requirePoolOfContext, requirePoolToken, requireUserCell, type FeeOptions, type Shaped, requireOwnLineages, MIN_P2PK_OUTPUT_VALUE,
} from './common.ts';
import type { Buyer } from './buy.ts';
import type { Seller } from './sell.ts';

/** The pool's payout minimum in scaled units (pool.sil `PAYOUT_MIN`: 0.1 KAS); `swapTokensForKas` in curve-math enforces it. */
export { POOL_PAYOUT_MIN_SCALED };

/** The curve-math view of a pool cell (dust derived from the cell value). */
export function poolMathState(pool: PoolCell): PoolMathState {
  const dust = pool.value - (pool.state.kasScaled + pool.state.feeAccruedScaled) * POOL_KAS_SCALE;
  if (dust < 0n || dust >= POOL_KAS_SCALE) throw new Error(`pool cell value ${pool.value} is inconsistent with its state (dust ${dust})`);
  return { kasScaled: pool.state.kasScaled, tokenReserve: pool.state.tokenReserve, feeAccruedScaled: pool.state.feeAccruedScaled, dust };
}

/** Inputs of `buildSwapKasForTokens`: the verified pool, its reserve and the buyer's funding. */
export interface SwapKasForTokensParams extends FeeOptions {
  /** The network's builder context. */
  readonly ctx: BuilderContext;
  /** The pool cell. */
  readonly pool: PoolCell;
  /** The pool-owned T reserve cell. */
  readonly poolToken: TokenCell;
  /** Who buys. */
  readonly buyer: Buyer;
  /** The gross KAS leg in 0.01 KAS units (`MIN_LEG = 1e6 sompi`). */
  readonly kasInScaled: bigint;
  /** The buyer's P2PK UTXOs. */
  readonly funding: readonly FundingUtxo[];
  /** Value of the new user cell, sompi (default 5 KAS). */
  readonly userCellValue?: bigint;
  /** Refuse when the quote yields fewer tokens; also the on-chain bound where the pool takes one (default: the exact quote). */
  readonly minTokensOut?: bigint;
  /** The token lineage being traded; the pool must name it (`LineageMismatch`). */
  readonly tokenId?: string;
  /** Refuse (`NetBoundExceeded`) when `KAS leg + V + network fee` exceeds it. */
  readonly maxAllIn?: bigint;
  /**
   * Composable pools only (`v1-kasseal-mainnet-2`): swap-and-deposit. The bought tokens go to a cell owned by this script
   * (scheme 0x03, owner = its P2SH hash) instead of the buyer's key, and `scriptFunding` sompi go to P2SH(script) as a
   * plain output, the input that will authorize the cell later. Only a key-locked script is accepted unless
   * `allowAnyScript` is set (`assertSafeRedeem`).
   */
  readonly deliverToScript?: { readonly redeem: Uint8Array; readonly scriptFunding: bigint; readonly allowAnyScript?: boolean };
}

/** The built buy and its predicted successor states. */
export interface SwapKasForTokensResult extends Shaped {
  /** The pool's predicted state. */
  readonly poolNext: PoolCellState;
  /** Whole tokens bought. */
  readonly tokensOut: bigint;
  /** The reserve's predicted state. */
  readonly restNext: TokenState;
  /** The buyer's new cell's state. */
  readonly userNext: TokenState;
  /** Everything that leaves the buyer's wallet: the KAS leg, the user cell's value and the network fee. */
  readonly allIn: bigint;
}

/** A script a deposit or a script sell may not use (see `assertSafeRedeem`). */
export class UnsafeScript extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeScript';
  }
}

/** `<32-byte x-only key> OP_CHECKSIG`: the key-locked redeem script a deposit or a script sell uses by default. */
export function keyLockedRedeem(xOnly: Uint8Array): Uint8Array {
  if (xOnly.length !== 32) throw new Error('a key-locked script needs a 32-byte x-only key');
  return concat(Uint8Array.of(0x20), xOnly, Uint8Array.of(0xac));
}

/** The key of a key-locked redeem script, or undefined for any other script. */
export function keyOfLockedRedeem(redeem: Uint8Array): Uint8Array | undefined {
  return redeem.length === 34 && redeem[0] === 0x20 && redeem[33] === 0xac ? redeem.subarray(1, 33) : undefined;
}

const endsWith = (a: Uint8Array, tail: Uint8Array): boolean => tail.length > 0 && a.length >= tail.length && toHex(a.subarray(a.length - tail.length)) === toHex(tail);

/**
 * Check the redeem script of a deposit or a script sell. By default only the key-locked form (`keyLockedRedeem`)
 * is accepted. A caller that needs another script passes `allowAnyScript`; even then a script that reads as the pool's
 * or a token's program (any state: same template suffix) is refused, since tokens delivered there are locked for good
 * (the pool refuses pool-authorized cells), and so is a script that is empty.
 */
export function assertSafeRedeem(redeem: Uint8Array, opts: { allowAnyScript?: boolean; programs: readonly Uint8Array[] }): void {
  if (redeem.length === 0) throw new UnsafeScript('an empty script can be satisfied by anyone');
  if (keyOfLockedRedeem(redeem) !== undefined) return;
  if (opts.allowAnyScript !== true) throw new UnsafeScript('only a key-locked script (<x-only key> OP_CHECKSIG) is accepted; pass allowAnyScript for another one');
  for (const program of opts.programs) {
    const tail = program.subarray(Math.max(0, program.length - 256));
    if (endsWith(redeem, tail)) throw new UnsafeScript('the script is a pool or token program: tokens delivered to it would be locked for good');
  }
}

/**
 * Build `swapKasForTokens`. Refuses (throws) a non-positive leg, a quote below `minTokensOut`, an unsafe deposit script,
 * a lineage other than `tokenId`, and an all-in cost above `maxAllIn`.
 */
export function buildSwapKasForTokens(params: SwapKasForTokensParams): SwapKasForTokensResult {
  const { ctx, pool, poolToken, buyer, kasInScaled, funding } = params;
  requirePoolOfContext(ctx, pool);
  requireLineage(`pool ${pool.covenantId}`, pool.state.tokenCovId, params.tokenId);
  const T = requirePoolToken(pool, poolToken);
  const V = params.userCellValue ?? DEFAULT_USER_CELL_VALUE;
  if (V < MIN_USER_CELL_VALUE) throw new Error(`user cell value ${V} is below the ${MIN_USER_CELL_VALUE} sompi minimum`);
  if (kasInScaled <= 0n) throw new Error('kasInScaled must be positive');
  if (funding.length === 0) throw new Error('swap needs at least one funding input');
  const q = poolBuyQuote(poolMathState(pool), kasInScaled, poolLimitsOf(ctx), poolRoundingOf(ctx));
  if (q.tokenOut <= 0n) throw new Error(`a leg of ${kasInScaled} scaled units buys no tokens`);
  if (params.minTokensOut !== undefined && q.tokenOut < params.minTokensOut) throw new Error(`quote ${q.tokenOut} tokens is below minOut ${params.minTokensOut}`);
  // The on-chain bound (pools whose buy takes it): the caller's minimum, else the exact quote.
  const minTokens = params.minTokensOut ?? q.tokenOut;
  const poolNext: PoolCellState = { ...pool.state, kasScaled: q.pool.kasScaled, tokenReserve: q.pool.tokenReserve, feeAccruedScaled: q.pool.feeAccruedScaled };
  const restNext = covenantOwnedToken(q.pool.tokenReserve, pool.covenantId);
  const deposit = params.deliverToScript;
  if (deposit !== undefined && !isComposablePool(ctx.pool)) throw new Error('swap-and-deposit needs a composable pool (Kasseal-mainnet-2)');
  if (deposit !== undefined) {
    assertSafeRedeem(deposit.redeem, { ...(deposit.allowAnyScript === undefined ? {} : { allowAnyScript: deposit.allowAnyScript }), programs: [pool.program, poolToken.program] });
    if (deposit.scriptFunding < MIN_P2PK_OUTPUT_VALUE) throw new Error(`script funding ${deposit.scriptFunding} is below the ${MIN_P2PK_OUTPUT_VALUE} sompi output minimum`);
  }
  const userNext = deposit === undefined ? userToken(q.tokenOut, buyer.xOnlyPubkey) : scriptOwnedToken(q.tokenOut, scriptHashOf(deposit.redeem));
  checkTokenFamily(T, [poolToken], [restNext, userNext], WITNESS_COVENANT);
  const poolValue = poolCellValue(q.pool);
  if (poolValue !== pool.value + kasInScaled * POOL_KAS_SCALE) throw new Error('pool value arithmetic mismatch');
  const plan: TxPlan = {
    name: `swapKasForTokens(${kasInScaled})`,
    inputs: [
      poolInput(pool, `POOL swapKasForTokens(${kasInScaled}, ${minTokens}, ${isComposablePool(ctx.pool) ? `${APP_BUY_POSITIONS.reserveK}, ${APP_BUY_POSITIONS.restK}` : 'user'})`, budgetsOf(ctx).poolSwapKasForTokens, poolSwapKasForTokensSigScript(ctx.pool, pool.program, kasInScaled, kcc20Full(userNext, ctx.token.templateHash), minTokens)),
      tokenLeaderCovenantInput(poolToken, [restNext, userNext], 'KCC20 pool cell (T leader, witness 00)', BUDGETS.tokenLeaderCovenant2Out),
      ...funding.map((u) => kasInput(u, 'buyer KAS')),
    ],
    outputs: [
      poolOutput(ctx, "POOL'", poolNext, poolValue, pool.covenantId, 0),
      tokenOutput(ctx, 'rest (owner P)', restNext, poolToken.value, T, 1),
      tokenOutput(ctx, deposit === undefined ? 'user cell' : 'deposit cell (owned by the script)', userNext, V, T, 1),
      ...(deposit === undefined ? [] : [plainOutput('script funding (P2SH)', deposit.scriptFunding, p2shScript(deposit.redeem))]),
    ],
    residual: changeTo(p2pkScript(buyer.address), 'change (buyer)'),
    genesisGroups: [],
    payload: new Uint8Array(0),
    ...feeFields(params),
  };
  requireOwnLineages(plan, [pool.covenantId, T]);
  const s = finish(plan, deposit === undefined ? ['pool', 'token-rest', 'token-user'] : ['pool', 'token-rest', 'token-user', 'deposit'], 'change');
  const allIn = kasInScaled * POOL_KAS_SCALE + V + (deposit?.scriptFunding ?? 0n) + s.built.fee;
  assertAllIn(plan.name, allIn, s.built.fee, params.maxAllIn);
  return { ...s, poolNext, tokensOut: q.tokenOut, restNext, userNext, allIn };
}

/** Inputs of `buildSwapTokensForKas`: the verified pool, its reserve and the seller's cell. */
export interface SwapTokensForKasParams extends FeeOptions {
  /** The network's builder context. */
  readonly ctx: BuilderContext;
  /** The pool cell. */
  readonly pool: PoolCell;
  /** The pool-owned T reserve cell. */
  readonly poolToken: TokenCell;
  /** The seller's cell; absorbed whole (`tokensIn = userCell.amount`). */
  readonly userCell: TokenCell;
  /** Who sells and receives the payout. */
  readonly seller: Seller;
  /** Refuse when the quoted net payout (0.01 KAS units) is lower; also the on-chain bound (default: the exact quote). */
  readonly minOutScaled?: bigint;
  /** Optional P2PK top-up UTXOs when the payout cannot cover the fee. */
  readonly funding?: readonly FundingUtxo[];
  /** The token lineage being traded; the pool must name it (`LineageMismatch`). */
  readonly tokenId?: string;
  /** Refuse (`NetBoundExceeded`) when the payout minus any top-up input is below it. */
  readonly minNetOut?: bigint;
  /**
   * Composable pools only: more of the seller's own cells (key-owned, signed as delegators), sold together with
   * `userCell` in one swap without a merge first (`tokensIn` is their sum).
   */
  readonly extraUserCells?: readonly TokenCell[];
  /**
   * Composable pools only: `userCell` is owned by a script (scheme 0x03) and authorized by spending `utxo` at P2SH(redeem)
   * (for example a router's sell). The redeem script is `<signer x-only key> OP_CHECKSIG` (anything else is refused
   * unless `allowAnyScript`): the seller signs that input.
   */
  readonly scriptAuthority?: { readonly redeem: Uint8Array; readonly utxo: FundingUtxo; readonly signerXOnly: string; readonly allowAnyScript?: boolean };
}

/** The built sell and its predicted successor states. */
export interface SwapTokensForKasResult extends Shaped {
  /** The pool's predicted state. */
  readonly poolNext: PoolCellState;
  /** Net KAS out, 0.01 KAS units. */
  readonly kasOutScaled: bigint;
  /** The merged reserve's predicted state. */
  readonly mergedNext: TokenState;
  /** The P2PK payout, sompi. */
  readonly payout: bigint;
  /** The payout minus the top-up KAS the wallet put in. */
  readonly netOut: bigint;
}

/**
 * Build `swapTokensForKas`. Refuses (throws) a payout below the pool's `PAYOUT_MIN` or `minOutScaled`, an unsafe or
 * mismatched authority script, extra cells on a pool that is not composable, and a net payout below `minNetOut`.
 */
export function buildSwapTokensForKas(params: SwapTokensForKasParams): SwapTokensForKasResult {
  const { ctx, pool, poolToken, userCell, seller } = params;
  requirePoolOfContext(ctx, pool);
  requireLineage(`pool ${pool.covenantId}`, pool.state.tokenCovId, params.tokenId);
  const T = requirePoolToken(pool, poolToken);
  const extras = params.extraUserCells ?? [];
  const auth = params.scriptAuthority;
  if ((extras.length > 0 || auth !== undefined) && !isComposablePool(ctx.pool)) throw new Error('a multi-cell or script-authorized sell needs a composable pool (Kasseal-mainnet-2)');
  if (extras.length > 1) throw new Error('KCC-20 carries at most three token inputs: the seller\'s cell, one more and the reserve');
  if (auth === undefined) requireUserCell(userCell, T, pool.covenantId);
  else {
    if (userCell.covenantId !== T) throw new Error('user cell is not of lineage T');
    if (userCell.state.owner.schemeByte !== 0x03 || toHex(userCell.state.owner.identifier) !== toHex(scriptHashOf(auth.redeem))) throw new Error('the cell is not owned by the authority script');
    // The documented form, signed by the named key, unless the caller opts into another script.
    assertSafeRedeem(auth.redeem, { ...(auth.allowAnyScript === undefined ? {} : { allowAnyScript: auth.allowAnyScript }), programs: [pool.program, poolToken.program] });
    const key = keyOfLockedRedeem(auth.redeem);
    if (key !== undefined && toHex(key) !== auth.signerXOnly.toLowerCase()) throw new UnsafeScript('the authority script is locked to another key than the signer');
  }
  for (const c of extras) requireUserCell(c, T, pool.covenantId);
  const tokensIn = extras.reduce((a, c) => a + c.state.amount, userCell.state.amount);
  // Refuses a net payout below PAYOUT_MIN (PoolPayoutTooSmallError), as the covenant does.
  const q = poolSellQuote(poolMathState(pool), tokensIn, poolLimitsOf(ctx), poolRoundingOf(ctx));
  if (params.minOutScaled !== undefined && q.kasOutScaled < params.minOutScaled) throw new Error(`net payout ${q.kasOutScaled} is below minOut ${params.minOutScaled}`);
  // The on-chain bound every pool's sell takes: the caller's minimum, else the exact quote.
  const minOut = params.minOutScaled ?? q.kasOutScaled;
  const poolNext: PoolCellState = { ...pool.state, kasScaled: q.pool.kasScaled, tokenReserve: q.pool.tokenReserve, feeAccruedScaled: q.pool.feeAccruedScaled };
  const mergedNext = covenantOwnedToken(q.pool.tokenReserve, pool.covenantId);
  // The authority input of a script-owned leader sits after the token inputs and the pool: its index is the witness.
  const authIndex = 2 + extras.length + 1;
  const leaderWitness = auth === undefined ? WITNESS_SIGNED : Uint8Array.of(WITNESS_PATH_NORMAL, authIndex);
  checkTokenFamily(T, [userCell, ...extras, poolToken], [mergedNext], leaderWitness);
  const poolValue = poolCellValue(q.pool);
  if (poolValue !== pool.value - q.kasOutScaled * POOL_KAS_SCALE) throw new Error('pool value arithmetic mismatch');
  const leader: InputPlan = auth === undefined
    ? tokenLeaderSignedInput(userCell, [mergedNext], 'KCC20 user cell (T leader, 00 || sig)', signedLeaderBudget(2 + extras.length, 1))
    : (() => {
      const s = tokenLeaderSigScript(userCell.program, [mergedNext], leaderWitness);
      return { label: 'KCC20 script-owned cell (T leader, 00 || authority input)', outpoint: userCell.outpoint, amount: userCell.value, spk: p2shScript(userCell.program), daaScore: userCell.daaScore, covenantId: userCell.covenantId, budget: BUDGETS.tokenLeaderCovenant1Out, sigscript: s.bytes, signature: undefined, cellKind: 'token' as const };
    })();
  // A composable sell names the reserve's position among the T inputs: after the seller's cells.
  const positions = { reserveK: BigInt(1 + extras.length), mergedK: 0n };
  const authorityInput: InputPlan[] = auth === undefined ? [] : [{
    label: 'authority script (P2SH, the signer\'s key)', outpoint: auth.utxo.outpoint, amount: auth.utxo.amount, spk: p2shScript(auth.redeem), daaScore: auth.utxo.daaScore,
    covenantId: undefined, budget: BUDGETS.p2pk, sigscript: concat(Uint8Array.of(0x41), ZERO_SIG65, pushMinimal(auth.redeem)),
    signature: { kind: 'token-delegator', offset: 1, signer: auth.signerXOnly, sighashType: 1 },
  }];
  const plan: TxPlan = {
    name: `swapTokensForKas(${tokensIn})`,
    inputs: [
      leader,
      ...extras.map((c) => tokenDelegatorSignedInput(c, 'KCC20 user cell (T delegator, sig)')),
      tokenDelegatorCovenantInput(poolToken, 'KCC20 pool cell (T delegator, empty witness)'),
      poolInput(pool, `POOL swapTokensForKas(${tokensIn}, ${minOut})`, budgetsOf(ctx).poolSwapTokensForKas, poolSwapTokensForKasSigScript(ctx.pool, pool.program, tokensIn, minOut, positions)),
      ...authorityInput,
      ...(params.funding ?? []).map((u) => kasInput(u, 'seller KAS (top-up)')),
    ],
    outputs: [
      tokenOutput(ctx, 'merged (owner P)', mergedNext, poolToken.value, T, 0),
      poolOutput(ctx, "POOL'", poolNext, poolValue, pool.covenantId, 2 + extras.length),
    ],
    residual: payoutTo(p2pkScript(seller.address), 'payout (seller)', MIN_PAYOUT),
    genesisGroups: [],
    payload: new Uint8Array(0),
    ...feeFields(params),
  };
  requireOwnLineages(plan, [pool.covenantId, T], auth === undefined ? undefined : { outpoint: auth.utxo.outpoint, spk: p2shScript(auth.redeem) });
  const s = finish(plan, ['token-rest', 'pool'], 'payout');
  const netOut = s.built.residualValue - fundingSum(params.funding);
  assertNetOut(plan.name, netOut, s.built.fee, params.minNetOut);
  return { ...s, poolNext, kasOutScaled: q.kasOutScaled, mergedNext, payout: s.built.residualValue, netOut };
}
