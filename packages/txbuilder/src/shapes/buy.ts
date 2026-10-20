/**
 * buy(n, user), the curve buy:
 *
 *   in0   CURVE (C leader)                buy(n, user)
 *   in1   KCC20 supply cell (T leader)    transfer([rest, user], 00)     owner C, amount (curveLots - lotsSold) * lot
 *   in2.. buyer KAS (P2PK)                wallet signs (SIGHASH_ALL)
 *   out0  CURVE'  binding (0, C)          value = in0 + cost + fee
 *   out1  rest    binding (1, T)          owner C, amount - n * lot, value = the supply cell's
 *   out2  user    binding (1, T)          owner buyer, n * lot, value V (default 5 KAS, refused below 0.1 KAS)
 *   out3  change
 *
 * Borrowed receive is not a shape the
 * deployed curve accepts: `buy` requires `OpCovInputCount(T) == 1` (the
 * supply cell alone) and a user output of exactly `n * lot`, so a buyer's
 * existing cell can be neither a second T input nor the successor that grows
 * by `n * lot`. `borrowInto` is therefore refused with `ShapeNotSupported`.
 * The opt-in half is supported: the new user cell may carry
 * `borrow_scheme 0x01` (amount-threshold/v1) so later transfers can borrow
 * into it; the curve admits `user.borrow <= 3`.
 *
 * Slippage (`maxKasIn`) is a builder pre-check only: a trade binds one
 * exact curve outpoint, so a race rejects, never mis-fills.
 *
 * Refused (`ProofNotBound`) unless the caller's launch-proof verdict is `bound`:
 * C's singleton is an off-chain proof obligation.
 */

import { BORROW_AMOUNT_THRESHOLD, thresholdGuard, type TokenState } from '@kasseal/codec';
import { buyQuote, type Quote } from '@kasseal/curve-math';
import { p2pkScript, type CurveCell, type FundingUtxo, type Outpoint, type TokenCell, type TxPlan } from '../assemble.ts';
import { budgetsOf, changeTo, curveInput, curveOutput, kasInput, tokenLeaderCovenantInput, tokenOutput, type BuilderContext } from '../cells.ts';
import { BUDGETS } from '../mass.ts';
import { PHASE_ACTIVE, covenantOwnedToken, userToken, type CurveState } from '../program.ts';
import { curveBuySigScript, kcc20Full } from '../sigscript.ts';
import { ShapeNotSupported, type LaunchProofVerdict } from '../types.ts';
import {
  DEFAULT_USER_CELL_VALUE, MIN_USER_CELL_VALUE, WITNESS_COVENANT, assertAllIn, checkTokenFamily, curveOwnedCellValue, feeFields, finish, requireActiveCurve, requireLineage, requireProofBound, requireSupplyCell,
  type FeeOptions, type Shaped, requireOwnLineages,
} from './common.ts';
import { launchPresetOf } from './create.ts';

/** Who buys: the key that will own the new token cell and the address for change. */
export interface Buyer {
  /** 32-byte x-only Schnorr public key: the owner of the new token cell. */
  readonly xOnlyPubkey: Uint8Array;
  /** P2PK address for change. */
  readonly address: string;
}

/** Inputs of `buildBuy`: the verified curve, its supply cell and the buyer's funding. */
export interface BuyParams extends FeeOptions {
  /** The network's builder context. */
  readonly ctx: BuilderContext;
  /** The curve cell. */
  readonly curve: CurveCell;
  /** The curve-owned supply cell: amount `(curveLots - lotsSold) * lot`. */
  readonly supply: TokenCell;
  /** Who buys. */
  readonly buyer: Buyer;
  /** Lots to buy. */
  readonly n: bigint;
  /** The token's launch-proof verdict; anything but `bound` is refused (`ProofNotBound`). */
  readonly proofVerdict: LaunchProofVerdict;
  /** The buyer's P2PK UTXOs. */
  readonly funding: readonly FundingUtxo[];
  /** Value of the new user cell, sompi (default 5 KAS, refused below 0.1 KAS). */
  readonly userCellValue?: bigint;
  /** Opt-in: the new cell carries `borrow_scheme 0x01` with this amount threshold; borrowing disabled when omitted. */
  readonly borrowThreshold?: bigint;
  /** Refused: the deployed curve accepts no borrowed receive (see the module comment). */
  readonly borrowInto?: Outpoint;
  /** Builder pre-check: refuse when `cost + fee` (sompi) exceeds it. */
  readonly maxKasIn?: bigint;
  /** The token lineage the buyer is trading; the curve must name it (`LineageMismatch`). */
  readonly tokenId?: string;
  /** Refuse (`NetBoundExceeded`) when `cost + curve fee + V + network fee` exceeds it: the all-in figure the page showed. */
  readonly maxAllIn?: bigint;
}

