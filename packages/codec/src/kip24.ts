/**
 * KIP-24 version-1 transaction id over an SDK-independent transaction form.
 *
 * KIP-24 (biryukovmaxim/kips@028117f): `txid = TransactionV1Id(PayloadDigest(payload)
 * || TransactionRest(rest))` with keyed BLAKE3 (key = ASCII domain right-padded
 * to 32 bytes); the rest preimage is
 *   u16 version || u64 n_in || (txid32 || u32 index || u64 0 || u64 sequence)*
 *   || u64 n_out || (u64 value || u16 spk_version || u64 len || spk || bool has_covenant
 *   [|| u16 authorizing_input || id32])* || u64 lock_time || subnetwork20 || u64 gas || u64 0
 * with empty sigscripts, no payload, no masses and no compute budgets: neither
 * signatures nor compute budgets move the txid. Equal to the node-echoed txid
 * and the Kaspa SDK's `Transaction.id` on every testnet-10 transaction checked,
 * and to the KCC-23 conformance vector.
 *
 * `PlainTx` is the transaction form shared by the builder, the launch-proof
 * bundle and the API. Hex strings are lowercase, values are bigints.
 */

import { keyedBlake3 } from './blake3-keyed.ts';
import { concat, fromHex, toHex } from './push.ts';

/** `PayloadDigest` of an empty payload, hex. */
export const ZERO_PAYLOAD_DIGEST = '9c0ca2acb45e92ffe6ceb4ae29188b35c82d9676cdd3ce067fd6ccc30a9c4a38';
/** The native subnetwork id (20 zero bytes), hex. */
export const NATIVE_SUBNETWORK_ID = '00'.repeat(20);

/** A transaction input in SDK-independent form. */
export interface PlainInput {
  /** The spent output's transaction id, hex. */
  readonly transactionId: string;
  /** The spent output's index. */
  readonly index: number;
  /** Input sequence number. */
  readonly sequence: bigint;
  /** Hex; empty for an unsigned input. Not part of the txid. */
  readonly signatureScript: string;
  /** Not part of the txid. */
  readonly computeBudget: number;
}

/** A transaction output in SDK-independent form. */
export interface PlainOutput {
  /** Value in sompi. */
  readonly value: bigint;
  /** Script public key version. */
  readonly scriptVersion: number;
  /** Script bytes, hex. */
  readonly script: string;
  /** The output's covenant binding (authorizing input index and covenant id, hex), or `null`. */
  readonly covenant: { readonly authorizingInput: number; readonly covenantId: string } | null;
}

