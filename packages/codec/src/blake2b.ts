/**
 * BLAKE2b (RFC 7693) with optional key, in plain TypeScript, for the two
 * consensus hashes the builder must compute itself:
 *
 *   - the KCC-1 v0 P2SH commitment `aa 20 blake2b-256(R) 87` of a covenant
 *     program (KCC-1 section 3.6; equal to the SDK's `payToScriptHashScript`,
 *     which hashes the raw program; `ScriptBuilder.createPayToScriptHashScript`
 *     hashes a push-wrapped copy and must not be used);
 *   - the KIP-20 section 3.2 covenant id, keyed BLAKE2b-256 with the ASCII key
 *     `CovenantID` over `txid || le32(index) || le64(n) || sum(le32(i) ||
 *     le64(value) || le16(version) || le64(len) || script)`.
 *
 * `node:crypto` exposes only the unkeyed 512-bit variant, so the compression
 * function lives here. 64-bit words are held as 32-bit low/high pairs in typed
 * arrays (a BigInt version was about 9 times slower, and a builder hashes
 * every program it builds or checks). Pure TypeScript, no Node built-ins.
 * Tested against `node:crypto` (64-byte unkeyed), RFC 7693 appendix A, the
 * KCC-1 section 6.7 vector, real testnet-10 lineage ids and cell scripts, and a
 * BigInt reference on random inputs, keys and lengths, and against the Kaspa
 * SDK's `payToScriptHashScript` and `covenantId`.
 */

import { concat, fromHex, toHex } from './push.ts';

/** The IV as little-endian 32-bit halves: word i is (IV32[2i], IV32[2i + 1]) = (low, high). */
const IV32 = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);

/** RFC 7693 section 2.7 message schedule, rounds 0..11, as offsets into the 32-bit message array (2 x word index). */
const SIGMA2: readonly number[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
].flat().map((x) => 2 * x);

const BLOCK = 128;

// Work arrays of the compression function (64-bit words as 32-bit low/high pairs). The function is synchronous and
// never re-entered, so one set serves every call.
const V = new Uint32Array(32);
const M = new Uint32Array(32);

/** v[a] += v[b] (64-bit). */
function add64vv(a: number, b: number): void {
  const lo = V[a]! + V[b]!;
  let hi = V[a + 1]! + V[b + 1]!;
  if (lo >= 0x100000000) hi++;
  V[a] = lo;
  V[a + 1] = hi;
}

/** v[a] += (hi:lo) (64-bit). */
function add64vc(a: number, lo0: number, hi0: number): void {
  const lo = V[a]! + lo0;
  let hi = V[a + 1]! + hi0;
  if (lo >= 0x100000000) hi++;
  V[a] = lo;
  V[a + 1] = hi;
}

/** RFC 7693 section 3.1 mixing function G on the word pairs at a, b, c, d with message words at ix, iy. */
function g(a: number, b: number, c: number, d: number, ix: number, iy: number): void {
  add64vv(a, b);
  add64vc(a, M[ix]!, M[ix + 1]!);
  // v[d] = rotr64(v[d] ^ v[a], 32)
  let x0 = V[d]! ^ V[a]!;
  let x1 = V[d + 1]! ^ V[a + 1]!;
  V[d] = x1;
  V[d + 1] = x0;
  add64vv(c, d);
  // v[b] = rotr64(v[b] ^ v[c], 24)
  x0 = V[b]! ^ V[c]!;
  x1 = V[b + 1]! ^ V[c + 1]!;
  V[b] = (x0 >>> 24) ^ (x1 << 8);
  V[b + 1] = (x1 >>> 24) ^ (x0 << 8);
  add64vv(a, b);
  add64vc(a, M[iy]!, M[iy + 1]!);
  // v[d] = rotr64(v[d] ^ v[a], 16)
  x0 = V[d]! ^ V[a]!;
  x1 = V[d + 1]! ^ V[a + 1]!;
  V[d] = (x0 >>> 16) ^ (x1 << 16);
  V[d + 1] = (x1 >>> 16) ^ (x0 << 16);
  add64vv(c, d);
  // v[b] = rotr64(v[b] ^ v[c], 63)
  x0 = V[b]! ^ V[c]!;
  x1 = V[b + 1]! ^ V[c + 1]!;
  V[b] = (x1 >>> 31) ^ (x0 << 1);
  V[b + 1] = (x0 >>> 31) ^ (x1 << 1);
}

