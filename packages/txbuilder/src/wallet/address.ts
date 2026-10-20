/**
 * Kaspa addresses (rusty-kaspa `crypto/addresses`, v2.1.0): `prefix:` and a
 * base32 payload of `version || data` with a 40-bit BCH checksum over the
 * prefix. Pure TypeScript so the wallet flow can check a wallet's account
 * against its public key and label UTXO entries without the SDK.
 *
 *   version 0  PubKey       32-byte x-only Schnorr key   script 20 <key> ac
 *   version 1  PubKeyECDSA  33-byte compressed key        script 21 <key> ab
 *   version 8  ScriptHash   32-byte BLAKE2b script hash   script aa 20 <hash> 87
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATORS = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];

/** Kaspa address versions: 0 Schnorr key, 1 ECDSA key, 8 script hash. */
export type AddressVersion = 0 | 1 | 8;
/** Address version of a 32-byte x-only Schnorr key. */
export const ADDRESS_VERSION_PUBKEY = 0;
/** Address version of a 33-byte compressed ECDSA key. */
export const ADDRESS_VERSION_PUBKEY_ECDSA = 1;
/** Address version of a P2SH script hash. */
export const ADDRESS_VERSION_SCRIPT_HASH = 8;
const PAYLOAD_LENGTH: Readonly<Record<AddressVersion, number>> = { 0: 32, 1: 33, 8: 32 };

/** An address that does not decode (bad prefix, charset, checksum, version or length). */
export class AddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddressError';
  }
}

function polymod(values: Iterable<number>): bigint {
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= GENERATORS[i]!;
  }
  return c ^ 1n;
}

function checksum(payload5: readonly number[], prefix: string): bigint {
  return polymod([...[...prefix].map((ch) => ch.charCodeAt(0) & 0x1f), 0, ...payload5, 0, 0, 0, 0, 0, 0, 0, 0]);
}

function convertBits(data: readonly number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
    acc &= (1 << bits) - 1;
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    throw new AddressError('address payload has non-zero padding');
  }
  return out;
}

/** A decoded address. */
export interface DecodedAddress {
  readonly prefix: string;
  readonly version: AddressVersion;
  readonly payload: Uint8Array;
}

/** Encode an address from its prefix (`kaspa`, `kaspatest`), version and payload. */
export function encodeAddress(prefix: string, version: AddressVersion, payload: Uint8Array): string {
  if (!/^[a-z0-9]+$/.test(prefix)) throw new AddressError(`invalid address prefix ${JSON.stringify(prefix)}`);
  if (payload.length !== PAYLOAD_LENGTH[version]) throw new AddressError(`version ${version} payload must be ${PAYLOAD_LENGTH[version]} bytes, got ${payload.length}`);
  const data5 = convertBits([version, ...payload], 8, 5, true);
  const sum = checksum(data5, prefix);
  const sumBytes: number[] = [];
  for (let i = 4; i >= 0; i--) sumBytes.push(Number((sum >> BigInt(8 * i)) & 0xffn));
  const sum5 = convertBits(sumBytes, 8, 5, true);
  return `${prefix}:${[...data5, ...sum5].map((v) => CHARSET[v]).join('')}`;
}

/** Decode and checksum-verify an address; throws `AddressError`. */
export function decodeAddress(address: string): DecodedAddress {
  const sep = address.lastIndexOf(':');
  if (sep <= 0) throw new AddressError(`address ${JSON.stringify(address)} has no prefix`);
  const prefix = address.slice(0, sep);
  const body = address.slice(sep + 1);
  if (prefix !== prefix.toLowerCase() || body !== body.toLowerCase()) throw new AddressError('mixed-case address');
  if (body.length < 9) throw new AddressError('address too short');
  const values = [...body].map((ch) => {
    const v = CHARSET.indexOf(ch);
    if (v < 0) throw new AddressError(`invalid address character ${JSON.stringify(ch)}`);
    return v;
  });
  const data5 = values.slice(0, -8);
  const sum5 = values.slice(-8);
  const sumBytes = convertBits(sum5, 5, 8, false);
  let given = 0n;
  for (const b of sumBytes) given = (given << 8n) | BigInt(b);
  if (given !== checksum(data5, prefix)) throw new AddressError('address checksum mismatch');
  const bytes = convertBits(data5, 5, 8, false);
  const version = bytes[0];
  if (version !== 0 && version !== 1 && version !== 8) throw new AddressError(`unknown address version ${version}`);
  const payload = Uint8Array.from(bytes.slice(1));
  if (payload.length !== PAYLOAD_LENGTH[version]) throw new AddressError(`version ${version} payload must be ${PAYLOAD_LENGTH[version]} bytes, got ${payload.length}`);
  return { prefix, version, payload };
}

/** Address prefix of a network id (`testnet-10` -> `kaspatest`). */
export function addressPrefixOf(networkId: string): string {
  if (networkId === 'mainnet') return 'kaspa';
  if (networkId === 'devnet') return 'kaspadev';
  if (networkId === 'simnet') return 'kaspasim';
  if (/^testnet(-\d+)?$/.test(networkId)) return 'kaspatest';
  throw new AddressError(`unknown network ${JSON.stringify(networkId)}`);
}

/** The 32-byte x-only key of a version-0 (Schnorr P2PK) address. */
export function xOnlyKeyOfAddress(address: string): Uint8Array {
  const a = decodeAddress(address);
  if (a.version !== ADDRESS_VERSION_PUBKEY) throw new AddressError(`${address} is not a Schnorr P2PK address (version ${a.version})`);
  return a.payload;
}

/**
 * The address of a version-0 script public key (`script` without the 2-byte version), or undefined for a script that
 * has no address form (anything but P2PK Schnorr, P2PK ECDSA and P2SH).
 */
export function addressOfScript(script: Uint8Array, prefix: string): string | undefined {
  if (script.length === 34 && script[0] === 0x20 && script[33] === 0xac) return encodeAddress(prefix, ADDRESS_VERSION_PUBKEY, script.subarray(1, 33));
  if (script.length === 35 && script[0] === 0x21 && script[34] === 0xab) return encodeAddress(prefix, ADDRESS_VERSION_PUBKEY_ECDSA, script.subarray(1, 34));
  if (script.length === 35 && script[0] === 0xaa && script[1] === 0x20 && script[34] === 0x87) return encodeAddress(prefix, ADDRESS_VERSION_SCRIPT_HASH, script.subarray(2, 34));
  return undefined;
}