/** A transaction in SDK-independent form: what the KIP-24 txid hashes, plus the signature scripts. */
export interface PlainTx {
  /** Transaction version (1 for KIP-24 txids). */
  readonly version: number;
  /** Inputs in order. */
  readonly inputs: readonly PlainInput[];
  /** Outputs in order. */
  readonly outputs: readonly PlainOutput[];
  /** Lock time. */
  readonly lockTime: bigint;
  /** Subnetwork id, hex (20 bytes). */
  readonly subnetworkId: string;
  /** Gas. */
  readonly gas: bigint;
  /** Hex. */
  readonly payload: string;
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
const varBytes = (b: Uint8Array): Uint8Array => concat(le(b.length, 8), b);

/** KIP-24 `PayloadDigest` of a payload (keyed BLAKE3). */
export function payloadDigest(payload: Uint8Array): Uint8Array {
  return payload.length === 0 ? fromHex(ZERO_PAYLOAD_DIGEST) : keyedBlake3('PayloadDigest', payload);
}

/** The KIP-24 rest preimage (EXCLUDE_PAYLOAD | EXCLUDE_SIGNATURE_SCRIPT | EXCLUDE_MASS_COMMIT). */
export function restPreimage(tx: PlainTx): Uint8Array {
  const parts: Uint8Array[] = [le(tx.version, 2), le(tx.inputs.length, 8)];
  for (const i of tx.inputs) {
    const id = fromHex(i.transactionId);
    if (id.length !== 32) throw new RangeError(`input transaction id must be 32 bytes, got ${id.length}`);
    parts.push(id, le(i.index, 4), varBytes(new Uint8Array(0)), le(i.sequence, 8));
  }
  parts.push(le(tx.outputs.length, 8));
  for (const o of tx.outputs) {
    parts.push(le(o.value, 8), le(o.scriptVersion, 2), varBytes(fromHex(o.script)));
    if (tx.version >= 1) {
      if (o.covenant) {
        const cid = fromHex(o.covenant.covenantId);
        if (cid.length !== 32) throw new RangeError(`covenant id must be 32 bytes, got ${cid.length}`);
        parts.push(Uint8Array.of(1), le(o.covenant.authorizingInput, 2), cid);
      } else {
        parts.push(Uint8Array.of(0));
      }
    }
  }
  const subnetwork = fromHex(tx.subnetworkId);
  if (subnetwork.length !== 20) throw new RangeError(`subnetwork id must be 20 bytes, got ${subnetwork.length}`);
  parts.push(le(tx.lockTime, 8), subnetwork, le(tx.gas, 8), varBytes(new Uint8Array(0)));
  return concat(...parts);
}

/** A KIP-24 txid with its two intermediate digests, all hex. */
export interface TxidV1 {
  /** The transaction id. */
  readonly txid: string;
  /** `PayloadDigest(payload)`. */
  readonly payloadDigest: string;
  /** `TransactionRest(rest)`. */
  readonly restDigest: string;
}

/** KIP-24 v1 txid of a plain transaction. */
export function txidV1(tx: PlainTx): TxidV1 {
  if (tx.version < 1) throw new Error('txidV1: version 0 transactions use the BLAKE2b TransactionID hash');
  const pd = payloadDigest(fromHex(tx.payload));
  const rd = keyedBlake3('TransactionRest', restPreimage(tx));
  return { txid: toHex(keyedBlake3('TransactionV1Id', concat(pd, rd))), payloadDigest: toHex(pd), restDigest: toHex(rd) };
}

/** JSON-safe form of a plain transaction (bigint as decimal strings). */
export function plainTxToJson(tx: PlainTx): Record<string, unknown> {
  return {
    version: tx.version,
    inputs: tx.inputs.map((i) => ({ ...i, sequence: i.sequence.toString() })),
    outputs: tx.outputs.map((o) => ({ ...o, value: o.value.toString() })),
    lockTime: tx.lockTime.toString(),
    subnetworkId: tx.subnetworkId,
    gas: tx.gas.toString(),
    payload: tx.payload,
  };
}

/** Inverse of `plainTxToJson`. */
export function plainTxFromJson(j: Record<string, unknown>): PlainTx {
  const inputs = j['inputs'] as Array<Record<string, unknown>>;
  const outputs = j['outputs'] as Array<Record<string, unknown>>;
  return {
    version: Number(j['version']),
    inputs: inputs.map((i) => ({
      transactionId: String(i['transactionId']), index: Number(i['index']), sequence: BigInt(String(i['sequence'] ?? '0')),
      signatureScript: String(i['signatureScript'] ?? ''), computeBudget: Number(i['computeBudget'] ?? 0),
    })),
    outputs: outputs.map((o) => {
      const c = o['covenant'] as Record<string, unknown> | null | undefined;
      return {
        value: BigInt(String(o['value'])), scriptVersion: Number(o['scriptVersion'] ?? 0), script: String(o['script']),
        covenant: c ? { authorizingInput: Number(c['authorizingInput']), covenantId: String(c['covenantId']) } : null,
      };
    }),
    lockTime: BigInt(String(j['lockTime'] ?? '0')),
    subnetworkId: String(j['subnetworkId'] ?? NATIVE_SUBNETWORK_ID),
    gas: BigInt(String(j['gas'] ?? '0')),
    payload: String(j['payload'] ?? ''),
  };
}
