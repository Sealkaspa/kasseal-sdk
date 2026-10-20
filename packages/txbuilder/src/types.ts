/**
 * Public builder types. Apps, wallet flows and API clients program against
 * these; `assemble.ts` and the shapes produce them.
 *
 * Units: `Sompi` amounts are sompi (1 KAS = 100,000,000 sompi); pool KAS legs
 * named `...Scaled` are in units of 0.01 KAS (1,000,000 sompi); token amounts
 * are whole tokens (decimals 0); `lots` are curve lots (1,000 tokens on the
 * current contracts).
 *
 * Notes:
 *   - `inputsToSign[].kind` includes `p2sh-delegator`: a consolidation's signed
 *     delegators carry a 65-byte signature slot at offset 1, which is neither a
 *     P2PK input nor a leader.
 *   - `OptimisticDelta` carries `genesis` and `terminated` for the singletons a
 *     transaction creates (tx01's curve, graduate's pool) or ends without a
 *     continuation (graduate's curve), and the continuation's KAS value
 *     (`amount`) on `curve` and `pool`, which a trade chained against the
 *     predicted head spends.
 *   - `BuildBuyParams.borrowInto` is refused: the deployed curve accepts no
 *     borrowed receive (see the field).
 */

import type { TokenState } from '@kasseal/codec';
import type { FundingUtxo, Outpoint } from './assemble.ts';
import type { Masses } from './mass.ts';
import type { CurveState, PoolCellState } from './program.ts';

/** An amount in sompi (1 KAS = 100,000,000 sompi). */
export type Sompi = bigint;

/* -------------------------------------------------------------------------- */
/* Cells and sources                                                           */
/* -------------------------------------------------------------------------- */

/** A covenant-bound UTXO with its decoded state. */
export interface CovenantCell<S = TokenState> {
  /** The cell's outpoint. */
  readonly outpoint: Outpoint;
  /** The cell's KAS value. */
  readonly amount: Sompi;
  /** The lineage's covenant id, hex. */
  readonly covenantId: string;
  /** R as served by the API; the builder asserts `p2shCommitsTo(utxo.spk, R)` before use. */
  readonly redeemScript: Uint8Array;
  /** Recomputed locally, never trusted from the wire. */
  readonly templateHash: string;
  /** The decoded state. */
  readonly state: S;
  /** Whether the cell is in an accepted block (false: in the mempool). */
  readonly confirmed: boolean;
}

/** The curve's current cell; `pending` when its creating transaction is not yet accepted. */
export interface CurveHead extends CovenantCell<CurveState> {
  readonly pending?: { readonly txid: string; readonly firstSeenMs: number };
}

/** Where the builder reads UTXOs and cells from (usually a Kaspa node plus the Kasseal API). */
export interface UtxoSources {
  /** Node `getUtxosByAddresses` minus the optimistic reserved set. */
  funding(address: string): Promise<FundingUtxo[]>;
  /** `GET /tokens/:id/cells`. */
  tokenCells(covenantId: string, ownerKey: string): Promise<CovenantCell[]>;
  /** The curve's supply and reserve token cells. */
  covenantCells(covenantId: string): Promise<{ supply: CovenantCell; reserve: CovenantCell }>;
  /** `GET /tokens/:id/curve-head`. */
  curveHead(covenantId: string): Promise<CurveHead>;
  /** The pool's current cell. */
  poolCell(poolId: string): Promise<CovenantCell<PoolCellState>>;
  /** `GET /fees`. */
  feerate(): Promise<bigint>;
}

/* -------------------------------------------------------------------------- */
/* Built transactions                                                          */
/* -------------------------------------------------------------------------- */

/** How an input is signed: a plain P2PK input, or a P2SH token input as leader or delegator. */
export type InputToSignKind = 'p2pk' | 'p2sh-leader' | 'p2sh-delegator';

/** An input the wallet must sign. */
export interface InputToSign {
  /** Input index. */
  readonly index: number;
  /** How it is signed. */
  readonly kind: InputToSignKind;
  /** The consensus sighash byte (SIGHASH_ALL), what `signPskt` takes; not the SDK enum ordinal. */
  readonly sighashType: 1;
  /** Offset of the 65-byte `sig64 || hashtype` slot in the prebuilt P2SH sigscript (113 for a sell leader). */
  readonly signatureOffset?: number;
}

/**
 * The role of a built output. The builders in this SDK produce the first row (`curve` .. `change`); the other roles
 * belong to transaction families that are not part of this SDK and are listed only so the type stays complete.
 */
