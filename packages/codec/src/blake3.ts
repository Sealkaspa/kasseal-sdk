/**
 * BLAKE3, hash mode only, in plain TypeScript.
 *
 * Written from the BLAKE3 specification (https://github.com/BLAKE3-team/BLAKE3-specs,
 * section 2 "The BLAKE3 Hash Function"): the compression function, the
 * chunk/parent tree, and the root output. Keyed and derive-key modes are
 * deliberately NOT implemented -- KCC-1 only needs unkeyed `Hash(x)` for the
 * template hash (KCC-1 sec 3.2.1, 3.7.3).
 *
 * Node 22 ships no BLAKE3 in `node:crypto`, and the codec package carries no
 * dependencies by policy, so this is the one place we implement a primitive
 * ourselves. It is verified against the official test vectors in
 * test/blake3.test.ts (inputs of 0..102400 bytes); do not change it without
 * re-running them.
 *
 * All arithmetic is on unsigned 32-bit words (`>>> 0`); the chunk counter is a
 * JS number, which is exact up to 2^53 chunks -- far beyond any script.
 */

const OUT_LEN = 32;
const BLOCK_LEN = 64;
const CHUNK_LEN = 1024;

const CHUNK_START = 1 << 0;
const CHUNK_END = 1 << 1;
const PARENT = 1 << 2;
const ROOT = 1 << 3;

const IV: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const MSG_PERMUTATION: readonly number[] = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** The quarter-round G, in place on `s` with message words mx, my. */
function g(s: Uint32Array, a: number, b: number, c: number, d: number, mx: number, my: number): void {
  s[a] = (s[a]! + s[b]! + mx) >>> 0;
  s[d] = rotr(s[d]! ^ s[a]!, 16);
  s[c] = (s[c]! + s[d]!) >>> 0;
  s[b] = rotr(s[b]! ^ s[c]!, 12);
  s[a] = (s[a]! + s[b]! + my) >>> 0;
  s[d] = rotr(s[d]! ^ s[a]!, 8);
  s[c] = (s[c]! + s[d]!) >>> 0;
  s[b] = rotr(s[b]! ^ s[c]!, 7);
}

function round(s: Uint32Array, m: Uint32Array): void {
  // Columns.
  g(s, 0, 4, 8, 12, m[0]!, m[1]!);
  g(s, 1, 5, 9, 13, m[2]!, m[3]!);
  g(s, 2, 6, 10, 14, m[4]!, m[5]!);
  g(s, 3, 7, 11, 15, m[6]!, m[7]!);
  // Diagonals.
  g(s, 0, 5, 10, 15, m[8]!, m[9]!);
  g(s, 1, 6, 11, 12, m[10]!, m[11]!);
  g(s, 2, 7, 8, 13, m[12]!, m[13]!);
  g(s, 3, 4, 9, 14, m[14]!, m[15]!);
}

function permute(m: Uint32Array): Uint32Array {
  const out = new Uint32Array(16);
  for (let i = 0; i < 16; i++) out[i] = m[MSG_PERMUTATION[i]!]!;
  return out;
}

/**
 * The compression function. Returns the full 16-word state after the final
 * feed-forward; the first 8 words are the chaining value.
 */
function compress(
  cv: Uint32Array,
  blockWords: Uint32Array,
  counter: number,
  blockLen: number,
  flags: number,
): Uint32Array {
  const counterLo = counter % 0x1_0000_0000;
  const counterHi = Math.floor(counter / 0x1_0000_0000);
  const s = new Uint32Array(16);
  for (let i = 0; i < 8; i++) s[i] = cv[i]!;
  s[8] = IV[0]!; s[9] = IV[1]!; s[10] = IV[2]!; s[11] = IV[3]!;
  s[12] = counterLo >>> 0;
  s[13] = counterHi >>> 0;
  s[14] = blockLen >>> 0;
  s[15] = flags >>> 0;

  let m = blockWords;
  round(s, m); m = permute(m); // round 1
  round(s, m); m = permute(m); // round 2
  round(s, m); m = permute(m); // round 3
  round(s, m); m = permute(m); // round 4
  round(s, m); m = permute(m); // round 5
  round(s, m); m = permute(m); // round 6
  round(s, m);                 // round 7

  for (let i = 0; i < 8; i++) {
    s[i] = (s[i]! ^ s[i + 8]!) >>> 0;
    s[i + 8] = (s[i + 8]! ^ cv[i]!) >>> 0;
  }
  return s;
}

function wordsFromLEBytes(block: Uint8Array): Uint32Array {
  const w = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    const o = i * 4;
    w[i] = (block[o]! | (block[o + 1]! << 8) | (block[o + 2]! << 16) | (block[o + 3]! << 24)) >>> 0;
  }
  return w;
}

