/**
 * Keyed BLAKE3 (BLAKE3 specification section 2.5 "keyed hashing") for the
 * KIP-24 version-1 transaction id, whose three hashers are keyed with the
 * ASCII domain names `PayloadDigest`, `TransactionRest` and `TransactionV1Id`
 * right-padded with zero bytes to 32 bytes (biryukovmaxim/kips@028117f,
 * reproduced on testnet-10 submissions).
 *
 * `blake3.ts` implements hash mode only (KCC-1 needs nothing else); this file
 * is the same construction with the key words as the initial chaining value
 * and the KEYED_HASH flag set on every compression. Pure TypeScript, no
 * Node built-ins, so the browser bundle can compute txids without the SDK.
 * Verified in test/blake3-keyed.test.ts against every `keyed_hash` case of the
 * official BLAKE3 test vectors, KIP-24's `ZERO_PAYLOAD_DIGEST` and the KCC-23
 * conformance vector (prep txid `206a0c31...`).
 */

const OUT_LEN = 32;
const BLOCK_LEN = 64;
const CHUNK_LEN = 1024;
const CHUNK_START = 1 << 0;
const CHUNK_END = 1 << 1;
const PARENT = 1 << 2;
const ROOT = 1 << 3;
const KEYED_HASH = 1 << 4;

const IV: readonly number[] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const MSG_PERMUTATION: readonly number[] = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];

const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;

function g(s: Uint32Array, a: number, b: number, c: number, d: number, mx: number, my: number): void {
  s[a] = (s[a]! + s[b]! + mx) >>> 0; s[d] = rotr(s[d]! ^ s[a]!, 16); s[c] = (s[c]! + s[d]!) >>> 0; s[b] = rotr(s[b]! ^ s[c]!, 12);
  s[a] = (s[a]! + s[b]! + my) >>> 0; s[d] = rotr(s[d]! ^ s[a]!, 8); s[c] = (s[c]! + s[d]!) >>> 0; s[b] = rotr(s[b]! ^ s[c]!, 7);
}

function round(s: Uint32Array, m: Uint32Array): void {
  g(s, 0, 4, 8, 12, m[0]!, m[1]!); g(s, 1, 5, 9, 13, m[2]!, m[3]!); g(s, 2, 6, 10, 14, m[4]!, m[5]!); g(s, 3, 7, 11, 15, m[6]!, m[7]!);
  g(s, 0, 5, 10, 15, m[8]!, m[9]!); g(s, 1, 6, 11, 12, m[10]!, m[11]!); g(s, 2, 7, 8, 13, m[12]!, m[13]!); g(s, 3, 4, 9, 14, m[14]!, m[15]!);
}

function permute(m: Uint32Array): Uint32Array {
  const out = new Uint32Array(16);
  for (let i = 0; i < 16; i++) out[i] = m[MSG_PERMUTATION[i]!]!;
  return out;
}

function compress(cv: Uint32Array, blockWords: Uint32Array, counter: number, blockLen: number, flags: number): Uint32Array {
  const s = new Uint32Array(16);
  for (let i = 0; i < 8; i++) s[i] = cv[i]!;
  s[8] = IV[0]!; s[9] = IV[1]!; s[10] = IV[2]!; s[11] = IV[3]!;
  s[12] = (counter % 0x1_0000_0000) >>> 0;
  s[13] = Math.floor(counter / 0x1_0000_0000) >>> 0;
  s[14] = blockLen >>> 0;
  s[15] = flags >>> 0;
  let m = blockWords;
  for (let r = 0; r < 6; r++) { round(s, m); m = permute(m); }
  round(s, m);
  for (let i = 0; i < 8; i++) { s[i] = (s[i]! ^ s[i + 8]!) >>> 0; s[i + 8] = (s[i + 8]! ^ cv[i]!) >>> 0; }
  return s;
}

function words(block: Uint8Array): Uint32Array {
  const w = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    const o = i * 4;
    w[i] = (block[o]! | (block[o + 1]! << 8) | (block[o + 2]! << 16) | (block[o + 3]! << 24)) >>> 0;
  }
  return w;
}

interface Output { readonly cv: Uint32Array; readonly block: Uint32Array; readonly counter: number; readonly blockLen: number; readonly flags: number }

const chainingValue = (o: Output): Uint32Array => compress(o.cv, o.block, o.counter, o.blockLen, o.flags).subarray(0, 8);

