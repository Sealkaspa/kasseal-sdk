/**
 * The rusty-kaspa signature hash (`consensus/core/src/hashing/sighash.rs`
 * `calc_schnorr_signature_hash`, v2.1.0) over a SafeJSON transaction, the
 * exact string handed to the wallet. Checked against the node (P2PK inputs
 * signed from it were accepted on testnet-10) and against the `sighash.rs`
 * test vectors.
 *
 *   H = BLAKE2b-256 keyed "TransactionSigningHash" over
 *       u16 version || prevOutputsHash || sequencesHash || [v0: sigOpCountsHash]
 *       || outpoint (txid || u32 index) || u16 spkVersion || varbytes(spk) || u64 amount || u64 sequence
 *       || [v0: u8 sigOpCount] || outputsHash || u64 lockTime || subnetworkId(20) || u64 gas || payloadHash || u8 hashType
 *   per output (v1): u64 value || u16 spkVersion || varbytes(script) || u8 hasCovenant || [u16 authorizingInput || covenantId]
 *   varbytes = u64 length || bytes; payloadHash is zero for the native subnetwork with an empty payload.
 *
 * Neither `computeBudget` nor any signature script is covered, which is what
 * lets the builder apply budgets and splice P2SH signatures after the wallet
 * signed. Used for Kaspire's prebuilt path
 * (B2), whose request carries the `expectedSighash` the wallet recomputes and
 * fails closed on.
 */

import { blake2b, concat, fromHex, toHex } from '@kasseal/codec';

/** Sighash type SIGHASH_ALL (the only one the builder requests). */
export const SIGHASH_ALL = 0x01;
/** Sighash type SIGHASH_NONE. */
export const SIGHASH_NONE = 0x02;
/** Sighash type SIGHASH_SINGLE. */
export const SIGHASH_SINGLE = 0x04;
/** Sighash modifier SIGHASH_ANYONECANPAY. */
export const SIGHASH_ANYONECANPAY = 0x80;
/** The hash types rusty-kaspa's `SigHashType::from_u8` accepts. */
export const VALID_SIGHASH_TYPES: readonly number[] = [0x01, 0x02, 0x04, 0x81, 0x82, 0x84];

const KEY = new TextEncoder().encode('TransactionSigningHash');
const ZERO32 = new Uint8Array(32);
const NATIVE_SUBNETWORK = '00'.repeat(20);

type Num = string | number | bigint;

/** The fields of an SDK SafeJSON transaction the sighash reads (bigints may be decimal strings). */
export interface SighashTx {
  readonly version: Num;
  readonly inputs: readonly {
    readonly transactionId: string;
    readonly index: Num;
    readonly sequence: Num;
    readonly sigOpCount?: Num;
    readonly utxo?: { readonly amount: Num; readonly scriptPublicKey: string } | null;
  }[];
  readonly outputs: readonly {
    readonly value: Num;
    readonly scriptPublicKey: string;
    readonly covenant?: { readonly authorizingInput: Num; readonly covenantId: string } | null;
  }[];
  readonly lockTime: Num;
  readonly subnetworkId: string;
  readonly gas: Num;
  readonly payload?: string;
}

/** A transaction or input the sighash cannot be computed for. */
export class SighashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SighashError';
  }
}

const hash = (bytes: Uint8Array): Uint8Array => blake2b(bytes, { outLen: 32, key: KEY });