/** A node's pending output: everything needed to derive its CV or root bytes. */
interface Output {
  readonly cv: Uint32Array;
  readonly block: Uint32Array;
  readonly counter: number;
  readonly blockLen: number;
  readonly flags: number;
}

function chainingValue(o: Output): Uint32Array {
  return compress(o.cv, o.block, o.counter, o.blockLen, o.flags).subarray(0, 8);
}

/** Root output bytes. We only ever need the first 32 bytes (output block 0). */
function rootBytes(o: Output, outLen: number): Uint8Array {
  const out = new Uint8Array(outLen);
  let outputBlockCounter = 0;
  let at = 0;
  while (at < outLen) {
    const words = compress(o.cv, o.block, outputBlockCounter, o.blockLen, o.flags | ROOT);
    for (let i = 0; i < 16 && at < outLen; i++) {
      const w = words[i]!;
      for (let b = 0; b < 4 && at < outLen; b++) out[at++] = (w >>> (8 * b)) & 0xff;
    }
    outputBlockCounter++;
  }
  return out;
}

class ChunkState {
  cv: Uint32Array;
  readonly chunkCounter: number;
  readonly block = new Uint8Array(BLOCK_LEN);
  blockLen = 0;
  blocksCompressed = 0;

  constructor(key: Uint32Array, chunkCounter: number) {
    this.cv = Uint32Array.from(key);
    this.chunkCounter = chunkCounter;
  }

  len(): number {
    return BLOCK_LEN * this.blocksCompressed + this.blockLen;
  }

  private startFlag(): number {
    return this.blocksCompressed === 0 ? CHUNK_START : 0;
  }

  update(input: Uint8Array): void {
    let pos = 0;
    while (pos < input.length) {
      // A full buffered block is compressed only once more input arrives, so the
      // final block of the chunk is always still in the buffer for CHUNK_END.
      if (this.blockLen === BLOCK_LEN) {
        this.cv = compress(this.cv, wordsFromLEBytes(this.block), this.chunkCounter, BLOCK_LEN, this.startFlag()).subarray(0, 8);
        this.blocksCompressed++;
        this.block.fill(0);
        this.blockLen = 0;
      }
      const want = BLOCK_LEN - this.blockLen;
      const take = Math.min(want, input.length - pos);
      this.block.set(input.subarray(pos, pos + take), this.blockLen);
      this.blockLen += take;
      pos += take;
    }
  }

  output(): Output {
    return {
      cv: this.cv,
      block: wordsFromLEBytes(this.block),
      counter: this.chunkCounter,
      blockLen: this.blockLen,
      flags: this.startFlag() | CHUNK_END,
    };
  }
}

function parentOutput(left: Uint32Array, right: Uint32Array, key: Uint32Array): Output {
  const block = new Uint32Array(16);
  block.set(left, 0);
  block.set(right, 8);
  return { cv: key, block, counter: 0, blockLen: BLOCK_LEN, flags: PARENT };
}

/** Incremental unkeyed BLAKE3 hasher. */
export class Blake3Hasher {
  readonly #key = Uint32Array.from(IV);
  #chunk = new ChunkState(this.#key, 0);
  readonly #cvStack: Uint32Array[] = [];

  update(input: Uint8Array): this {
    let pos = 0;
    while (pos < input.length) {
      // If the current chunk is complete, finalize it and start a new one.
      if (this.#chunk.len() === CHUNK_LEN) {
        const cv = chainingValue(this.#chunk.output());
        const totalChunks = this.#chunk.chunkCounter + 1;
        this.#addChunkCV(cv, totalChunks);
        this.#chunk = new ChunkState(this.#key, totalChunks);
      }
      const want = CHUNK_LEN - this.#chunk.len();
      const take = Math.min(want, input.length - pos);
      this.#chunk.update(input.subarray(pos, pos + take));
      pos += take;
    }
    return this;
  }

  /** Merge completed subtrees: a chunk count with k trailing zero bits closes k levels. */
  #addChunkCV(newCV: Uint32Array, totalChunks: number): void {
    let cv = newCV;
    let n = totalChunks;
    while ((n & 1) === 0) {
      cv = chainingValue(parentOutput(this.#cvStack.pop()!, cv, this.#key));
      n = Math.floor(n / 2);
    }
    this.#cvStack.push(cv);
  }

  /** Finalize without disturbing the hasher. */
  digest(outLen = OUT_LEN): Uint8Array {
    let output = this.#chunk.output();
    for (let i = this.#cvStack.length - 1; i >= 0; i--) {
      output = parentOutput(this.#cvStack[i]!, chainingValue(output), this.#key);
    }
    return rootBytes(output, outLen);
  }
}

/** One-shot unkeyed BLAKE3-256 (or a longer extended output if `outLen` is given). */
export function blake3(input: Uint8Array, outLen = OUT_LEN): Uint8Array {
  return new Blake3Hasher().update(input).digest(outLen);
}
