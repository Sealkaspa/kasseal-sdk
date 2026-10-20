/**
 * Profit and loss of a position: the one definition the Kasseal leaderboard and app both compute with, so a trader's
 * figure is the same everywhere (realised plus unrealised at the current price).
 *
 * Cash of a trade (what left or reached the wallet for the tokens, from the indexed trade row alone; the decoders
 * write a curve row as the curve amount with the curve fee beside it, a pool row as the user's own KAS leg):
 *
 *   curve buy    kasSompi + feeSompi   (the curve amount, the curve fee on top)
 *   curve sell   kasSompi − feeSompi   (the curve amount, the curve fee taken)
 *   pool buy     kasSompi              (the gross KAS put in, the pool fee inside it)
 *   pool sell    kasSompi              (the KAS paid out, the pool fee already taken)
 *
 * A pool row's `feeSompi` is only the platform part of the 0.30 % pool fee; the whole fee is already inside
 * `kasSompi`, so adding or taking it again would cost the trade twice.
 *
 * Average cost: a buy adds its tokens and cash to the open position; a sell takes tokens out at the running average
 * cost and books `proceeds − cost` as realised. A full close takes the whole remaining cost. Tokens sold beyond the
 * bought tokens still open came in another way (a transfer): their cost is unknown, so neither their proceeds nor a
 * cost enters P&L. Held tokens beyond the open bought ones have no known cost either and are left out; nothing is
 * ever guessed.
 *
 * Unrealised P&L values the held tokens whose cost is known at the current price before selling (the mark), minus
 * their average cost. The current price is the curve's next lot while the curve sells, the pool's reserve ratio once
 * the pool is open, and nothing in between (no market: unvalued). What selling would return after the fee and the
 * price impact is a different, smaller figure; the app shows it as "if sold now", never as the P&L.
 */
import { KAS_SCALE } from './pool.ts';

/** The price unit of the app and the API: sompi per this many token base units. */
export const PRICE_UNIT_TOKENS = 1_000_000n;

/** Which way a trade went, from the trader's side. */
export type TradeSide = 'buy' | 'sell';
/** Where a trade executed: the bonding curve or the graduated pool. */
export type TradeVenue = 'curve' | 'pool';

/** KAS that left the wallet (buy) or reached it (sell) for the tokens of one indexed trade row. */
export function tradeCash(side: TradeSide, venue: TradeVenue, kasSompi: bigint, feeSompi: bigint): bigint {
  if (venue === 'pool') return kasSompi;
  return side === 'buy' ? kasSompi + feeSompi : kasSompi - feeSompi;
}

/** The average-cost state of one wallet in one token. */
export interface AvgCost {
  /** Bought tokens still open (not yet sold), the ones whose cost is known. */
  readonly open: bigint;
  /** Average-cost basis of `open`. */
  readonly openCost: bigint;
  /** Proceeds of sells of bought tokens minus their average cost at the time. */
  readonly realized: bigint;
  /** Cost basis the realised P&L was booked against. */
  readonly realizedCost: bigint;
  /** Tokens sold with no known cost (more sold than bought and open at the time). */
  readonly unknownSold: bigint;
  /** Proceeds of those tokens, left out of P&L. */
  readonly unknownProceeds: bigint;
}

/** The average-cost state of a wallet with no trades. */
export const EMPTY_AVG_COST: AvgCost = { open: 0n, openCost: 0n, realized: 0n, realizedCost: 0n, unknownSold: 0n, unknownProceeds: 0n };

/** One trade folded into the position: `amount` tokens for `cash` sompi (`tradeCash`). A zero amount changes nothing. */
export function avgCostStep(p: AvgCost, side: TradeSide, amount: bigint, cash: bigint): AvgCost {
  if (amount <= 0n) return p;
  if (side === 'buy') return { ...p, open: p.open + amount, openCost: p.openCost + cash };
  const matched = amount < p.open ? amount : p.open;
  let { open, openCost, realized, realizedCost, unknownSold, unknownProceeds } = p;
  let matchedProceeds = 0n;
  if (matched > 0n) {
    // A full close takes the whole remaining cost (no rounding residue survives into a re-entry).
    const cost = matched === open ? openCost : (openCost * matched) / open;
    matchedProceeds = matched === amount ? cash : (cash * matched) / amount;
    realized += matchedProceeds - cost;
    realizedCost += cost;
    open -= matched;
    openCost -= cost;
  }
  if (amount > matched) {
    unknownSold += amount - matched;
    unknownProceeds += cash - matchedProceeds;
  }
  return { open, openCost, realized, realizedCost, unknownSold, unknownProceeds };
}

/**
 * The held tokens whose cost is known and their cost: at most the open bought tokens. Fewer held than open (tokens
 * sent away without a trade) keeps the average cost of what is left.
 */
export function costedHeld(p: Pick<AvgCost, 'open' | 'openCost'>, held: bigint): { costed: bigint; cost: bigint } {
  const h = held > 0n ? held : 0n;
  const costed = h < p.open ? h : p.open;
  const cost = costed === 0n ? 0n : costed === p.open ? p.openCost : (p.openCost * costed) / p.open;
  return { costed, cost };
}

/** Current price of a curve that is selling: its next lot (`p0 + k × lotsSold`) per `PRICE_UNIT_TOKENS`; null for no lot size. */
export function curvePricePerMillion(p0: bigint, k: bigint, lotsSold: bigint, lotSize: bigint): bigint | null {
  if (lotSize <= 0n) return null;
  return ((p0 + k * lotsSold) * PRICE_UNIT_TOKENS) / lotSize;
}

/** Current price of an open pool: its reserve ratio per `PRICE_UNIT_TOKENS` (`kasScaled` is 0.01 KAS); null for an empty side. */
export function poolPricePerMillionOf(kasScaled: bigint, tokenReserve: bigint): bigint | null {
  if (tokenReserve <= 0n || kasScaled <= 0n) return null;
  return (kasScaled * KAS_SCALE * PRICE_UNIT_TOKENS) / tokenReserve;
}

/** `tokens` at the current price (sompi per `PRICE_UNIT_TOKENS`). */
export function markValue(tokens: bigint, priceM: bigint): bigint {
  return (tokens * priceM) / PRICE_UNIT_TOKENS;
}

/**
 * The value of the costed part of a holding at the current price: the whole holding's mark value, scaled to the
 * costed share (`costed / held`), so the costed and uncosted parts always add up to the holding's value.
 */
export function costedMarkValue(held: bigint, costed: bigint, priceM: bigint): bigint {
  if (held <= 0n || costed <= 0n) return 0n;
  const whole = markValue(held, priceM);
  return costed === held ? whole : (whole * costed) / held;
}