export type OutputRole =
  | 'curve' | 'pool' | 'token-user' | 'token-rest' | 'token-reserve' | 'prep' | 'treasury' | 'creator' | 'payout' | 'change'
  | 'company' | 'vault' | 'deposit' | 'splitter'
  | 'order' | 'pot' | 'dist-key' | 'filler' | 'refund';

/** An unsigned transaction ready for the wallet, with everything needed to sign, finalize and track it. */
export interface BuiltTx {
  /** Kaspa SDK SafeJSON with `utxo.covenantId` patched in. */
  readonly txJson: string;
  /** KIP-24 txid; independent of budgets and sigscripts. */
  readonly txid: string;
  /** The transaction's masses. */
  readonly masses: Masses;
  /** The network fee paid. */
  readonly feeSompi: Sompi;
  /** The feerate it was built at, sompi per gram. */
  readonly feerate: bigint;
  /** The inputs the wallet signs. */
  readonly inputsToSign: readonly InputToSign[];
  /** BUDGETS table, applied after signing. */
  readonly budgets: readonly number[];
  /** Outpoints the transaction spends. */
  readonly consumes: readonly Outpoint[];
  /** What each output is. */
  readonly produces: readonly { readonly index: number; readonly role: OutputRole }[];
  /** The state change to apply optimistically once submitted. */
  readonly optimistic: OptimisticDelta;
}

/* -------------------------------------------------------------------------- */
/* Parameters                                                                  */
/* -------------------------------------------------------------------------- */

/** Token metadata for the KCC-23 declaration (field names as `kip24.ts` `TokenMetadata`). */
export interface CreateMetadata {
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly image?: string;
  readonly description?: string;
  readonly links?: Readonly<Record<string, string>>;
}

/** Parameters of a token launch (not part of the public SDK surface). */
export interface BuildCreateParams {
  /** Creator's P2PK address: funds both transactions and receives the prep outpoint and change. */
  readonly creator: string;
  readonly metadata: CreateMetadata;
  /** Committed curve preset name; must pass the factory gate. On mainnet only the Standard family. */
  readonly preset: string;
  /**
   * The contract set to launch on: `v1` (the default and only set: the curve graduates into the v1 pool, which takes
   * deposits and withdrawals once bound).
   */
  readonly contractSet?: 'v1';
  /**
   * A v1 revision to launch on instead of the network's launch build (`launchRevisionOf`): one of
   * the network's frozen or staged revisions (`v1RevisionsOn`). The app never passes it.
   */
  readonly revision?: string;
  readonly prepValue?: Sompi;
  readonly curveValue?: Sompi;
  /**
   * Explicit, recorded waiver of the factory gate (`checkFactoryParams`) for test presets that fail its
   * final-lot fee rule. Production creations never pass it.
   */
  readonly factoryGate?: { readonly skip: true; readonly reason: string };
  /**
   * The KAS/USD price the app showed when it picked the Standard band (`GET /v1/price/kas`: `usd`, `asOfMs`). A
   * Standard-family launch is refused unless the preset is the band for this price and the price is fresh
   * (`assertBandForPrice`); mainnet requires it.
   */
  readonly kasPrice?: KasPriceQuote;
}

/** A KAS/USD price and when it was taken (Unix ms), as `GET /v1/price/kas` serves it. */
export interface KasPriceQuote {
  /** USD per KAS. */
  readonly usd: number;
  /** When the price was taken, Unix milliseconds. */
  readonly asOfMs: number;
}

