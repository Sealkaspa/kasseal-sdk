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
  | 'invalid'       // a rule violation was observed
  | 'external';     // another launchpad's token and contract (`Token.venue`): Kasseal checks the pinned pool, not the rules; never Sealed

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
  /** Time of the token's creation (the accepting block's timestamp), milliseconds since the epoch; with `createdAtDaa`. */
  createdAtMs?: number;
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
  /** Every accepted trade of the token, both venues, all time (the Trades figure). Absent from a source that does not count them. */
  trades?: number;
  /** Link out for independent on-chain verification. */
  explorerUrl?: string;
  /** The token's locks: what is locked and when it next unlocks. Absent when it has none. */
  locks?: TokenLocks;
  /**
   * Who fills the token's trades when it is not Kasseal: an outside pool (an imported coin). Absent for every Kasseal
   * token. A token with a venue has `verification` `external`, no `curve`, and phase `listed`.
   */
  venue?: ExternalVenue;
}

/**
 * An outside pool that fills an imported coin's swaps. Only a pool Kasseal pinned can appear here; the ids are
 * lowercase hex covenant ids.
 */
export interface ExternalVenue {
  kind: 'external';
  /** Who runs the pool, as named in the UI. */
  operator: string;
  /** The pool's covenant id. */
  poolId: string;
  /** The token's covenant id (equal to `Token.meta.covenantId`). */
  tokenId: string;
  /** `stopped`: the pool changed in a way the pin does not recognise; no trade is built until the owner restarts it. */
  status: 'live' | 'stopped';
  /** Why the venue stopped, when it has. */
  stoppedReason?: string;
  /**
   * The pool's live state as Kasseal's indexer proved it from its own node, absent until it proved one. The price is
   * the reserve ratio; `Token.marketCapSompi` is it times the supply.
   */
  pool?: ExternalVenuePool;
  /**
   * Block time (ms) from which Kasseal recorded the venue's trades: its trade list, candles and volume begin here
   * ("history from <date>"); trades before it are not on Kasseal's node. Absent until the indexer started following it.
   */
  historyFromMs?: number;
  /**
   * True only while the holder figures are proven complete (every live cell found on Kasseal's node, adding up to the
   * supply with no minter). False or absent: `supply.holders` is 0 and the holder list empty, and neither is to be shown.
   */
  holdersProven?: boolean;
}

/** An outside pool's live state (`ExternalVenue.pool`). */
export interface ExternalVenuePool {
  /** KAS in the pool, in sompi (the pool cell's value). */
  kasReserveSompi: bigint;
  /** Tokens in the pool's reserve cell, in base units. */
  tokenReserve: bigint;
  /** Sompi per whole token: floor(kasReserveSompi / tokenReserve). */
  priceSompi: bigint;
  /** The pool cell's outpoint (the head the next trade spends). */
  txid: string;
  index: number;
  /** Block time (ms) of the transaction that left this state. */
  timeMs: number;
}

/** A token's locks at a glance (cards and the token header); `GET /tokens/{id}/locks` has the list. */
export interface TokenLocks {
  /** Locks of the token (or of its pool's LP shares) still holding anything. */
  active: number;
  /** Tokens still held by the token's active locks (LP-share locks not included). */
  lockedTokens: bigint;
  /** `lockedTokens` over the total supply, basis points (floor). */
  lockedBps: number;
  /** Of `lockedTokens`, what locks made by the token's creator hold. */
  creatorLockedTokens: bigint;
  /** A lock made by the token's creator, at least 0.05 % of supply, 7 days to 5 years, not finished, on a bound token. */
  creatorBadge: boolean;
  /** When the earliest unpaid release of an active token lock is due (Unix ms; may be past: claimable); null without one. */
  nextUnlockMs: number | null;
  /** LP shares held by active locks of the token's pool's LP-share lineage. */
  lpLockedShares: bigint;
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