/** RFC 7693 section 3.2 compression of one 128-byte block at `block[at..]` into `h`; `counter` is the bytes so far. */
function compress(h: Uint32Array, block: Uint8Array, at: number, counter: number, last: boolean): void {
  for (let i = 0; i < 16; i++) {
    V[i] = h[i]!;
    V[i + 16] = IV32[i]!;
  }
  // The byte counter (below 2^53 here): low 64 bits into v[12]; v[13] (bits 64..127) stays the IV.
  V[24] = V[24]! ^ (counter >>> 0);
  V[25] = V[25]! ^ Math.floor(counter / 0x100000000);
  if (last) {
    V[28] = ~V[28]!;
    V[29] = ~V[29]!;
  }
  for (let i = 0; i < 32; i++) {
    const o = at + 4 * i;
    M[i] = block[o]! | (block[o + 1]! << 8) | (block[o + 2]! << 16) | (block[o + 3]! << 24);
  }
  for (let r = 0; r < 12; r++) {
    const s = r * 16;
    g(0, 8, 16, 24, SIGMA2[s]!, SIGMA2[s + 1]!);
    g(2, 10, 18, 26, SIGMA2[s + 2]!, SIGMA2[s + 3]!);
    g(4, 12, 20, 28, SIGMA2[s + 4]!, SIGMA2[s + 5]!);
    g(6, 14, 22, 30, SIGMA2[s + 6]!, SIGMA2[s + 7]!);
    g(0, 10, 20, 30, SIGMA2[s + 8]!, SIGMA2[s + 9]!);
    g(2, 12, 22, 24, SIGMA2[s + 10]!, SIGMA2[s + 11]!);
    g(4, 14, 16, 26, SIGMA2[s + 12]!, SIGMA2[s + 13]!);
    g(6, 8, 18, 28, SIGMA2[s + 14]!, SIGMA2[s + 15]!);
  }
  for (let i = 0; i < 16; i++) h[i] = h[i]! ^ V[i]! ^ V[i + 16]!;
}

/** Options of `blake2b`. */
export interface Blake2bOptions {
  /** Digest length in bytes, 1..64 (default 32). */
  readonly outLen?: number;
  /** Optional key, at most 64 bytes. */
  readonly key?: Uint8Array;
}

/** BLAKE2b digest of `data` (RFC 7693 section 3.3, keyed when `key` is given). */
export function blake2b(data: Uint8Array, { outLen = 32, key = new Uint8Array(0) }: Blake2bOptions = {}): Uint8Array {
  if (!Number.isInteger(outLen) || outLen < 1 || outLen > 64) throw new RangeError(`blake2b: outLen must be 1..64, got ${outLen}`);
  if (key.length > 64) throw new RangeError(`blake2b: key must be at most 64 bytes, got ${key.length}`);
  const h = IV32.slice();
  h[0] = h[0]! ^ (0x01010000 ^ (key.length << 8) ^ outLen);
  let input = data;
  if (key.length > 0) {
    const keyBlock = new Uint8Array(BLOCK);
    keyBlock.set(key);
    input = concat(keyBlock, data);
  }
  if (input.length === 0) {
    compress(h, new Uint8Array(BLOCK), 0, 0, true);
  } else {
    const blocks = Math.ceil(input.length / BLOCK);
    // Every block but the last is read in place; the last is zero-padded.
    for (let i = 0; i < blocks - 1; i++) compress(h, input, i * BLOCK, (i + 1) * BLOCK, false);
    const tail = new Uint8Array(BLOCK);
    tail.set(input.subarray((blocks - 1) * BLOCK));
    compress(h, tail, 0, input.length, true);
  }
  const out = new Uint8Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = h[i >> 2]! >>> (8 * (i & 3));
  return out;
}

