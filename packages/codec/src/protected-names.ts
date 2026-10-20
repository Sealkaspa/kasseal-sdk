/**
 * Protected names and tickers.
 *
 * Anyone can launch a KCC-20 token with any name and ticker, and the chain keeps the declaration forever. A token whose
 * name or ticker reads as one of the assets below (Kaspa's KAS, a stablecoin, Bitcoin, Ether) is not
 * refused: the app shows a warning naming the asset it is not ("Not Kaspa's KAS"), and the API and the app keep it off
 * the featured surfaces (Leading the Pod). It still appears in every list and in search, with the warning.
 *
 * Matching is by `tickerSkeleton` (display-text.ts), so a Cyrillic or Greek look-alike, a full-width letter, a `$`,
 * spaces or a zero-width character do not escape it:
 *
 * - the ticker matches when its skeleton equals any word of an asset;
 * - the whole name matches the same way (`Kaspa`, `K A S`, `Tether USD`);
 * - a single word of the name matches only for words marked `inName: 'word'`, the ones with no innocent use in a
 *   meme name (`USDT Kaspa`); short words that are common inside other names (KAS, ETH) match the whole name only,
 *   so `kaspalegend` is not flagged.
 *
 * Kasseal's own name (KASSEAL, SEAL) is not on this list; both are reserved instead (`RESERVED_TICKERS` below): no one
 * but the company wallet launches them on Kasseal, and no warning tag is shown.
 *
 * Tokens that genuinely are Kasseal's (the company's own token) are listed by covenant id per network in
 * `OFFICIAL_TOKEN_IDS` and are never warned about or excluded.
 */
import { displayText, tickerSkeleton } from './display-text.ts';

/** The asset a protected word stands for; screens word their warning by it. */
export type ProtectedAssetId = 'kas' | 'wkas' | 'usdt' | 'usdc' | 'btc' | 'eth' | 'krc20';

/** One protected word. */
export interface ProtectedWord {
  /** The word in skeleton form (upper-case ASCII, no spaces). */
  readonly word: string;
  /** `exact`: the ticker or the whole name; `word`: also any single word of the name. */
  readonly inName: 'exact' | 'word';
}

/** A protected asset and the words that stand for it. */
export interface ProtectedAsset {
  /** The asset. */
  readonly id: ProtectedAssetId;
  /** Its words, in skeleton form. */
  readonly words: readonly ProtectedWord[];
}

const exact = (word: string): ProtectedWord => ({ word, inName: 'exact' });
const anyWord = (word: string): ProtectedWord => ({ word, inName: 'word' });

/** The protected list, checked in this order. */
export const PROTECTED_ASSETS: readonly ProtectedAsset[] = [
  { id: 'kas', words: [exact('KAS'), exact('KASPA')] },
  { id: 'wkas', words: [anyWord('WKAS'), exact('WRAPPEDKAS'), exact('WRAPPEDKASPA')] },
  { id: 'usdt', words: [anyWord('USDT'), anyWord('TETHER'), exact('TETHERUSD')] },
  { id: 'usdc', words: [anyWord('USDC'), exact('USDCOIN')] },
  { id: 'btc', words: [exact('BTC'), exact('BITCOIN')] },
  { id: 'eth', words: [exact('ETH'), exact('ETHER'), exact('ETHEREUM')] },
];

/**
 * Extension point: well-known KRC-20 tickers to protect as well (matched on the ticker and the whole name, warned as
 * "Not the KRC-20 token …"). Empty on purpose: there is no curated KRC-20 list yet, and one should come from a
 * maintained source (for example Kasplex's reserved tickers, `tickReserved` in go-krc20d's `deploy.lua`), written in skeleton
 * form (upper-case ASCII). Tickers already in `PROTECTED_ASSETS` need not be repeated.
 */
export const KRC20_PROTECTED_TICKERS: readonly string[] = [];

/**
 * Tokens that are Kasseal's own, by network id (`testnet-10`, `mainnet`) and covenant id (64 lower-case hex): no
 * warning, no exclusion.
 *
 * - testnet-10: the two `$SEAL` (name `KasSeal`) launches whose curve creator is the company wallet
 *   `kaspatest:qp8pqkcf0w8l3mke93eu86ngyc808x54t574a8jha96nu63x8tfn2et7nk35w` (see `GET /v1/creators/{address}`).
 * - mainnet: empty until the mainnet Kasseal token launches.
 */
export const OFFICIAL_TOKEN_IDS: Readonly<Record<string, readonly string[]>> = {
  'testnet-10': [
    '74be7f497c717557f7dded69e1859611940e3c09a8624bb308300971b4392490',
    '3e7bea27021ac337fc27e5cce0aaa8841b2b48666ac1d96901c37a2916f33b8a',
  ],
  // Filled with the mainnet Kasseal token's covenant id once it launches.
  mainnet: [],
};

/** Which protected asset a token's ticker or name reads as. */
export interface ProtectedMatch {
  /** The asset it reads as. */
  readonly asset: ProtectedAssetId;
  /** The protected word that matched (skeleton form). */
  readonly word: string;
  /** Which field matched. */
  readonly field: 'ticker' | 'name';
}

