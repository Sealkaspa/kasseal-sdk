/**
 * sell(n), the curve sell:
 *
 *   in0   KCC20 user cell (T leader)      transfer([merged], 00 || sig65)   the wallet signs this P2SH input
 *   in1   KCC20 supply cell (T delegator) transfer_delegator(empty)
 *   in2   CURVE (C)                       sell(n)
 *   [in3.. seller KAS, only when the cell value plus the refund cannot cover the fee and the payout floor]
 *   out0  merged   binding (0, T)          owner C, supply + n * lot, value = the supply cell's
 *   out1  CURVE'   binding (2, C)          value = in - refund + fee
 *   out2  payout   P2PK(seller)            user cell value + refund - fee - tx fee, >= 0.0201 KAS
 *
 * The deployed `sell(int n)` requires `OpCovOutputCount(T) == 1`: there is no
 * change record, so the leader cell must hold exactly `n * lot`. A holder
 * without such a cell gets `NeedsSplit` or `NeedsConsolidation` from the
 * selection layer (select/planner.ts) before this function is reached; this
 * function refuses any other amount.
 *
 * Refused (`ProofNotBound`) unless the launch-proof verdict is `bound` or the
 * caller opts into an exit (`allowUnboundExit`).
 */

import { sellQuote, type Quote } from '@kasseal/curve-math';
import type { TokenState } from '@kasseal/codec';
import { p2pkScript, type CurveCell, type FundingUtxo, type TokenCell, type TxPlan } from '../assemble.ts';
import { budgetsOf, curveInput, curveOutput, kasInput, payoutTo, tokenDelegatorCovenantInput, tokenLeaderSignedInput, tokenOutput, type BuilderContext } from '../cells.ts';
import { signedLeaderBudget } from '../mass.ts';
import { PHASE_ACTIVE, covenantOwnedToken, type CurveState } from '../program.ts';
import { curveSellSigScript } from '../sigscript.ts';
import { TokenAmountMismatch, type LaunchProofVerdict } from '../types.ts';
import {
  MIN_PAYOUT, WITNESS_SIGNED, assertNetOut, checkTokenFamily, curveOwnedCellValue, feeFields, finish, fundingSum, requireActiveCurve, requireLineage, requireProofBound, requireSupplyCell, requireUserCell,
  type FeeOptions, type Shaped, requireOwnLineages,
} from './common.ts';
import { launchPresetOf } from './create.ts';

/** Who sells: the address that receives the payout. */
export interface Seller {
  /** P2PK address that receives the payout. */
  readonly address: string;
}

/** Inputs of `buildSell`: the verified curve, its supply cell and the seller's exact cell. */
export interface SellParams extends FeeOptions {
  /** The network's builder context. */
  readonly ctx: BuilderContext;
  /** The curve cell. */
  readonly curve: CurveCell;
  /** The curve-owned supply cell. */
  readonly supply: TokenCell;
  /** The seller's cell; must hold exactly `n * lot` (the contract takes no change record). */
  readonly userCell: TokenCell;
  /** Who sells. */
  readonly seller: Seller;
  /** Lots to sell. */
  readonly n: bigint;
  /** The token's launch-proof verdict; anything but `bound` is refused (`ProofNotBound`) unless `allowUnboundExit`. */
  readonly proofVerdict: LaunchProofVerdict;
  /** Explicit opt-in to sell whatever the verdict: a holder can always exit (see `requireProofBound`). */
  readonly allowUnboundExit?: boolean;
  /** Extra KAS when the user cell plus the refund cannot cover the fee and the payout floor. */
  readonly funding?: readonly FundingUtxo[];
  /** Builder pre-check: refuse when the quoted net refund (sompi) is lower. */
  readonly minKasOut?: bigint;
  /** The token lineage being sold; the curve must name it (`LineageMismatch`). */
  readonly tokenId?: string;
  /** Refuse (`NetBoundExceeded`) when `netOut` (the payout minus any top-up input) is below it: the "Min you'll get" the page showed. */
  readonly minNetOut?: bigint;
  /** The exact token amount the caller approved: refused (`TokenAmountMismatch`) unless `n * lot` equals it. */
  readonly expectedTokens?: bigint;
}

