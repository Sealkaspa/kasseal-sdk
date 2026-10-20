/**
 * Display rules for creator-supplied token text.
 *
 * A KCC-23 declaration is any I-JSON object: its `name`, `symbol` and `description` are whatever the creator wrote,
 * and a launch built outside the Kasseal app is not held to the app's form rules (ticker `[A-Z0-9]{2,8}`). The chain
 * keeps the bytes; these helpers decide what a screen shows and how two tickers are compared. Nothing here changes a
 * declaration, the token's identity (its covenant id) or a stored row.
 *
 * - `displayText`: drops characters that are invisible or reorder text (C0/C1 controls, zero-width characters, the
 *   bidirectional embeddings, overrides, isolates and marks, fillers), so a name cannot hide part of itself or appear
 *   in a different order than it is stored. Letters of every script stay: Chinese, Arabic or emoji names are shown as
 *   written.
 * - `tickerSkeleton`: the form two tickers are compared in for the "same ticker" mark: NFKC (full-width letters become
 *   ASCII), the display rules, no `$` or spaces, upper case, and Cyrillic and Greek capitals that look like Latin
 *   letters mapped to those letters, so `KAS` spelled with Cyrillic letters and `KAS` count as the same ticker; Latin
 *   diacritics are dropped and negative circled or squared letters read as their letter.
 */

/** Controls, zero-width and bidirectional formatting characters, fillers (each removed from displayed text). */
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB]|\uDB40[\uDC00-\uDC7F\uDD00-\uDDEF]|\uD834[\uDD73-\uDD7A]/g;

/** Creator text as screens show it: invisible and reordering characters removed, runs of whitespace collapsed, trimmed. */
export function displayText(raw: string): string {
  return raw.replace(/\s+/gu, ' ').replace(INVISIBLE, '').replace(/ {2,}/g, ' ').trim();
}

/** Cyrillic and Greek capitals (after upper-casing) that render like a Latin capital. */
const CONFUSABLE: Readonly<Record<string, string>> = {
  // Cyrillic
  '\u0410': 'A', // Cyrillic Capital Letter A
  '\u0412': 'B', // Cyrillic Capital Letter Ve
  '\u0415': 'E', // Cyrillic Capital Letter Ie
  '\u0401': 'E', // Cyrillic Capital Letter Io
  '\u041A': 'K', // Cyrillic Capital Letter Ka
  '\u041C': 'M', // Cyrillic Capital Letter Em
  '\u041D': 'H', // Cyrillic Capital Letter En
  '\u041E': 'O', // Cyrillic Capital Letter O
  '\u0420': 'P', // Cyrillic Capital Letter Er
  '\u0421': 'C', // Cyrillic Capital Letter Es
  '\u0422': 'T', // Cyrillic Capital Letter Te
  '\u0423': 'Y', // Cyrillic Capital Letter U
  '\u0425': 'X', // Cyrillic Capital Letter Ha
  '\u0405': 'S', // Cyrillic Capital Letter Dze
  '\u0406': 'I', // Cyrillic Capital Letter Byelorussian-Ukrainian I
  '\u0407': 'I', // Cyrillic Capital Letter Yi
  '\u0408': 'J', // Cyrillic Capital Letter Je
  '\u051A': 'Q', // Cyrillic Capital Letter Qa
  '\u051C': 'W', // Cyrillic Capital Letter We
  '\u04AE': 'Y', // Cyrillic Capital Letter Straight U
  '\u04BA': 'H', // Cyrillic Capital Letter Shha
  '\u04C0': 'I', // Cyrillic Letter Palochka
  // Armenian capitals that render like Latin capitals
  '\u054F': 'S', // Armenian Capital Letter Tiwn
  '\u0555': 'O', // Armenian Capital Letter Oh
  // Greek
  '\u0391': 'A', // Greek Capital Letter Alpha
  '\u0392': 'B', // Greek Capital Letter Beta
  '\u0395': 'E', // Greek Capital Letter Epsilon
  '\u0396': 'Z', // Greek Capital Letter Zeta
  '\u0397': 'H', // Greek Capital Letter Eta
  '\u0399': 'I', // Greek Capital Letter Iota
  '\u039A': 'K', // Greek Capital Letter Kappa
  '\u039C': 'M', // Greek Capital Letter Mu
  '\u039D': 'N', // Greek Capital Letter Nu
  '\u039F': 'O', // Greek Capital Letter Omicron
  '\u03A1': 'P', // Greek Capital Letter Rho
  '\u03A4': 'T', // Greek Capital Letter Tau
  '\u03A5': 'Y', // Greek Capital Letter Upsilon
  '\u03A7': 'X', // Greek Capital Letter Chi
  // Cherokee capitals that render like Latin capitals
  '\u13AA': 'A', '\u13F4': 'B', '\u13DF': 'C', '\u13A0': 'D', '\u13AC': 'E', '\u13C0': 'G', '\u13BB': 'H', '\u13A5': 'I', '\u13AB': 'J',
  '\u13E6': 'K', '\u13DE': 'L', '\u13B7': 'M', '\u13A2': 'T', '\u13DA': 'S', '\u13D2': 'R', '\u13D9': 'V', '\u13B3': 'W', '\u13C3': 'Z',
  '\u13E2': 'P',
  // Lisu letters (uppercase-shaped Latin look-alikes)
  '\uA4EE': 'A', '\uA4D0': 'B', '\uA4DA': 'C', '\uA4D3': 'D', '\uA4F0': 'E', '\uA4DD': 'F', '\uA4D6': 'G', '\uA4E7': 'H', '\uA4F2': 'I',
  '\uA4D9': 'J', '\uA4D7': 'K', '\uA4E1': 'L', '\uA4DF': 'M', '\uA4E0': 'N', '\uA4F3': 'O', '\uA4D1': 'P', '\uA4E3': 'R', '\uA4E2': 'S',
  '\uA4D4': 'T', '\uA4F4': 'U', '\uA4E6': 'V', '\uA4EA': 'W', '\uA4EB': 'X', '\uA4EC': 'Y', '\uA4DC': 'Z',
  // Latin small capitals (toUpperCase leaves them as they are)
  '\u1D00': 'A', '\u0299': 'B', '\u1D04': 'C', '\u1D05': 'D', '\u1D07': 'E', '\uA730': 'F', '\u0262': 'G', '\u029C': 'H', '\u026A': 'I',
  '\u1D0A': 'J', '\u1D0B': 'K', '\u029F': 'L', '\u1D0D': 'M', '\u0274': 'N', '\u1D0F': 'O', '\u1D18': 'P', '\u0280': 'R', '\uA731': 'S',
  '\uA7AE': 'I', '\u01A6': 'R', '\u1D1B': 'T', '\u1D1C': 'U', '\u1D20': 'V', '\u1D21': 'W', '\u028F': 'Y', '\u1D22': 'Z',
};