/** The built buy and its predicted successor states. */
export interface BuyResult extends Shaped {
  /** The curve quote (sompi). */
  readonly quote: Quote;
  /** The curve's predicted state. */
  readonly curveNext: CurveState;
  /** The supply cell's predicted state. */
  readonly restNext: TokenState;
  /** The buyer's new cell's state. */
  readonly userNext: TokenState;
  /** Everything that leaves the buyer's wallet: `quote.total + V + fee` (= funding spent - change). */
  readonly allIn: bigint;
}

/** Quote and opening-window checks shared by `buildBuy` and the funding estimate of the asynchronous builder. */
export function buyPrecheck(ctx: BuilderContext, curve: CurveCell, n: bigint, maxKasIn?: bigint): Quote {
  const p = ctx.curve.params;
  if (n <= 0n) throw new Error('n must be positive');
  if (curve.state.lotsSold + n > p.curveLots) throw new Error(`only ${p.curveLots - curve.state.lotsSold} lots remain`);
  if (curve.state.lotsSold < p.openWindowLots && n > p.openWindowMaxLots) throw new Error(`opening window: at most ${p.openWindowMaxLots} lots per buy while lotsSold < ${p.openWindowLots}`);
  const quote = buyQuote(launchPresetOf(ctx.curve).curve, curve.state.lotsSold, n);
  if (maxKasIn !== undefined && quote.total > maxKasIn) throw new Error(`quote ${quote.total} exceeds maxKasIn ${maxKasIn}`);
  return quote;
}

/**
 * Build a curve buy of `n` lots. Refuses (throws) a verdict other than `bound`, `borrowInto`, an inactive curve, a lineage
 * other than `tokenId`, a quote above `maxKasIn`, and an all-in cost above `maxAllIn`.
 */
export function buildBuy(params: BuyParams): BuyResult {
  const { ctx, curve, supply, buyer, n, funding } = params;
  requireProofBound(`buy(${n})`, params.proofVerdict);
  if (params.borrowInto !== undefined) {
    throw new ShapeNotSupported('borrowed receive into an existing cell: the deployed curve buy requires OpCovInputCount(T) == 1 and a user output of exactly n * lot');
  }
  requireActiveCurve(ctx, curve);
  requireLineage(`curve ${curve.covenantId}`, curve.state.tokenCovId, params.tokenId);
  const T = requireSupplyCell(ctx, curve, supply);
  const V = params.userCellValue ?? DEFAULT_USER_CELL_VALUE;
  if (V < MIN_USER_CELL_VALUE) throw new Error(`user cell value ${V} is below the ${MIN_USER_CELL_VALUE} sompi minimum`);
  if (funding.length === 0) throw new Error('buy needs at least one funding input');
  const quote = buyPrecheck(ctx, curve, n, params.maxKasIn);
  const restValue = curveOwnedCellValue(ctx, [{ cell: supply, name: 'supply' }]);

  const released = n * ctx.curve.params.lot;
  const restNext = covenantOwnedToken(supply.state.amount - released, curve.covenantId);
  const userNext = params.borrowThreshold === undefined
    ? userToken(released, buyer.xOnlyPubkey)
    : userToken(released, buyer.xOnlyPubkey, { borrowScheme: BORROW_AMOUNT_THRESHOLD, borrowGuard: thresholdGuard(params.borrowThreshold) });
  checkTokenFamily(T, [supply], [restNext, userNext], WITNESS_COVENANT);
  const curveNext: CurveState = { tokenCovId: curve.state.tokenCovId, lotsSold: curve.state.lotsSold + n, feeAccrued: curve.state.feeAccrued + quote.fee, phase: PHASE_ACTIVE };

  const plan: TxPlan = {
    name: `buy(${n})`,
    inputs: [
      curveInput(curve, `CURVE buy(${n}, user)`, budgetsOf(ctx).curveBuy, curveBuySigScript(ctx.curve, curve.program, n, kcc20Full(userNext, ctx.token.templateHash))),
      tokenLeaderCovenantInput(supply, [restNext, userNext], 'KCC20 supply cell (T leader, witness 00)', BUDGETS.tokenLeaderCovenant2Out),
      ...funding.map((u) => kasInput(u, 'buyer KAS')),
    ],
    outputs: [
      curveOutput(ctx, "CURVE'", curveNext, curve.value + quote.total, curve.covenantId, 0),
      tokenOutput(ctx, 'rest (owner C)', restNext, restValue, T, 1),
      tokenOutput(ctx, 'user cell', userNext, V, T, 1),
    ],
    residual: changeTo(p2pkScript(buyer.address), 'change (buyer)'),
    genesisGroups: [],
    payload: new Uint8Array(0),
    ...feeFields(params),
  };
  requireOwnLineages(plan, [curve.covenantId, T]);
  const s = finish(plan, ['curve', 'token-rest', 'token-user'], 'change');
  const allIn = quote.total + V + s.built.fee;
  assertAllIn(plan.name, allIn, s.built.fee, params.maxAllIn);
  return { ...s, quote, curveNext, restNext, userNext, allIn };
}