/** Parameters of a curve buy (`buildBuy`). */
export interface BuildBuyParams {
  /** The curve id C. */
  readonly covenantId: string;
  /**
   * The curve id C the caller's verified launch proof names: when given, a different
   * `covenantId` is refused (`CurveNotOfProof`) before anything is fetched or built.
   */
  readonly expectedCurveId?: string;
  /**
   * The token lineage T the caller is trading (the page's token id). The served curve head must name exactly this
   * lineage (`LineageMismatch` otherwise): an API cannot route the buy into another token's curve.
   */
  readonly tokenId?: string;
  /** The buyer's P2PK address: funds the buy and receives the change. */
  readonly buyer: string;
  /** x-only key the new or borrowed-into user cell is owned by (owner_scheme 0x00). */
  readonly buyerXOnlyPubkey: Uint8Array;
  /** Lots to buy (`lots * lot` tokens). */
  readonly lots: bigint;
  /**
   * The token's launch-proof verdict. Required: anything but `bound`, or a missing value, is refused
   * with `ProofNotBound` before any source is read.
   */
  readonly proofVerdict: LaunchProofVerdict;
  /** Pre-check against the quote only; not a covenant argument. */
  readonly maxKasIn?: Sompi;
  /**
   * The most KAS that may leave the wallet all-in: curve cost + curve fee + the user cell's deposit + the network
   * fee of the built transaction (`NetBoundExceeded` otherwise). What the page shows as "Max you'll pay".
   */
  readonly maxAllIn?: Sompi;
  /** Value of a new user cell (default 5 KAS; refused below 0.1 KAS). */
  readonly userCellValue?: Sompi;
  /**
   * Borrowed receive into an existing `borrow_scheme 0x01` cell. Refused with `ShapeNotSupported`: the deployed
   * curve's `buy` requires `OpCovInputCount(T) == 1` and a user output of exactly `n * lot`.
   */
  readonly borrowInto?: Outpoint;
}

/** Parameters of a curve sell (`buildSell`). */
export interface BuildSellParams {
  /** The curve id C. */
  readonly covenantId: string;
  /**
   * The curve id C the caller's verified launch proof names: when given, a different
   * `covenantId` is refused (`CurveNotOfProof`) before anything is fetched or built.
   */
  readonly expectedCurveId?: string;
  /** The token lineage T being sold; the served curve head must name it (`LineageMismatch` otherwise). */
  readonly tokenId?: string;
  /** The seller's P2PK address: receives the payout. */
  readonly seller: string;
  /** x-only key owning the token cell sold. */
  readonly sellerXOnlyPubkey: Uint8Array;
  /** The sell takes exactly `lots * LOT` from one cell (`OpCovOutputCount(T) == 1`). */
  readonly lots: bigint;
  /**
   * The token's launch-proof verdict. Required: anything but `bound`, or a missing value, is refused
   * with `ProofNotBound`, unless `allowUnboundExit` is set.
   */
  readonly proofVerdict: LaunchProofVerdict;
  /**
   * Explicit opt-in: sell even though the verdict is not `bound`, so a holder can always exit.
   * A sell is atomic against the curve program and takes nothing on trust from C's singleton; the risk the gate guards
   * against is paying into a curve whose supply may be moved, which a sell does not do. Never set it for a buy.
   */
  readonly allowUnboundExit?: boolean;
  /** Pre-check against the quote only. */
  readonly minKasOut?: Sompi;
  /**
   * The least KAS that may reach the wallet net: the payout minus any top-up input, i.e. the cell's deposit + the
   * refund - the network fee of the built transaction (`NetBoundExceeded` otherwise). What the page shows as "Min
   * you'll get".
   */
  readonly minNetOut?: Sompi;
  /**
   * The exact token amount the user approved: refused (`TokenAmountMismatch`) unless
   * `lots * lot` of the committed curve template equals it. The app always passes it.
   */
  readonly expectedTokens?: bigint;
}

/** Parameters of a pool swap (`buildSwap`). */
export interface BuildSwapParams {
  /** The pool id P. */
  readonly poolId: string;
  /**
   * The pool id the caller's verified launch proof recomputes from the token's graduation (step 9):
   * when given, a different `poolId` is refused (`PoolNotOfProof`) before anything is fetched or built.
   */
  readonly expectedPoolId?: string;
  /** The token lineage T of the pool; the served pool cell must name it (`LineageMismatch` otherwise). */
  readonly tokenId?: string;
  /** The trader's P2PK address: funding, payout and change. */
  readonly trader: string;
  /** x-only key owning the trader's token cells. */
  readonly traderXOnlyPubkey: Uint8Array;
  /** `kas->tok` buys tokens with KAS; `tok->kas` sells tokens for KAS. */
  readonly side: 'kas->tok' | 'tok->kas';
  /** `kas->tok`: legs of 0.01 KAS (`kasInScaled`); `tok->kas`: token base units (`tokensIn`, one exact cell). */
  readonly amountIn: bigint;
  /** Pre-check against the quote only (tokens for `kas->tok`, 0.01 KAS units for `tok->kas`). */
  readonly minOut?: bigint;
  /** `kas->tok`: the most KAS that may leave the wallet all-in (KAS leg + user cell deposit + network fee). */
  readonly maxAllIn?: Sompi;
  /** `tok->kas`: the least KAS that may reach the wallet net (payout minus any top-up input). */
  readonly minNetOut?: Sompi;
  /**
   * The token's launch-proof verdict: a `kas->tok` swap is refused (`ProofNotBound`) unless it
   * is `bound`, like a curve buy; a `tok->kas` swap is never gated, so a holder can always leave.
   */
  readonly proofVerdict?: LaunchProofVerdict;
  /**
   * `tok->kas` on a composable pool (`v1-kasseal-mainnet-2`): one more of the trader's own cells sold in the same swap
   * (no merge first). `amountIn` is the amount of the leading cell; the swap sells both.
   */
  readonly extraCell?: Outpoint;
  /**
   * `kas->tok` on a composable pool: swap-and-deposit into a cell owned by this script, funding its P2SH with
   * `scriptFunding` sompi. The redeem script must be key-locked (`<x-only key> OP_CHECKSIG`) unless `allowAnyScript`
   * is set: tokens delivered to any other script may be unrecoverable.
   */
  readonly deliverToScript?: { readonly redeem: Uint8Array; readonly scriptFunding: Sompi; readonly allowAnyScript?: boolean };
}

