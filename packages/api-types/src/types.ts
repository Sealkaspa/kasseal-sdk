/**
 * Domain types for the launchpad UI.
 *
 * These are launchpad-shaped, not indexer-shaped. Providers map their own wire
 * format onto these, so changing the data source never touches a screen.
 */

/** Where a token sits in its lifecycle. */
export type SalePhase =
  | 'bonding'     // trading on the curve
  | 'graduated'   // curve complete, terminal cell locked
  | 'listed'      // graduation consumed by a venue
  | 'unknown';    // indexed token with no launchpad sale we recognise

/** How confident we are that on-chain state matches the rules we claim. */
export type Verification =
  | 'verified'      // every transition checked against the rules
  | 'unvalidated'   // indexed but not fully proven
  | 'invalid';      // a rule violation was observed

/** A token's identity and declared metadata. */
export interface TokenMeta {
  /** KIP-20 covenant id — the token's permanent identity. */
  covenantId: string;
  /** Declared name. */
  name: string;
  /** Declared ticker. */
  ticker: string;
  /** Always 0: Kasseal templates count whole tokens on chain, so no amount is ever scaled. */
  decimals: number;
  /**
   * The `decimals` the token's declaration carries, present only when it is not 0: the declaration is free text
   * on chain, the templates are not. Reported, never applied; a wallet that scaled by it would show wrong amounts.
   */
  declaredDecimals?: number;
  /** The token image's URL; see `imageSource` before loading it. */
  imageUrl?: string;
  /**
   * Where `imageUrl` points, present whenever it is: `verified` is Kasseal's content-addressed image store
   * (`/v1/images/<sha256>`, the bytes checked against the declared hash); `external` is an https URL the creator
   * declared, which Kasseal never fetches or checks. Treat an external image as untrusted: do not load it unprompted.
   */
  imageSource?: 'verified' | 'external';
  /** Declared description. */
  description?: string;
  /** DAA score of the token's creation. */
  createdAtDaa?: number;
  /**
   * Kasseal hid this token's declared metadata (name, ticker, description, image) after a takedown request; the
   * token itself still trades and verifies. The UI shows a neutral "Hidden by Kasseal" label and no declared links.
   */
  hidden?: boolean;
}

/** A token's supply figures, in whole tokens. */
export interface TokenSupply {
  /** Total supply. */
  total: bigint;
  /** Tokens minted so far. */
  minted: bigint;
  /** Number of distinct holders. */
  holders: number;
  /**
   * True only when NO live cell can mint. This is the anti-rug guarantee and
   * must come from a source that tracked the token's lineage — never assumed.
   * `null` means the provider could not determine it.
   */
  supplyFixed: boolean | null;
}

/** Bonding-curve position. Prices are sompi; amounts are base units. */
export interface CurveState {
  lotsSold: number;
  curveLots: number;
  lotSize: bigint;
  /** Price of the next lot, in sompi. */
  nextLotPrice: bigint;
  /** KAS raised so far, in sompi. */
  raisedSompi: bigint;
  /** KAS raised at curve completion, in sompi. */
  targetSompi: bigint;
}

/** One trade on a token. */
export interface Trade {
  /** The transaction id. */
  txid: string;
  /** Buy or sell, from the trader's side. */
  side: 'buy' | 'sell';
  /** Lots traded. */
  lots: number;
  /** KAS moved, in sompi. */
  kasSompi: bigint;
  /** DAA score of the accepting block. */
  daaScore: number;
  /** Wall-clock time in milliseconds since the epoch, when known. */
  timeMs?: number;
  /** The trader's address, when known. */
  address?: string;
}

/** One holder of a token. */
export interface Holder {
  /** Display form: an address, `script:…`, or `covenant:…`. */
  owner: string;
  /** Whole tokens held. */
  balance: bigint;
  /** Number of token cells holding them. */
  cells: number;
}

/** A token as the launchpad shows it. */
export interface Token {
  /** Identity and declared metadata. */
  meta: TokenMeta;
  /** Supply figures. */
  supply: TokenSupply;
  /** Where the token sits in its lifecycle. */
  phase: SalePhase;
  /** How far its on-chain history has been checked. */
  verification: Verification;
  /**
   * Why `verification` is `invalid`, when the source can say (for example a
   * graduation whose pool genesis group bound more than the pool cell to the
   * pool id). Shown as-is; absent for verified and unvalidated tokens.
   */
  verificationReason?: string;
  /** Absent when the token is indexed but has no launchpad sale. */
  curve?: CurveState;
  /**
   * Market cap in sompi: the price per token × the total supply. On the curve the price is the next lot's; once the
   * pool is open, the pool's reserve ratio. Absent when there is no price (no sale, or a pool not open yet).
   */
  marketCapSompi?: bigint;
  /** Link out for independent on-chain verification. */
  explorerUrl?: string;
}

/** Filters and paging for `listTokens`. */
export interface TokenListQuery {
  /** Sort order. */
  sort?: 'new' | 'active' | 'progress' | 'holders' | 'mcap';
  /** Only tokens in this phase. */
  phase?: SalePhase;
  /** Free-text match on name or ticker. */
  search?: string;
  /** Page size. */
  limit?: number;
  /** The `nextCursor` of the previous page. */
  cursor?: string;
}

/** One page of `listTokens`. */
export interface TokenListPage {
  /** The tokens on this page. */
  tokens: Token[];
  /** Pass as `cursor` to fetch the next page; absent on the last page. */
  nextCursor?: string;
}

/** Parameters a creator supplies. Fee handling is provider-specific. */
export interface CreateTokenRequest {
  name: string;
  ticker: string;
  decimals: number;
  totalSupply: bigint;
  imageUrl?: string;
  description?: string;
}

/** A quote is advisory. The covenant enforces the real bounds on-chain. */
export interface TradeQuote {
  lots: number;
  /** Exact cost/proceeds before fee, in sompi. */
  kasSompi: bigint;
  feeSompi: bigint;
  totalSompi: bigint;
  /** Average price per lot, sompi. */
  avgLotPrice: bigint;
  /** Curve position after the trade. */
  lotsSoldAfter: number;
}
