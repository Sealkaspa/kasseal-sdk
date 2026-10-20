/**
 * KCC-1 sec 3.7.3 Template Hash.
 *
 *   TemplateHash(prefix, suffix) =
 *       Hash(LE64(len(prefix)) || prefix || LE64(len(suffix)) || suffix)
 *
 * where `Hash` is unkeyed BLAKE3-256 (sec 3.2.1) and (prefix, suffix) are the
 * program bytes outside the encoded-state window (sec 3.7):
 *
 *   prefix = R[0 : state.start]
 *   suffix = R[state.start + state.len :]
 *
 * The two length fields bind the prefix/suffix boundary; the spec forbids
 * replacing this with Hash(prefix || suffix). A template view (sec 3.7.4) is
 * the same construction over a narrower window, so one program can carry
 * several valid template hashes -- one per declared cut.
 *
 * Verified against the sec 6.9 / 6.10 conformance vectors in
 * test/template-hash.test.ts.
 */

import { blake3 } from './blake3.ts';
import { DecodeError } from './errors.ts';
import { toHex } from './push.ts';

/** A template hash: 64 lowercase hex characters. */
export const TEMPLATE_HASH_RE = /^[0-9a-f]{64}$/;

function le64(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`LE64: not a non-negative safe integer: ${n}`);
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The last template parts hashed and their hash (copies: a caller may reuse its buffers). A handful of templates (token,
 * curve, Dist, BatchBuy, ...) are hashed over and over while every state differs: comparing the parts byte by byte costs
 * a small fraction of hashing them again. The result is exactly `blake3` of the same input.
 */
const MEMO_SIZE = 16;
const memo: { prefix: Uint8Array; suffix: Uint8Array; hash: Uint8Array }[] = [];

/** TemplateHash over explicit template parts, as 32 raw bytes. */
export function templateHashBytes(prefix: Uint8Array, suffix: Uint8Array): Uint8Array {
  for (let i = 0; i < memo.length; i++) {
    const m = memo[i]!;
    if (sameBytes(m.suffix, suffix) && sameBytes(m.prefix, prefix)) {
      if (i > 0) {
        memo.splice(i, 1);
        memo.unshift(m);
      }
      return Uint8Array.from(m.hash);
    }
  }
  const buf = new Uint8Array(8 + prefix.length + 8 + suffix.length);
  buf.set(le64(prefix.length), 0);
  buf.set(prefix, 8);
  buf.set(le64(suffix.length), 8 + prefix.length);
  buf.set(suffix, 16 + prefix.length);
  const hash = blake3(buf);
  memo.unshift({ prefix: Uint8Array.from(prefix), suffix: Uint8Array.from(suffix), hash: Uint8Array.from(hash) });
  if (memo.length > MEMO_SIZE) memo.length = MEMO_SIZE;
  return hash;
}

/** TemplateHash over explicit template parts, lowercase hex. */
export function templateHash(prefix: Uint8Array, suffix: Uint8Array): string {
  return toHex(templateHashBytes(prefix, suffix));
}

/**
 * TemplateHash of a full covenant program `R` under the state window
 * [stateStart, stateStart + stateLength). Throws DecodeError if the window
 * does not fit inside the program.
 */
export function templateHashOfProgram(program: Uint8Array, stateStart: number, stateLength: number): string {
  if (!Number.isInteger(stateStart) || stateStart < 0 || !Number.isInteger(stateLength) || stateLength < 0) {
    throw new DecodeError(`invalid state window: start ${stateStart}, length ${stateLength}`);
  }
  const end = stateStart + stateLength;
  if (end > program.length) {
    throw new DecodeError(`program is ${program.length} bytes; state window [${stateStart}, ${end}) does not fit`);
  }
  return templateHash(program.subarray(0, stateStart), program.subarray(end));
}