/**
 * A sell of a cell owned by a script (scheme 0x03) on a composable pool, authorized by spending a UTXO at that script's
 * P2SH address, whose redeem script is `<signer x-only key> OP_CHECKSIG` (a router's or a vault's sell).
 */
export interface BuildScriptSellParams {
  /** The pool id P. */
  readonly poolId: string;
  /** The pool id the caller's verified launch proof names; a different `poolId` is refused (`PoolNotOfProof`). */
  readonly expectedPoolId?: string;
  /** The token lineage T; the served pool cell must name it. */
  readonly tokenId?: string;
  /** The P2PK address the released KAS go to. */
  readonly payout: string;
  /** The script's redeem script. */
  readonly redeem: Uint8Array;
  /** The x-only key that signs for the script. */
  readonly signerXOnly: Uint8Array;
  /** The script's P2SH address (its UTXOs are the authority inputs); must be P2SH(redeem). */
  readonly scriptAddress: string;
  /** Accept a redeem script other than `<signerXOnly> OP_CHECKSIG` (refused by default). */
  readonly allowAnyScript?: boolean;
}

/** Parameters of `buildConsolidate`: merge a holder's token cells. */
export interface BuildConsolidateParams {
  /** The token lineage id T. */
  readonly covenantId: string;
  /** The holder's P2PK address: funding and change. */
  readonly owner: string;
  /** x-only key owning the cells. */
  readonly ownerXOnlyPubkey: Uint8Array;
  /** Stop once a single cell of at least this amount exists; all cells when omitted. */
  readonly target?: bigint;
}

/** Parameters of `buildSplit`: carve an exact amount out of one token cell. */
export interface BuildSplitParams {
  /** The token lineage id T. */
  readonly covenantId: string;
  /** The holder's P2PK address: funding and change. */
  readonly owner: string;
  /** x-only key owning the cell. */
  readonly ownerXOnlyPubkey: Uint8Array;
  /** The cell to split. */
  readonly cell: Outpoint;
  /** Amount of the carved cell; the rest stays in a second cell of the same owner. */
  readonly carve: bigint;
}

/** The reserve fields a quote was computed on, for the ratio-drift guard on rebuilds (`shapes/liquidity.ts`). */
export interface QuotedReserves {
  /** KAS reserve, 0.01 KAS units. */
  readonly kasScaled: bigint;
  /** Token reserve, whole tokens. */
  readonly tokenReserve: bigint;
}

/** `addLiquidity` on a bound v1 pool. */
export interface BuildAddLiquidityParams {
  /** The pool id P. */
  readonly poolId: string;
  /**
   * The pool id the caller's verified launch proof recomputes from the token's graduation (step 9):
   * when given, a different `poolId` is refused (`PoolNotOfProof`) before anything is fetched or built.
   */
  readonly expectedPoolId?: string;
  /** The token lineage T of the pool; the served pool cell must name it (`LineageMismatch` otherwise). */
  readonly tokenId?: string;
  /** The depositor's P2PK address: funding and change. */
  readonly depositor: string;
  /** x-only key owning the depositor's T cell and the new LP cell. */
  readonly depositorXOnlyPubkey: Uint8Array;
  /** LP shares to mint. */
  readonly shares: bigint;
  /**
   * The Kasseal API's invariant monitor's verdict on this pool, read at build time (`sum of L cells == LP_SUPPLY`,
   * inventory equation, one P-owned cell per lineage). A deposit is refused (`LpUnsafe`, carrying
   * `lpSafeReason`) unless it is `true`; withdrawals never need it.
   */
  readonly lpSafe: boolean;
  /** The monitor's reason when `lpSafe` is false, surfaced by the refusal. */
  readonly lpSafeReason?: string;
  /** Value of the new LP cell (default 5 KAS, least 2.5 KAS). */
  readonly lpCellValue?: Sompi;
  /** The reserves the user's quote was computed on; the build is refused (`RatioDriftError`) when the live ratio moved 1 % or more. */
  readonly quoted?: QuotedReserves;
  /** The most KAS that may leave the wallet all-in (KAS leg + LP cell funding beyond the absorbed cell + network fee). */
  readonly maxAllIn?: Sompi;
}