function uint(n: Num, bytes: number, what: string): Uint8Array {
  let v = BigInt(n);
  if (v < 0n || v >= 1n << BigInt(8 * bytes)) throw new SighashError(`${what} ${String(n)} does not fit in ${bytes} bytes`);
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
const u8 = (n: Num, what: string): Uint8Array => uint(n, 1, what);
const u16 = (n: Num, what: string): Uint8Array => uint(n, 2, what);
const u32 = (n: Num, what: string): Uint8Array => uint(n, 4, what);
const u64 = (n: Num, what: string): Uint8Array => uint(n, 8, what);
const varBytes = (b: Uint8Array): Uint8Array => concat(u64(b.length, 'length'), b);

function hex(s: string, bytes: number | undefined, what: string): Uint8Array {
  if (!/^([0-9a-f]{2})*$/i.test(s)) throw new SighashError(`${what} is not hex`);
  const b = fromHex(s);
  if (bytes !== undefined && b.length !== bytes) throw new SighashError(`${what} must be ${bytes} bytes, got ${b.length}`);
  return b;
}

/** SafeJSON `scriptPublicKey`: u16 little-endian version || script, hex. */
export function splitScriptPublicKey(spkHex: string): { version: number; script: Uint8Array } {
  const b = hex(spkHex, undefined, 'scriptPublicKey');
  if (b.length < 2) throw new SighashError('scriptPublicKey shorter than its version');
  return { version: b[0]! | (b[1]! << 8), script: b.subarray(2) };
}

const anyoneCanPay = (t: number): boolean => (t & SIGHASH_ANYONECANPAY) !== 0;
const isNone = (t: number): boolean => (t & 0x7f) === SIGHASH_NONE;
const isSingle = (t: number): boolean => (t & 0x7f) === SIGHASH_SINGLE;

/** Signature hash of input `inputIndex` (hex, 32 bytes). */
export function sighash(tx: SighashTx, inputIndex: number, hashType: number = SIGHASH_ALL): string {
  if (!VALID_SIGHASH_TYPES.includes(hashType)) throw new SighashError(`invalid sighash type 0x${hashType.toString(16)}`);
  const version = Number(tx.version);
  const { inputs, outputs } = tx;
  const input = inputs[inputIndex];
  if (!Number.isInteger(inputIndex) || input === undefined) throw new SighashError(`no input ${inputIndex} of ${inputs.length}`);
  if (!input.utxo) throw new SighashError(`input ${inputIndex} has no UTXO entry`);

  const prevOutputsHash = anyoneCanPay(hashType)
    ? ZERO32
    : hash(concat(...inputs.map((i, k) => concat(hex(i.transactionId, 32, `input ${k} transactionId`), u32(i.index, `input ${k} index`)))));
  const sequencesHash = isSingle(hashType) || anyoneCanPay(hashType) || isNone(hashType) ? ZERO32 : hash(concat(...inputs.map((i, k) => u64(i.sequence, `input ${k} sequence`))));
  const sigOpCountsHash = anyoneCanPay(hashType) ? ZERO32 : hash(concat(...inputs.map((i, k) => u8(i.sigOpCount ?? 0, `input ${k} sigOpCount`))));

  const hashOutput = (o: SighashTx['outputs'][number], k: number): Uint8Array => {
    const spk = splitScriptPublicKey(o.scriptPublicKey);
    const parts = [u64(o.value, `output ${k} value`), u16(spk.version, `output ${k} spk version`), varBytes(spk.script)];
    if (version >= 1) {
      parts.push(u8(o.covenant ? 1 : 0, 'hasCovenant'));
      if (o.covenant) parts.push(u16(o.covenant.authorizingInput, `output ${k} authorizingInput`), hex(o.covenant.covenantId, 32, `output ${k} covenantId`));
    }
    return concat(...parts);
  };
  let outputsHash: Uint8Array;
  if (isNone(hashType)) outputsHash = ZERO32;
  else if (isSingle(hashType)) outputsHash = inputIndex >= outputs.length ? ZERO32 : hash(hashOutput(outputs[inputIndex]!, inputIndex));
  else outputsHash = hash(concat(...outputs.map(hashOutput)));

  const subnetwork = hex(tx.subnetworkId, 20, 'subnetworkId');
  const payload = hex(tx.payload ?? '', undefined, 'payload');
  const payloadHash = tx.subnetworkId.toLowerCase() === NATIVE_SUBNETWORK && payload.length === 0 ? ZERO32 : hash(varBytes(payload));

  const spk = splitScriptPublicKey(input.utxo.scriptPublicKey);
  const parts: Uint8Array[] = [u16(version, 'version'), prevOutputsHash, sequencesHash];
  if (version < 1) parts.push(sigOpCountsHash);
  parts.push(
    hex(input.transactionId, 32, `input ${inputIndex} transactionId`), u32(input.index, `input ${inputIndex} index`),
    u16(spk.version, 'spk version'), varBytes(spk.script), u64(input.utxo.amount, 'amount'), u64(input.sequence, 'sequence'),
  );
  if (version < 1) parts.push(u8(input.sigOpCount ?? 0, 'sigOpCount'));
  parts.push(outputsHash, u64(tx.lockTime, 'lockTime'), subnetwork, u64(tx.gas, 'gas'), payloadHash, u8(hashType, 'hashType'));
  return toHex(hash(concat(...parts)));
}

/** Signature hash of input `inputIndex` of a SafeJSON string. */
export function sighashOfTxJson(txJson: string, inputIndex: number, hashType: number = SIGHASH_ALL): string {
  return sighash(JSON.parse(txJson) as SighashTx, inputIndex, hashType);
}