/**
 * The last large programs committed to and their scripts (copies). Builders and checks commit to the same program
 * several times (an output, then the next transaction's input, then each re-check); comparing a program byte by byte
 * against the few remembered ones (programs of one template differ in their state, near the start) costs a small
 * fraction of hashing it again. The result is exactly the script of the bytes given.
 */
const P2SH_MEMO_MIN = 256;
const P2SH_MEMO_SIZE = 64;
const p2shMemo: { program: Uint8Array; spk: Uint8Array }[] = [];

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** KCC-1 section 3.6 v0 script public key of a covenant program: `OP_BLAKE2B OP_DATA_32 blake2b-256(R) OP_EQUAL`. */
export function p2shScript(program: Uint8Array): Uint8Array {
  if (program.length < P2SH_MEMO_MIN) return concat(Uint8Array.of(0xaa, 0x20), blake2b(program, { outLen: 32 }), Uint8Array.of(0x87));
  for (let i = 0; i < p2shMemo.length; i++) {
    const m = p2shMemo[i]!;
    if (sameBytes(m.program, program)) {
      if (i > 0) {
        p2shMemo.splice(i, 1);
        p2shMemo.unshift(m);
      }
      return Uint8Array.from(m.spk);
    }
  }
  const spk = concat(Uint8Array.of(0xaa, 0x20), blake2b(program, { outLen: 32 }), Uint8Array.of(0x87));
  p2shMemo.unshift({ program: Uint8Array.from(program), spk: Uint8Array.from(spk) });
  if (p2shMemo.length > P2SH_MEMO_SIZE) p2shMemo.length = P2SH_MEMO_SIZE;
  return spk;
}

/** True when `spk` is a 35-byte v0 P2SH script whose hash is `blake2b-256(program)`. */
export function p2shCommitsTo(spk: Uint8Array, program: Uint8Array): boolean {
  return toHex(spk) === toHex(p2shScript(program));
}

function le(n: bigint | number, width: number): Uint8Array {
  const out = new Uint8Array(width);
  let v = BigInt(n);
  if (v < 0n) throw new RangeError('le: negative value');
  for (let i = 0; i < width; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new RangeError(`le: value does not fit in ${width} bytes`);
  return out;
}

/** One output a covenant genesis authorizes, as the covenant id hashes it. */
export interface GenesisAuthorizedOutput {
  /** The output's index in the genesis transaction. */
  readonly index: number;
  /** The output's value in sompi. */
  readonly value: bigint;
  /** Script public key version (0 for every output the builder creates). */
  readonly scriptVersion: number;
  /** Script bytes without the version. */
  readonly script: Uint8Array;
}

const COVENANT_ID_KEY = new TextEncoder().encode('CovenantID');

/**
 * KIP-20 section 3.2 covenant id of a genesis group, lowercase hex. Equal to
 * the Kaspa SDK's `covenantId()` and to the node's UTXO index (checked on
 * testnet-10 geneses).
 */
export function covenantIdKip20(genesisTxid: string, genesisIndex: number, outputs: readonly GenesisAuthorizedOutput[]): string {
  const parts: Uint8Array[] = [fromHex(genesisTxid), le(genesisIndex, 4), le(outputs.length, 8)];
  for (const o of outputs) {
    parts.push(le(o.index, 4), le(o.value, 8), le(o.scriptVersion, 2), le(o.script.length, 8), o.script);
  }
  return toHex(blake2b(concat(...parts), { outLen: 32, key: COVENANT_ID_KEY }));
}