/** `removeLiquidity` on a bound v1 pool. */
export interface BuildRemoveLiquidityParams {
  /** The pool id P. */
  readonly poolId: string;
  /**
   * The pool id the caller's verified launch proof recomputes from the token's graduation (step 9):
   * when given, a different `poolId` is refused (`PoolNotOfProof`) before anything is fetched or built.
   */
  readonly expectedPoolId?: string;
  /** The token lineage T of the pool; the served pool cell must name it (`LineageMismatch` otherwise). */
  readonly tokenId?: string;
  /** The withdrawer's P2PK address: the payout, and top-up funding when needed. */
  readonly withdrawer: string;
  /** x-only key owning the withdrawer's L cells and the new token cell. */
  readonly withdrawerXOnlyPubkey: Uint8Array;
  /** LP shares to redeem. */
  readonly shares: bigint;
  /** Pre-check against the quote in 0.01 KAS units (the unit of the KAS leg); the covenant has `PAYOUT_MIN` only. */
  readonly minKasOut?: bigint;
  /** Pre-check against the quote on the token leg. */
  readonly minTokOut?: bigint;
  /** Value of the new token cell (default: the absorbed L cell's value, at most 5 KAS). */
  readonly tokCellValue?: Sompi;
  /** The reserves the user's quote was computed on; the build is refused (`RatioDriftError`) when the live ratio moved 1 % or more. */
  readonly quoted?: QuotedReserves;
  /** The least KAS that may reach the wallet net (payout minus any top-up input). */
  readonly minNetOut?: Sompi;
}

/** A deposit or withdrawal with the splits and merges that precede it, in submission order, before any signature. */
export interface LiquidityPlanBuilt {
  /** The transactions, in submission order. */
  readonly transactions: BuiltTx[];
  /** Network fees of all of them. */
  readonly totalFeeSompi: Sompi;
  /** LP shares deposited or withdrawn. */
  readonly shares: bigint;
  /** The KAS leg in 0.01 KAS units. */
  readonly dKasScaled: bigint;
  /** The token leg. */
  readonly dTok: bigint;
  /** A one-line description for display. */
  readonly summary: string;
}

/** `POST /v1/registrations` bodies: the curve part before tx01, the token part once tx2 is built. */
export interface RegistrationPayload {
  readonly expectedCurveId: string;
  /** Hex. */
  readonly curveTemplate: { readonly prefix: string; readonly suffix: string };
  readonly params: Readonly<Record<string, string | number>>;
  /** The treasury, `version || script`, hex. */
  readonly treasurySpk?: string;
  /** The contract set of the curve template. */
  readonly contractSet?: 'v1';
  readonly creatorSpk: string;
  /** KCC-23 payload `0x00 || I-JSON`, hex. */
  readonly declaration: string;
  readonly expectedTokenId: string;
  /** Genesis token states in output order, `tokenStateToJson` form. */
  readonly genesisStates: readonly Readonly<Record<string, string | number>>[];
}

/* -------------------------------------------------------------------------- */
/* Builder                                                                     */
/* -------------------------------------------------------------------------- */