/**
 * Characters that show nothing after a letter but survive `displayText` (emoji names need some of them): variation
 * selectors (VS1-16 and the supplement VS17-256), the Braille blank and the musical formatting controls. Removed from
 * the comparison form only (otherwise `KAS` + U+FE0F would escape a "same ticker" check).
 */
const SKELETON_IGNORED = /[\uFE00-\uFE0F\u2800]|\uDB40[\uDD00-\uDDEF]|\uD834[\uDD73-\uDD7A]/g;

/**
 * Latin diacritics (the combining diacritical marks and their extensions and supplement, and the marks for symbols):
 * removed from the comparison form after decomposition, so `ḲAS` or `K̲AS`, whose marks barely show at ticker size,
 * compare as `KAS`. Marks of other scripts (Thai, Devanagari, ...) are kept: they are letters
 * there, not decoration.
 */
const LATIN_MARKS = /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF]/g;

/** Negative circled (U+1F150..1F169) and negative squared (U+1F170..1F189) Latin capitals, which NFKC leaves as they are. */
function negativeLetter(cp: number): string | undefined {
  if (cp >= 0x1f150 && cp <= 0x1f169) return String.fromCharCode(65 + cp - 0x1f150);
  if (cp >= 0x1f170 && cp <= 0x1f189) return String.fromCharCode(65 + cp - 0x1f170);
  return undefined;
}

/** The comparison form of a ticker (see the module comment); `''` for a ticker with no visible character. */
export function tickerSkeleton(raw: string): string {
  const s = displayText(raw.normalize('NFKC')).normalize('NFD').replace(LATIN_MARKS, '').normalize('NFC')
    .replace(SKELETON_IGNORED, '').replace(/[$\s]/g, '').toUpperCase();
  let out = '';
  for (const ch of s) out += CONFUSABLE[ch] ?? negativeLetter(ch.codePointAt(0)!) ?? ch;
  return out;
}

/** True when `raw` holds a character `displayText` removes (shown as a warning next to the text). */
export function hasHiddenCharacters(raw: string): boolean {
  INVISIBLE.lastIndex = 0;
  const found = INVISIBLE.test(raw);
  INVISIBLE.lastIndex = 0;
  return found;
}
