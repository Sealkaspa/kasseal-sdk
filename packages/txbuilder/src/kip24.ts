/**
 * KIP-24 version-1 transaction id (implemented in `@kasseal/codec` `kip24.ts`,
 * re-exported here) and KCC-23 metadata declarations.
 *
 * KIP-24 (biryukovmaxim/kips@028117f): `txid = TransactionV1Id(PayloadDigest(payload)
 * || TransactionRest(rest))` with keyed BLAKE3 (key = ASCII domain right-padded
 * to 32 bytes); the rest preimage is
 *   u16 version || u64 n_in || (txid32 || u32 index || u64 0 || u64 sequence)*
 *   || u64 n_out || (u64 value || u16 spk_version || u64 len || spk || bool has_covenant
 *   [|| u16 authorizing_input || id32])* || u64 lock_time || subnetwork20 || u64 gas || u64 0
 * with empty sigscripts, no payload, no masses and no compute budgets. Equal to
 * the node-echoed txid and the Kaspa SDK's `Transaction.id` on testnet-10
 * submissions, and to the KCC-23 conformance vector.
 *
 * KCC-23 (Manyfestation/kccs@d51721a): the preparation transaction's payload is
 * `0x00 || UTF-8 I-JSON object` (RFC 7493: unique member names, finite numbers,
 * no lone surrogates, nesting at most 64, no BOM, object root). `JSON.parse`
 * accepts duplicate names and non-finite numbers, so the verifier parses itself.
 *
 * `PlainTx` is the SDK-independent transaction form used by the proof bundle
 * and the ledgers; `plainTxFromSdk` extracts it from an SDK transaction.
 */

import { concat, type PlainTx } from '@kasseal/codec';
import type { SdkTransaction } from './sdk.ts';

export {
  NATIVE_SUBNETWORK_ID, ZERO_PAYLOAD_DIGEST, payloadDigest, plainTxFromJson, plainTxToJson, restPreimage, txidV1,
  type PlainInput, type PlainOutput, type PlainTx, type TxidV1,
} from '@kasseal/codec';

/** Extract the plain form of an SDK transaction (after `finalize()`). */
export function plainTxFromSdk(tx: SdkTransaction): PlainTx {
  return {
    version: tx.version,
    inputs: tx.inputs.map((i) => ({
      transactionId: i.previousOutpoint.transactionId,
      index: i.previousOutpoint.index,
      sequence: i.sequence,
      signatureScript: i.signatureScript ?? '',
      computeBudget: i.computeBudget,
    })),
    outputs: tx.outputs.map((o) => ({
      value: o.value,
      scriptVersion: o.scriptPublicKey.version,
      script: o.scriptPublicKey.script,
      covenant: o.covenant ? { authorizingInput: o.covenant.authorizingInput, covenantId: o.covenant.covenantId.toString() } : null,
    })),
    lockTime: tx.lockTime,
    subnetworkId: tx.subnetworkId,
    gas: tx.gas,
    payload: tx.payload,
  };
}

/* -------------------------------------------------------------------------- */
/* KCC-23 declarations                                                         */
/* -------------------------------------------------------------------------- */

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