/** The transaction builder `createTxBuilder` returns. Every method builds unsigned transactions; nothing is submitted. */
export interface TxBuilder {
  /** Build a token launch (tx01 and tx2) and its registration payload. */
  buildCreate(p: BuildCreateParams): Promise<{ prepAndCurveGenesis: BuiltTx; tokenGenesisInit: BuiltTx; registration: RegistrationPayload }>;
  /** A curve buy. Throws `ProofNotBound` unless `proofVerdict` is `bound`. */
  buildBuy(p: BuildBuyParams): Promise<BuiltTx>;
  /** Throws `ProofNotBound` (unless `bound` or `allowUnboundExit`), `NeedsConsolidation` | `NeedsSplit`: a sell takes exactly n * LOT. */
  buildSell(p: BuildSellParams): Promise<BuiltTx>;
  /** A pool swap, kas->tok or tok->kas; KAS legs in 0.01 KAS units. */
  buildSwap(p: BuildSwapParams): Promise<BuiltTx>;
  /** A sell of a script-owned cell on a composable pool, authorized by the script's UTXO (`BuildScriptSellParams`). */
  buildScriptSell(p: BuildScriptSellParams): Promise<BuiltTx>;
  /** At most 3 cells per transaction, chained. */
  buildConsolidate(p: BuildConsolidateParams): Promise<BuiltTx[]>;
  /** 1 -> 2 to carve exactly n * LOT. */
  buildSplit(p: BuildSplitParams): Promise<BuiltTx>;
  /** Graduation. Always includes the empty supply cell; `keepSupplyDeposit` pays its 10 KAS to the funder's change. */
  buildGraduate(p: { covenantId: string; funder: string; keepSupplyDeposit?: boolean }): Promise<BuiltTx>;
  /**
   * Graduation and, on a pool with liquidity entries (v1), its `bindLp` at once: the bind
   * spends graduate's pool output and change while graduate is pending. Submit `graduate` first, then `bind`.
   */
  buildGraduateAndBind(p: { covenantId: string; funder: string; keepSupplyDeposit?: boolean }): Promise<{ graduate: BuiltTx; bind?: BuiltTx }>;
  /** Fee sweep of a curve or a pool (pays the accrued fees to the treasury and the creator). */
  buildSweep(p: { covenantId: string; venue: 'curve' | 'pool'; funder: string }): Promise<BuiltTx>;
  /** Splice P2SH signatures, set budgets, `finalize()`, assert the txid unchanged. */
  finalize(built: BuiltTx, signed: string): Promise<BuiltTx>;
  /** Pure; the same code path as build. */
  estimate(built: BuiltTx): { masses: Masses; feeSompi: Sompi };
}

/**
 * The launch-proof verdict of a token, as the caller established it: `verifyLaunchProof(...).status` run in the caller's
 * own process (the app's in-browser check), or the Kasseal API's verdict when the caller has nothing better. `malformed`
 * is a bundle that does not parse. Only `bound` proves that tx01 bound C to its curve output alone.
 */
export type LaunchProofVerdict = 'bound' | 'unverified' | 'invalid' | 'malformed';

/**
 * A curve trade was asked on a token whose launch proof is not `bound`. "Exactly one UTXO
 * carries C" is proven only by the launch proof (step 5): a creator who adds a second C-bound output to tx01 can move
 * the curve-owned supply and reserve through covenant presence without the curve program running. The builder
 * therefore refuses buys, and sells unless the caller opts into an exit (`allowUnboundExit`), when the verdict is
 * anything but `bound`, including when it is missing.
 */
export class ProofNotBound extends Error {
  /** The verdict supplied, or `undefined` when none was. */
  readonly verdict: string | undefined;
  /** The refused operation. */
  readonly operation: string;
  constructor(operation: string, verdict: unknown) {
    const v = typeof verdict === 'string' ? verdict : undefined;
    super(`${operation} refused: the token's launch proof is ${v === undefined ? 'not supplied' : `'${v}'`}, not 'bound'; C's singleton is proven only by the launch proof`);
    this.name = 'ProofNotBound';
    this.verdict = v;
    this.operation = operation;
  }
}

/** The deployed covenants cannot accept the requested shape; the message names the constraint. */
export class ShapeNotSupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShapeNotSupported';
  }
}

