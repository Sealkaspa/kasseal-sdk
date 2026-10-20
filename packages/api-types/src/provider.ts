/**
 * The swap boundary.
 *
 * No screen should call an RPC, an API or a wallet directly. Everything goes
 * through DataProvider, so the data source (a public explorer API, the Kasseal
 * API, or a future execution layer) can change without touching UI code.
 */

import type {
  CreateTokenRequest, Holder, Token, TokenListPage, TokenListQuery, Trade, TradeQuote,
} from './types.ts';

/** A source of launchpad data (and optionally a way to trade). Amounts are bigint sompi or whole tokens. */
export interface DataProvider {
  /** Short id shown in the UI so it is always obvious where data came from. */
  readonly id: string;
  /** Human-readable source, e.g. "kascov · testnet-10". */
  readonly label: string;
  /** False for read-only sources; the UI hides actions it cannot perform. */
  readonly canWrite: boolean;

  /** One page of tokens, filtered and sorted by `q`. */
  listTokens(q?: TokenListQuery): Promise<TokenListPage>;
  /** One token by its covenant id, or `null` when the source does not know it. */
  getToken(covenantId: string): Promise<Token | null>;
  /** The token's most recent trades, newest first. */
  getTrades(covenantId: string, limit?: number): Promise<Trade[]>;
  /** The token's largest holders. */
  getHolders(covenantId: string, limit?: number): Promise<Holder[]>;

  /** Pure curve math; safe to call on every keystroke. */
  quoteBuy(covenantId: string, lots: number): Promise<TradeQuote>;
  /** Pure curve math for a sell of `lots` lots. */
  quoteSell(covenantId: string, lots: number): Promise<TradeQuote>;

  /** Write paths. Providers without `canWrite` must throw NotSupported. */
  createToken?(req: CreateTokenRequest): Promise<{ covenantId: string; txid: string }>;
  submitBuy?(covenantId: string, lots: number, maxKasSompi: bigint): Promise<{ txid: string }>;
  submitSell?(covenantId: string, lots: number, minKasSompi: bigint): Promise<{ txid: string }>;
}

/** Thrown by a provider asked for an operation it does not offer (for example a write on a read-only source). */
export class NotSupported extends Error {
  constructor(op: string, provider: string) {
    super(`${op} is not supported by the "${provider}" data source`);
    this.name = 'NotSupported';
  }
}