/** Strict I-JSON (RFC 7493) parser for one value. Throws on any violation. */
export function parseIJSON(text: string, { maxDepth = 64 }: { maxDepth?: number } = {}): unknown {
  let at = 0;
  const err = (m: string): never => { throw new Error(`I-JSON: ${m} at ${at}`); };
  const ws = (): void => { while (at < text.length && ' \t\n\r'.includes(text[at]!)) at++; };
  const str = (): string => {
    at++;
    let s = '';
    for (;;) {
      if (at >= text.length) err('unterminated string');
      const c = text[at++]!;
      if (c === '"') break;
      if (c === '\\') {
        const e = text[at++];
        if (e === 'u') {
          const h = text.slice(at, at + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) err('bad \\u escape');
          s += String.fromCharCode(parseInt(h, 16));
          at += 4;
        } else {
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (e === undefined || !(e in map)) err(`bad escape \\${e}`);
          s += map[e!]!;
        }
      } else {
        if (c.charCodeAt(0) < 0x20) err('control character in string');
        s += c;
      }
    }
    if (hasLoneSurrogate(s)) err('string contains a lone surrogate');
    return s;
  };
  const value = (depth: number): unknown => {
    ws();
    const c = text[at];
    if (c === '{') {
      if (depth > maxDepth) err(`nesting deeper than ${maxDepth}`);
      at++;
      const o: Record<string, unknown> = {};
      const seen = new Set<string>();
      ws();
      if (text[at] === '}') { at++; return o; }
      for (;;) {
        ws();
        if (text[at] !== '"') err('expected member name');
        const k = str();
        if (seen.has(k)) err(`duplicate member name "${k}"`);
        seen.add(k);
        ws();
        if (text[at] !== ':') err('expected ":"');
        at++;
        // Own, enumerable property even for names such as "__proto__".
        Object.defineProperty(o, k, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        ws();
        if (text[at] === ',') { at++; continue; }
        if (text[at] === '}') { at++; return o; }
        err('expected "," or "}"');
      }
    }
    if (c === '[') {
      if (depth > maxDepth) err(`nesting deeper than ${maxDepth}`);
      at++;
      const a: unknown[] = [];
      ws();
      if (text[at] === ']') { at++; return a; }
      for (;;) {
        a.push(value(depth + 1));
        ws();
        if (text[at] === ',') { at++; continue; }
        if (text[at] === ']') { at++; return a; }
        err('expected "," or "]"');
      }
    }
    if (c === '"') return str();
    if (text.startsWith('true', at)) { at += 4; return true; }
    if (text.startsWith('false', at)) { at += 5; return false; }
    if (text.startsWith('null', at)) { at += 4; return null; }
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(at));
    if (!m) err('unexpected character');
    at += m![0].length;
    const n = Number(m![0]);
    if (!Number.isFinite(n)) err(`number ${m![0]} is not a finite binary64`);
    return n;
  };
  const v = value(1);
  ws();
  if (at !== text.length) err('trailing characters');
  return v;
}

/** The result of `decodeDeclaration`: the parsed object and text, or why the payload is not a declaration. */
export type Declaration =
  | { readonly valid: true; readonly object: Record<string, unknown>; readonly text: string }
  | { readonly valid: false; readonly reason: string; readonly text?: string };

/** KCC-23 section 3.1: decode `0x00 || UTF-8 I-JSON object`. */
export function decodeDeclaration(payload: Uint8Array): Declaration {
  if (payload.length === 0) return { valid: false, reason: 'empty payload (no codec prefix)' };
  if (payload[0] !== 0x00) return { valid: false, reason: `unknown codec prefix 0x${payload[0]!.toString(16).padStart(2, '0')}` };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload.subarray(1));
  } catch {
    return { valid: false, reason: 'payload is not valid UTF-8' };
  }
  if (text.charCodeAt(0) === 0xfeff) return { valid: false, reason: 'payload starts with a byte-order mark', text };
  let object: unknown;
  try {
    object = parseIJSON(text);
  } catch (e) {
    return { valid: false, reason: (e as Error).message, text };
  }
  if (object === null || typeof object !== 'object' || Array.isArray(object)) return { valid: false, reason: 'JSON value is not an object', text };
  return { valid: true, object: object as Record<string, unknown>, text };
}

/** Token metadata for the preparation payload (field names per the KCC-23 draft example plus `image` as `sha256:<hex>`). */
export interface TokenMetadata {
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly image?: string;
  readonly description?: string;
  readonly links?: Readonly<Record<string, string>>;
}

/** Canonical payload: `0x00 || compact JSON in declared member order`, re-decoded as a check. Limit 4 KB by default. */
export function encodeDeclaration(metadata: TokenMetadata, maxBytes = 4096): Uint8Array {
  const ordered: Record<string, unknown> = { name: metadata.name, symbol: metadata.symbol, decimals: metadata.decimals };
  if (metadata.image !== undefined) ordered['image'] = metadata.image;
  if (metadata.description !== undefined) ordered['description'] = metadata.description;
  if (metadata.links !== undefined) ordered['links'] = metadata.links;
  const bytes = concat(Uint8Array.of(0x00), new TextEncoder().encode(JSON.stringify(ordered)));
  if (bytes.length > maxBytes) throw new Error(`declaration is ${bytes.length} bytes, above the ${maxBytes}-byte limit`);
  const d = decodeDeclaration(bytes);
  if (!d.valid) throw new Error(`metadata does not round-trip as an I-JSON declaration: ${d.reason}`);
  return bytes;
}