/** The served venue (curve head or pool cell) names a token lineage other than the one the caller is trading. */
export class LineageMismatch extends Error {
  /** The lineage the caller is trading. */
  readonly expected: string;
  /** The lineage the served venue names. */
  readonly actual: string;
  constructor(venue: string, expected: string, actual: string) {
    super(`${venue} names token lineage ${actual}, the order is for ${expected}: refused`);
    this.name = 'LineageMismatch';
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * A curve sell would take another number of tokens than the caller approved: `lots` whole
 * lots of the committed template's `lot` differ from `expectedTokens`, which happens when the lots were sized with a
 * lot size the API served instead of the program's. Nothing is built.
 */
export class TokenAmountMismatch extends Error {
  /** Tokens the caller approved. */
  readonly expected: bigint;
  /** Tokens the sell would take. */
  readonly actual: bigint;
  constructor(op: string, expected: bigint, actual: bigint) {
    super(`${op} would take ${actual} tokens (whole lots of the curve program), the order approved ${expected}: refused`);
    this.name = 'TokenAmountMismatch';
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * The served curve program instantiates no committed preset of a contract set the builder knows (v1 and its frozen
 * revisions): a lineage of another build is not traded in the app. Pools are recognised
 * by their own template.
 */
export class UnknownCurveTemplate extends Error {
  constructor(detail = 'curve program matches no known curve template') {
    super(detail);
    this.name = 'UnknownCurveTemplate';
  }
}

/**
 * A curve-owned token cell (supply or reserve) is served with a KAS value below the curve's `tokenCellKas`. The
 * covenant refuses such an output, so the served amount cannot be the cell's real value: the build stops
 * here instead of signing a transaction built on it.
 */
export class CovenantCellValue extends Error {
  /** Which cell. */
  readonly cell: string;
  /** The served value, sompi. */
  readonly value: bigint;
  /** The curve's token cell value, sompi. */
  readonly minimum: bigint;
  constructor(cell: string, value: bigint, minimum: bigint) {
    super(`${cell}: served value ${value} sompi is below the curve's token cell value ${minimum}; refused`);
    this.name = 'CovenantCellValue';
    this.cell = cell;
    this.value = value;
    this.minimum = minimum;
  }
}

/** A deposit was asked on a pool the Kasseal API's invariant monitor does not confirm (`lpSafe` not `true`). */
export class LpUnsafe extends Error {
  /** The monitor's reason, when given. */
  readonly reason: string | undefined;
  constructor(reason?: string) {
    super(`deposit refused: the indexer does not confirm this pool's LP invariants${reason === undefined ? '' : ` (${reason})`}`);
    this.name = 'LpUnsafe';
    this.reason = reason;
  }
}

/**
 * The curve id asked for is not the C the caller's verified launch proof names: a served
 * curve head of another lineage (a cell of the real template created in a state it never reached, under a compromised
 * API) is refused before anything is fetched or built.
 */
export class CurveNotOfProof extends Error {
  /** The curve id asked for. */
  readonly curveId: string;
  /** The curve id the launch proof names. */
  readonly expectedCurveId: string;
  constructor(curveId: string, expectedCurveId: string) {
    super(`curve ${curveId} is not the curve ${expectedCurveId} the launch proof names`);
    this.name = 'CurveNotOfProof';
    this.curveId = curveId;
    this.expectedCurveId = expectedCurveId;
  }
}

/**
 * The pool id asked for is not the one the caller's verified launch proof recomputes from the token's graduation
 * a served pool id that names another pool (a counterfeit of the real template, under a
 * compromised API) is refused before anything is fetched or built.
 */
export class PoolNotOfProof extends Error {
  /** The pool id asked for. */
  readonly poolId: string;
  /** The pool id the launch proof recomputes. */
  readonly expectedPoolId: string;
  constructor(poolId: string, expectedPoolId: string) {
    super(`pool ${poolId} is not the pool ${expectedPoolId} the launch proof recomputes from the graduation`);
    this.name = 'PoolNotOfProof';
    this.poolId = poolId;
    this.expectedPoolId = expectedPoolId;
  }
}

/**
 * The built transaction's all-in cost or net payout is outside the bound the caller showed the user: the venue
 * amount passed its own pre-check, so what moved is the network fee or the deposit, not the price.
 */
export class NetBoundExceeded extends Error {
  /** Which bound: the most to pay (`all-in`) or the least to receive (`net-out`). */
  readonly kind: 'all-in' | 'net-out';
  /** The built transaction's figure, sompi. */
  readonly actual: bigint;
  /** The bound shown to the user, sompi. */
  readonly bound: bigint;
  /** The network fee, sompi. */
  readonly feeSompi: bigint;
  constructor(tx: string, kind: 'all-in' | 'net-out', actual: bigint, bound: bigint, feeSompi: bigint) {
    super(kind === 'all-in'
      ? `${tx}: ${actual} sompi would leave the wallet (network fee ${feeSompi}), above the ${bound} shown as the most to pay`
      : `${tx}: ${actual} sompi would reach the wallet net (network fee ${feeSompi}), below the ${bound} shown as the least to receive`);
    this.name = 'NetBoundExceeded';
    this.kind = kind;
    this.actual = actual;
    this.bound = bound;
    this.feeSompi = feeSompi;
  }
}

/** A sell or token->KAS swap needs one cell of the exact amount; these cells merge (at most 3 per transaction) into it. */
export class NeedsConsolidation extends Error {
  /** The cells to merge. */
  readonly cells: readonly Outpoint[];
  /** How many consolidation transactions that takes. */
  readonly transactions: number;
  constructor(cells: readonly Outpoint[], transactions: number) {
    super(`needs ${transactions} consolidation transaction(s) over ${cells.length} cells first`);
    this.name = 'NeedsConsolidation';
    this.cells = cells;
    this.transactions = transactions;
  }
}

/** A sell or token->KAS swap needs one cell of the exact amount; this larger cell is split first. */
export class NeedsSplit extends Error {
  /** The cell to split. */
  readonly cell: Outpoint;
  /** Tokens to carve out of it. */
  readonly carve: bigint;
  constructor(cell: Outpoint, carve: bigint) {
    super(`needs a split of ${cell.txid}:${cell.index} carving ${carve} first`);
    this.name = 'NeedsSplit';
    this.cell = cell;
    this.carve = carve;
  }
}

/* -------------------------------------------------------------------------- */
/* Submission                                                                  */
/* -------------------------------------------------------------------------- */

/** Where a submitted transaction stands. */
export type SubmitState =
  | { kind: 'built' } | { kind: 'signed' } | { kind: 'submitted'; txid: string; at: number }
  | { kind: 'accepted'; txid: string; acceptingBlueScore: number }
  | { kind: 'confirmed'; txid: string; depth: number }
  | { kind: 'fee-too-low'; txid: string; requiredSompi: bigint; bucket: 'compute' | 'transient' | 'storage' }
  | { kind: 'budget-too-low'; txid: string; inputIndex: number; used: number; limit: number }
  | { kind: 'lost-race'; txid: string; winnerTxid?: string; cause: 'mempool-spent' | 'orphan' }
  | { kind: 'already-in-mempool'; txid: string }
  /** A `require` failed; never retried. */
  | { kind: 'script-failed'; txid: string }
  | { kind: 'replaced'; oldTxid: string; newTxid: string }
  | { kind: 'failed'; reason: string };

/* -------------------------------------------------------------------------- */
/* Optimistic delta                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What a transaction does to the state the app tracks, applied on `submitted`, committed on `accepted` and rolled
 * back on `lost-race` / `failed`. `curve` and `pool` describe a singleton's transition to its continuation; the two
 * lifecycle edges that have no continuation on one side are carried separately:
 * `genesis` for a singleton born in the transaction (tx01's curve, graduate's pool) and `terminated` for one consumed
 * without a successor (graduate's curve). `cells` covers every token cell, user- or covenant-owned; `amount` is the
 * cell's KAS value. `funding.reserved` lists the P2PK outpoints the selector must skip until the transaction settles:
 * the ones it spends and, for tx01, the prep outpoint that tx2 spends. `funding.change` is the P2PK output returned to
 * the signer (change, or a sell's payout), which a chained transaction may spend. `curve.amount` / `pool.amount` is
 * the continuation's KAS value, the input amount of a trade chained against the predicted head.
 */
export interface OptimisticDelta {
  readonly curve?: { covenantId: string; fromOutpoint: Outpoint; toOutpoint: Outpoint; state: CurveState; amount: Sompi };
  readonly pool?: { poolId: string; fromOutpoint: Outpoint; toOutpoint: Outpoint; state: PoolCellState; amount: Sompi };
  readonly cells: { consumed: Outpoint[]; produced: { outpoint: Outpoint; state: TokenState; amount: Sompi }[] };
  readonly funding: { reserved: Outpoint[]; change?: { outpoint: Outpoint; amount: Sompi } };
  readonly genesis?: readonly LineageGenesis[];
  readonly terminated?: readonly LineageTermination[];
}

/** A curve or pool singleton born in a transaction. */
export type LineageGenesis =
  | { readonly kind: 'curve'; readonly covenantId: string; readonly outpoint: Outpoint; readonly state: CurveState; readonly amount: Sompi }
  | { readonly kind: 'pool'; readonly covenantId: string; readonly outpoint: Outpoint; readonly state: PoolCellState; readonly amount: Sompi };

/** A curve or pool singleton consumed without a successor. */
export interface LineageTermination {
  readonly kind: 'curve' | 'pool';
  readonly covenantId: string;
  readonly outpoint: Outpoint;
}