function rootBytes(o: Output, outLen: number): Uint8Array {
  const out = new Uint8Array(outLen);
  let counter = 0;
  let at = 0;
  while (at < outLen) {
    const w = compress(o.cv, o.block, counter++, o.blockLen, o.flags | ROOT);
    for (let i = 0; i < 16 && at < outLen; i++) for (let b = 0; b < 4 && at < outLen; b++) out[at++] = (w[i]! >>> (8 * b)) & 0xff;
  }
  return out;
}

class ChunkState {
  cv: Uint32Array;
  readonly chunkCounter: number;
  readonly base: number;
  readonly block = new Uint8Array(BLOCK_LEN);
  blockLen = 0;
  blocksCompressed = 0;
  constructor(key: Uint32Array, chunkCounter: number, base: number) {
    this.cv = Uint32Array.from(key);
    this.chunkCounter = chunkCounter;
    this.base = base;
  }
  len(): number { return BLOCK_LEN * this.blocksCompressed + this.blockLen; }
  private startFlag(): number { return this.blocksCompressed === 0 ? CHUNK_START : 0; }
  update(input: Uint8Array): void {
    let pos = 0;
    while (pos < input.length) {
      if (this.blockLen === BLOCK_LEN) {
        this.cv = compress(this.cv, words(this.block), this.chunkCounter, BLOCK_LEN, this.base | this.startFlag()).subarray(0, 8);
        this.blocksCompressed++;
        this.block.fill(0);
        this.blockLen = 0;
      }
      const take = Math.min(BLOCK_LEN - this.blockLen, input.length - pos);
      this.block.set(input.subarray(pos, pos + take), this.blockLen);
      this.blockLen += take;
      pos += take;
    }
  }
  output(): Output {
    return { cv: this.cv, block: words(this.block), counter: this.chunkCounter, blockLen: this.blockLen, flags: this.base | this.startFlag() | CHUNK_END };
  }
}

function parentOutput(left: Uint32Array, right: Uint32Array, key: Uint32Array, base: number): Output {
  const block = new Uint32Array(16);
  block.set(left, 0);
  block.set(right, 8);
  return { cv: key, block, counter: 0, blockLen: BLOCK_LEN, flags: base | PARENT };
}

/** BLAKE3 of `input` under a 32-byte key (keyed mode). */
export function blake3Keyed(key32: Uint8Array, input: Uint8Array, outLen = OUT_LEN): Uint8Array {
  if (key32.length !== 32) throw new RangeError(`blake3Keyed: key must be 32 bytes, got ${key32.length}`);
  const key = words(key32).subarray(0, 8);
  const base = KEYED_HASH;
  let chunk = new ChunkState(key, 0, base);
  const stack: Uint32Array[] = [];
  const addChunk = (cv0: Uint32Array, totalChunks: number): void => {
    let cv = cv0;
    let n = totalChunks;
    while ((n & 1) === 0) {
      cv = chainingValue(parentOutput(stack.pop()!, cv, key, base));
      n = Math.floor(n / 2);
    }
    stack.push(cv);
  };
  let pos = 0;
  while (pos < input.length) {
    if (chunk.len() === CHUNK_LEN) {
      const total = chunk.chunkCounter + 1;
      addChunk(chainingValue(chunk.output()), total);
      chunk = new ChunkState(key, total, base);
    }
    const take = Math.min(CHUNK_LEN - chunk.len(), input.length - pos);
    chunk.update(input.subarray(pos, pos + take));
    pos += take;
  }
  let output = chunk.output();
  for (let i = stack.length - 1; i >= 0; i--) output = parentOutput(stack[i]!, chainingValue(output), key, base);
  return rootBytes(output, outLen);
}

/** KIP-24 domain key: the ASCII domain name right-padded with zero bytes to 32 bytes. */
export function domainKey(domain: string): Uint8Array {
  const bytes = new TextEncoder().encode(domain);
  if (bytes.length > 32) throw new RangeError(`domain ${domain} exceeds 32 bytes`);
  const key = new Uint8Array(32);
  key.set(bytes);
  return key;
}

/** `blake3Keyed(domainKey(domain), input)`: the KIP-24 hasher for one domain. */
export function keyedBlake3(domain: string, input: Uint8Array): Uint8Array {
  return blake3Keyed(domainKey(domain), input);
}