/** The built sell and its predicted successor states. */
export interface SellResult extends Shaped {
  /** The curve quote (sompi). */
  readonly quote: Quote;
  /** The curve's predicted state. */
  readonly curveNext: CurveState;
  /** The merged supply cell's predicted state. */
  readonly mergedNext: TokenState;
  /** Net payout the seller receives: user cell KAS + refund - curve fee - tx fee (+ any top-up). */
  readonly payout: bigint;
  /** What the seller gains: the payout minus the top-up KAS the wallet put in (`cell value + quote.total - fee`). */
  readonly netOut: bigint;
}

/** Quote and covenant pre-checks shared with the asynchronous builder. */
export function sellPrecheck(ctx: BuilderContext, curve: CurveCell, n: bigint, minKasOut?: bigint): Quote {
  if (n <= 0n || n > curve.state.lotsSold) throw new Error(`cannot sell ${n} lots with ${curve.state.lotsSold} sold`);
  // Refuses a net refund below the contract's 0.1 KAS PAYOUT_MIN (SellPayoutTooSmallError), as curve.sil does.
  const quote = sellQuote(launchPresetOf(ctx.curve).curve, curve.state.lotsSold, n);
  if (minKasOut !== undefined && quote.total < minKasOut) throw new Error(`quote ${quote.total} is below minKasOut ${minKasOut}`);
  return quote;
}

/**
 * Build a curve sell of `n` lots. Refuses (throws) a verdict other than `bound` without `allowUnboundExit`, a user cell
 * that does not hold exactly `n * lot`, a quote below `minKasOut`, and a net payout below `minNetOut`.
 */
export function buildSell(params: SellParams): SellResult {
  const { ctx, curve, supply, userCell, seller, n } = params;
  const p = ctx.curve.params;
  requireProofBound(`sell(${n})`, params.proofVerdict, params.allowUnboundExit === true);
  requireActiveCurve(ctx, curve);
  requireLineage(`curve ${curve.covenantId}`, curve.state.tokenCovId, params.tokenId);
  const T = requireSupplyCell(ctx, curve, supply);
  requireUserCell(userCell, T, curve.covenantId);
  if (params.expectedTokens !== undefined && n * p.lot !== params.expectedTokens) throw new TokenAmountMismatch(`sell(${n})`, params.expectedTokens, n * p.lot);
  const quote = sellPrecheck(ctx, curve, n, params.minKasOut);
  if (userCell.state.amount !== n * p.lot) throw new Error(`user cell holds ${userCell.state.amount} tokens, sell(${n}) needs exactly ${n * p.lot}; consolidate or split first`);

  const mergedValue = curveOwnedCellValue(ctx, [{ cell: supply, name: 'supply' }]);
  const mergedNext = covenantOwnedToken(supply.state.amount + n * p.lot, curve.covenantId);
  checkTokenFamily(T, [userCell, supply], [mergedNext], WITNESS_SIGNED);
  const curveNext: CurveState = { tokenCovId: curve.state.tokenCovId, lotsSold: curve.state.lotsSold - n, feeAccrued: curve.state.feeAccrued + quote.fee, phase: PHASE_ACTIVE };
  const plan: TxPlan = {
    name: `sell(${n})`,
    inputs: [
      tokenLeaderSignedInput(userCell, [mergedNext], 'KCC20 user cell (T leader, 00 || sig)', signedLeaderBudget(2, 1)),
      tokenDelegatorCovenantInput(supply, 'KCC20 supply cell (T delegator, empty witness)'),
      curveInput(curve, `CURVE sell(${n})`, budgetsOf(ctx).curveSell, curveSellSigScript(ctx.curve, curve.program, n)),
      ...(params.funding ?? []).map((u) => kasInput(u, 'seller KAS (top-up)')),
    ],
    outputs: [
      tokenOutput(ctx, 'merged (owner C)', mergedNext, mergedValue, T, 0),
      curveOutput(ctx, "CURVE'", curveNext, curve.value - quote.cost + quote.fee, curve.covenantId, 2),
    ],
    residual: payoutTo(p2pkScript(seller.address), 'payout (seller)', MIN_PAYOUT),
    genesisGroups: [],
    payload: new Uint8Array(0),
    ...feeFields(params),
  };
  requireOwnLineages(plan, [curve.covenantId, T]);
  const s = finish(plan, ['token-rest', 'curve'], 'payout');
  const netOut = s.built.residualValue - fundingSum(params.funding);
  assertNetOut(plan.name, netOut, s.built.fee, params.minNetOut);
  return { ...s, quote, curveNext, mergedNext, payout: s.built.residualValue, netOut };
}