/** The name split into words (on anything that is not a letter, mark or digit), each in skeleton form. */
function nameWords(name: string): string[] {
  return displayText(name.normalize('NFKC'))
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .map(tickerSkeleton)
    .filter((w) => w !== '');
}

/** The protected asset a name or ticker reads as, whoever launched it; null when none. The ticker is checked first. */
export function protectedMatch(meta: { readonly name: string; readonly ticker: string }): ProtectedMatch | null {
  const ticker = tickerSkeleton(meta.ticker);
  const whole = tickerSkeleton(meta.name);
  const words = nameWords(meta.name);
  for (const field of ['ticker', 'name'] as const) {
    for (const a of PROTECTED_ASSETS) {
      for (const w of a.words) {
        const hit = field === 'ticker' ? ticker === w.word : whole === w.word || (w.inName === 'word' && words.includes(w.word));
        if (hit) return { asset: a.id, word: w.word, field };
      }
    }
    for (const k of KRC20_PROTECTED_TICKERS) {
      if ((field === 'ticker' ? ticker : whole) === k) return { asset: 'krc20', word: k, field };
    }
  }
  return null;
}

/** Whether `covenantId` is one of Kasseal's own tokens on `network`. */
export function isOfficialToken(network: string, covenantId: string): boolean {
  return (OFFICIAL_TOKEN_IDS[network] ?? []).includes(covenantId.toLowerCase());
}

/**
 * What a screen warns about and featuring skips: the protected match of a token that is not on the network's official
 * list; null for an ordinary token or an official one.
 */
export function protectedNameOf(
  network: string, meta: { readonly covenantId: string; readonly name: string; readonly ticker: string },
): ProtectedMatch | null {
  if (isOfficialToken(network, meta.covenantId)) return null;
  return protectedMatch(meta);
}

/**
 * Reserved tickers: Kasseal does not launch a token whose ticker, or whose whole name, reads as one
 * of these. Unlike the warning list above this refuses: the Create screen and the builder's `buildCreate` both check
 * it. The contracts do not (they are frozen and the chain accepts any declaration), so a token launched outside
 * Kasseal can still carry one; it keeps the warning above where one applies.
 *
 * Matching is by `tickerSkeleton`, like the warning list: `$ВТС` (Cyrillic) or `b t c` is `BTC`. A name is refused only
 * when the whole of it is a reserved word (`Kaspa`, `Bitcoin`); `Kaspa Frog` is not.
 */
export const RESERVED_TICKERS: readonly string[] = [
  // Well-known KRC-20 tokens.
  'NACHO', 'ZEAL', 'KASPY', 'KANGO', 'BURT', 'GHOAD', 'KEIRO', 'KASPER', 'KONAN', 'KREX', 'KROAK',
  // Major coins, wrapped coins and stablecoins.
  'KAS', 'KASPA', 'WKAS', 'BTC', 'XBT', 'ETH', 'WETH', 'WBTC', 'SOL', 'BNB', 'XRP', 'DOGE', 'LTC', 'BCH', 'ADA', 'TRX',
  'TON', 'AVAX', 'DOT', 'MATIC', 'POL', 'LINK', 'SHIB', 'XMR', 'ETC', 'XLM', 'ATOM', 'SUI', 'APT', 'NEAR', 'HBAR',
  'USDT', 'USDC', 'TETHER',
  // Kasseal's own (reserved rather than warned about); see below.
  'SEAL', 'KASSEAL',
];

/** The reserved words only Kasseal's company wallet may launch. */
export const KASSEAL_RESERVED: readonly string[] = ['SEAL', 'KASSEAL'];

/** Kasseal's company wallet per network: the one creator allowed to launch `KASSEAL_RESERVED` (the curves' treasury). */
export const COMPANY_ADDRESSES: Readonly<Record<string, string>> = {
  'testnet-10': 'kaspatest:qp8pqkcf0w8l3mke93eu86ngyc808x54t574a8jha96nu63x8tfn2et7nk35w',
  mainnet: 'kaspa:qrt0p8sd5g8k383mzxgqtyl7ehkdez8ds8cpxqcuwjdaayke9rjhg9pqnr3zx',
};

/** Which reserved word a launch's ticker or name reads as. */
export interface ReservedMatch {
  /** The reserved word that matched (skeleton form). */
  readonly word: string;
  /** Which field matched. */
  readonly field: 'ticker' | 'name';
}

/**
 * The reserved word a launch's ticker or whole name reads as, or null when it may launch. `creatorAddress` is the
 * launching wallet: Kasseal's company wallet on `network` may use `SEAL` and `KASSEAL`, and nothing else on the list.
 */
export function reservedNameOf(
  network: string, meta: { readonly name: string; readonly ticker: string }, creatorAddress?: string,
): ReservedMatch | null {
  const company = creatorAddress !== undefined && COMPANY_ADDRESSES[network] === creatorAddress.trim().toLowerCase();
  const allowed = (w: string): boolean => company && KASSEAL_RESERVED.includes(w);
  const ticker = tickerSkeleton(meta.ticker);
  const whole = tickerSkeleton(meta.name);
  for (const [field, value] of [['ticker', ticker], ['name', whole]] as const) {
    if (RESERVED_TICKERS.includes(value) && !allowed(value)) return { word: value, field };
  }
  return null;
}
