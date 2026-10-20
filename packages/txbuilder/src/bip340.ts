/**
 * BIP-340 Schnorr verification over secp256k1: `finalizeSigned` checks every signature a wallet
 * returns against the sighash this code computes and the signer's x-only key, so a wallet's invalid signature is
 * refused here with a clear reason instead of reaching the node. Verification only (public data, no secret), Jacobian
 * coordinates, bigint arithmetic, the codec's FIPS 180-4 SHA-256 (no platform crypto needed).
 */
import { concat, sha256, toHex } from '@kasseal/codec';

const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

type Jac = readonly [bigint, bigint, bigint];
const mod = (a: bigint, m = P): bigint => ((a % m) + m) % m;
function pow(b: bigint, e: bigint, m = P): bigint {
  let r = 1n;
  b = mod(b, m);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}
const inv = (a: bigint): bigint => pow(a, P - 2n);
const INF: Jac = [0n, 1n, 0n];

function dbl([x, y, z]: Jac): Jac {
  if (z === 0n || y === 0n) return INF;
  const s = mod(4n * x * y * y);
  const m = mod(3n * x * x);
  const x3 = mod(m * m - 2n * s);
  return [x3, mod(m * (s - x3) - 8n * y ** 4n), mod(2n * y * z)];
}
function add(a: Jac, b: Jac): Jac {
  if (a[2] === 0n) return b;
  if (b[2] === 0n) return a;
  const z1z1 = mod(a[2] * a[2]);
  const z2z2 = mod(b[2] * b[2]);
  const u1 = mod(a[0] * z2z2);
  const u2 = mod(b[0] * z1z1);
  const s1 = mod(a[1] * b[2] * z2z2);
  const s2 = mod(b[1] * a[2] * z1z1);
  if (u1 === u2) return s1 === s2 ? dbl(a) : INF;
  const h = mod(u2 - u1);
  const r = mod(s2 - s1);
  const hh = mod(h * h);
  const hhh = mod(h * hh);
  const x3 = mod(r * r - hhh - 2n * u1 * hh);
  return [x3, mod(r * (u1 * hh - x3) - s1 * hhh), mod(h * a[2] * b[2])];
}
function mul(p: Jac, k: bigint): Jac {
  let r = INF;
  let q = p;
  while (k > 0n) {
    if (k & 1n) r = add(r, q);
    q = dbl(q);
    k >>= 1n;
  }
  return r;
}
function affine([x, y, z]: Jac): [bigint, bigint] | undefined {
  if (z === 0n) return undefined;
  const zi = inv(z);
  return [mod(x * zi * zi), mod(y * zi * zi * zi)];
}
const big = (b: Uint8Array): bigint => BigInt(`0x${toHex(b) || '0'}`);
const sha = (...parts: Uint8Array[]): Uint8Array => sha256(concat(...parts));
function taggedHash(tag: string, ...parts: Uint8Array[]): Uint8Array {
  const t = sha(new TextEncoder().encode(tag));
  return sha(t, t, ...parts);
}

/** BIP-340 verification of a 64-byte signature over a 32-byte message with a 32-byte x-only key; false on any malformed input. */
export function schnorrVerify(pubkey32: Uint8Array, message32: Uint8Array, sig64: Uint8Array): boolean {
  if (pubkey32.length !== 32 || message32.length !== 32 || sig64.length !== 64) return false;
  const x = big(pubkey32);
  if (x >= P) return false;
  const c = mod(x ** 3n + 7n);
  let y = pow(c, (P + 1n) / 4n);
  if (mod(y * y) !== c) return false;
  if (y & 1n) y = P - y;
  const r = big(sig64.subarray(0, 32));
  const s = big(sig64.subarray(32));
  if (r >= P || s >= N) return false;
  const e = mod(big(taggedHash('BIP0340/challenge', sig64.subarray(0, 32), pubkey32, message32)), N);
  const R = affine(add(mul([GX, GY, 1n], s), mul([x, mod(-y), 1n], e)));
  return R !== undefined && (R[1] & 1n) === 0n && R[0] === r;
}
