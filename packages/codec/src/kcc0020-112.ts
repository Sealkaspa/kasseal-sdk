/**
 * kcc0020-112 -- the KCC-20 standard layout (kaspanet/kccs@3fbec52, Last Call).
 *
 * State (KCC-20 sec 1), encoded per KCC-1 sec 3.7.1 as one PushExplicit per
 * field, in declaration order:
 *
 *   08 <8 bytes>    amount                int        9 bytes  (LE signed-magnitude)
 *   20 <32 bytes>   owner                 byte[32]  33 bytes
 *   01 <1 byte>     owner_scheme          byte       2 bytes  (KCC-2 default set)
 *   01 <1 byte>     borrow_scheme         byte       2 bytes  (KCC-20 sec 3, fixed)
 *   20 <32 bytes>   borrow_guard          byte[32]  33 bytes
 *   20 <32 bytes>   extension_commitment  byte[32]  33 bytes
 *                                                 = 112 bytes
 *
 * The layout has no supply or minting model: `mintCapable` is always `null`
 * and the layout-specific fields live in `extra` under the keys exported
 * below. Supply for a KCC-20 lineage is sealed at genesis by consensus, not
 * by a minter flag.
 *
 * Field order and encoding were verified against the conformance vectors
 * (`vectors/kcc-0020-conformance.json`, `state_encoding`) and against live
 * testnet-10 cells.
 *
 * Transfer rules (KCC-20 sec 2 and sec 5) are implemented in `checkTransfer`
 * below. The codec sees states and the leader's witness; it never sees a
 * transaction, so it reports what must authorize each input and verifies no
 * signature.
 */

import { blake3 } from './blake3.ts';
import { DecodeError, SupplyError, TransferError, ValidationError } from './errors.ts';
import {
  INT_MAX, bytesEqual, concat, decodeIntState, encodeIntState, encodePushExplicit, encodePushMinimal,
  fromHex, readPushExplicit, toHex,
} from './push.ts';
import { describeAuth, type AuthRequirement } from './auth.ts';
import type { LayoutCodec, OwnerSemantic, SchemeMap, StateSlot, TokenState } from './types.ts';

/** Layout id of the 112-byte KCC-20 standard state. */
export const KCC0020_112_ID = 'kcc0020-112';
/** Length of a `kcc0020-112` state, in bytes. */
export const KCC0020_112_STATE_LENGTH = 112;
const FIELD_WIDTH = 32;

/* -------------------------------------------------------------------------- */
/* Scheme tables                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The KCC-2 default owner-scheme set as used by the default KCC-20
 * configuration (KCC-20 sec 3). A non-default configuration may support a
 * subset; the template descriptor supplies the map that governs a program.
 */
export const KCC2_DEFAULT_SCHEMES: SchemeMap = new Map<number, OwnerSemantic>([
  [0x00, 'pubkey'],        // p2pk-schnorr/v1   owner = 32-byte Schnorr public key
  [0x01, 'p2pkh-schnorr'], // p2pkh-schnorr/v1  owner = Hash(pubkey)
  [0x02, 'p2pkh-ecdsa'],   // p2pkh-ecdsa/v1    owner = Hash(33-byte compressed ECDSA pubkey)
  [0x03, 'script-hash'],   // p2sh/v1           owner = KCC-1 P2SH commitment to R
  [0x04, 'covenant-id'],   // covenant-id/v1    owner = KIP-20 covenant id
]);

/** KCC-2 scheme names, keyed by the domain semantic. */
export const KCC2_SCHEME_NAMES: ReadonlyMap<OwnerSemantic, string> = new Map<OwnerSemantic, string>([
  ['pubkey', 'p2pk-schnorr/v1'],
  ['p2pkh-schnorr', 'p2pkh-schnorr/v1'],
  ['p2pkh-ecdsa', 'p2pkh-ecdsa/v1'],
  ['script-hash', 'p2sh/v1'],
  ['covenant-id', 'covenant-id/v1'],
]);

/** The fixed KCC-20 borrow-scheme selector mapping (sec 3). */
export const BORROW_DISABLED = 0x00;
/** Borrow scheme amount-threshold/v1. */
export const BORROW_AMOUNT_THRESHOLD = 0x01;
/** Borrow scheme schnorr-signature/v1. */
export const BORROW_SCHNORR_SIGNATURE = 0x02;
/** Borrow scheme hash-chain/v1. */
export const BORROW_HASH_CHAIN = 0x03;

/** KCC-20 borrow-scheme names, keyed by selector byte. */
export const BORROW_SCHEME_NAMES: ReadonlyMap<number, string> = new Map([
  [BORROW_DISABLED, 'disabled/v1'],
  [BORROW_AMOUNT_THRESHOLD, 'amount-threshold/v1'],
  [BORROW_SCHNORR_SIGNATURE, 'schnorr-signature/v1'],
  [BORROW_HASH_CHAIN, 'hash-chain/v1'],
]);

/** First byte of the leader's `witness` (KCC-20 sec 2). Any other value is reserved. */
export const WITNESS_PATH_NORMAL = 0x00;
/** Witness path byte of a borrowed receive. */
export const WITNESS_PATH_BORROW = 0x01;

/** Default configuration bounds (KCC-20 sec 3). */
export const MAX_TOKEN_INPUTS = 3;
/** Default configuration bound on family outputs per transaction (KCC-20 sec 3). */
export const MAX_TOKEN_OUTPUTS = 3;

/** Length of a Schnorr signature in a witness (64 bytes plus the sighash type). */
export const SCHNORR_SIGNATURE_LENGTH = 65;
/** Length of an x-only Schnorr public key. */
export const SCHNORR_PUBKEY_LENGTH = 32;
/** Length of a compressed ECDSA public key. */
export const ECDSA_PUBKEY_LENGTH = 33;
/** hash-chain/v1 borrow witness: next_borrow_guard(32) || one_time_pubkey(32) || sig(65). */
export const HASH_CHAIN_WITNESS_LENGTH = 129;

/**
 * Default transfer entrypoints. A dispatch tag is the first four bytes of the
 * unkeyed BLAKE3 of the function signature (KCC-1 sec 3.5); both values are
 * asserted against the conformance vectors.
 */
export const KCC0020_DISPATCH = Object.freeze({
  transfer: Object.freeze({
    signature: 'transfer({int,byte[32],byte,byte,byte[32],byte[32]}[],byte[])',
    tagHex: '79c71c23',
  }),
  transferDelegator: Object.freeze({
    signature: 'transfer_delegator(byte[])',
    tagHex: 'fd3ef14a',
  }),
});

/** The dispatch tag of a function signature: BLAKE3(signature)[0:4]. */
export function dispatchTag(signature: string): Uint8Array {
  return blake3(new TextEncoder().encode(signature)).slice(0, 4);
}

/* -------------------------------------------------------------------------- */
/* Layout-specific fields                                                      */
/* -------------------------------------------------------------------------- */

/** Keys under `TokenState.extra` for the fields the domain type does not name. */
export const EXTRA_BORROW_SCHEME = 'borrowScheme';
/** `TokenState.extra` key of `borrow_guard`. */
export const EXTRA_BORROW_GUARD = 'borrowGuard';
/** `TokenState.extra` key of `extension_commitment`. */
export const EXTRA_EXTENSION_COMMITMENT = 'extensionCommitment';

/** The six KCC20State fields in plain form. */
export interface Kcc0020Fields {
  readonly amount: bigint;
  readonly owner: Uint8Array;
  readonly ownerScheme: number;
  readonly borrowScheme: number;
  readonly borrowGuard: Uint8Array;
  readonly extensionCommitment: Uint8Array;
}

const ZERO32 = new Uint8Array(FIELD_WIDTH);

/**
 * Build a validated `TokenState` from plain fields. `borrowGuard` and
 * `extensionCommitment` default to 32 zero bytes.
 */
export function makeKcc0020State(
  fields: Omit<Kcc0020Fields, 'borrowGuard' | 'extensionCommitment'> & Partial<Pick<Kcc0020Fields, 'borrowGuard' | 'extensionCommitment'>>,
  schemes: SchemeMap = KCC2_DEFAULT_SCHEMES,
): TokenState {
  const semantic = schemes.get(fields.ownerScheme);
  if (semantic === undefined) {
    throw new ValidationError(`owner_scheme ${hex2(fields.ownerScheme)} is not defined by this template (known: ${knownSchemes(schemes)})`);
  }
  const state: TokenState = {
    layoutId: KCC0020_112_ID,
    amount: fields.amount,
    owner: { schemeByte: fields.ownerScheme, semantic, identifier: Uint8Array.from(fields.owner) },
    mintCapable: null,
    extra: Object.freeze({
      [EXTRA_BORROW_SCHEME]: Uint8Array.of(fields.borrowScheme),
      [EXTRA_BORROW_GUARD]: Uint8Array.from(fields.borrowGuard ?? ZERO32),
      [EXTRA_EXTENSION_COMMITMENT]: Uint8Array.from(fields.extensionCommitment ?? ZERO32),
    }),
  };
  kcc0020_112.validate(state, schemes);
  return state;
}

/** Read the six fields back out of a validated state. */
export function kcc0020Fields(state: TokenState, schemes: SchemeMap = KCC2_DEFAULT_SCHEMES): Kcc0020Fields {
  kcc0020_112.validate(state, schemes);
  return {
    amount: state.amount,
    owner: state.owner.identifier,
    ownerScheme: state.owner.schemeByte,
    borrowScheme: state.extra[EXTRA_BORROW_SCHEME]![0]!,
    borrowGuard: state.extra[EXTRA_BORROW_GUARD]!,
    extensionCommitment: state.extra[EXTRA_EXTENSION_COMMITMENT]!,
  };
}

/** The state's `borrow_scheme` byte. */
export function borrowSchemeOf(state: TokenState): number {
  return extraByte(state, EXTRA_BORROW_SCHEME);
}
/** The state's 32-byte `borrow_guard`. */
export function borrowGuardOf(state: TokenState): Uint8Array {
  return extra32(state, EXTRA_BORROW_GUARD);
}
/** The state's 32-byte `extension_commitment`. */
export function extensionCommitmentOf(state: TokenState): Uint8Array {
  return extra32(state, EXTRA_EXTENSION_COMMITMENT);
}

/**
 * amount-threshold/v1 guard: the threshold as a KCC-1 eight-byte LE
 * signed-magnitude payload in `borrow_guard[0..8]`, the rest zero (KCC-20
 * sec 5; reference `main.rs` threshold_token_state).
 */
export function thresholdGuard(threshold: bigint): Uint8Array {
  const guard = new Uint8Array(FIELD_WIDTH);
  guard.set(encodeIntState(threshold), 0);
  return guard;
}

/** A decoded amount-threshold/v1 guard. */
export interface DecodedThreshold {
  /** The signed-magnitude value in `borrow_guard[0..8]`; negative zero decodes as 0. */
  readonly decoded: bigint;
  /** `max(decoded, 0)` -- what a borrowed receive must exceed. */
  readonly effective: bigint;
}

/**
 * Decode an amount-threshold/v1 guard. Unlike `decodeIntState` this accepts
 * negative zero: KCC-20 sec 5 says "both encodings of zero have the same
 * behavior", and the `threshold-negative-zero` vector relies on it.
 */
export function decodeThresholdGuard(guard: Uint8Array): DecodedThreshold {
  if (guard.length !== FIELD_WIDTH) throw new ValidationError(`borrow_guard must be ${FIELD_WIDTH} bytes, got ${guard.length}`);
  const negative = (guard[7]! & 0x80) !== 0;
  let magnitude = 0n;
  for (let i = 7; i >= 0; i--) {
    const b = i === 7 ? guard[i]! & 0x7f : guard[i]!;
    magnitude = (magnitude << 8n) | BigInt(b);
  }
  const decoded = negative ? -magnitude : magnitude;
  return { decoded, effective: decoded < 0n ? 0n : decoded };
}

/**
 * The self-owned footgun: under
 * covenant-id/v1 the reference program checks only that an input of the
 * owning lineage is present, and the active input counts, so a cell whose
 * owner is its own covenant id is anyone-can-spend.
 */
export function isSelfOwned(state: TokenState, ownCovenantId: Uint8Array): boolean {
  if (ownCovenantId.length !== FIELD_WIDTH) throw new ValidationError(`covenant id must be ${FIELD_WIDTH} bytes, got ${ownCovenantId.length}`);
  return state.owner.semantic === 'covenant-id' && bytesEqual(state.owner.identifier, ownCovenantId);
}

/** The builder rule: refuse to construct a self-owned output. */
export function assertNotSelfOwned(state: TokenState, ownCovenantId: Uint8Array, what = 'token output'): void {
  if (isSelfOwned(state, ownCovenantId)) {
    throw new TransferError(
      `${what} is self-owned: owner_scheme covenant-id/v1 with owner == its own covenant id ` +
        `${toHex(ownCovenantId)} is anyone-can-spend; refusing to construct it`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* The codec                                                                   */
/* -------------------------------------------------------------------------- */

/** The `kcc0020-112` layout codec. */
export const kcc0020_112: LayoutCodec = {
  id: KCC0020_112_ID,
  stateLength: KCC0020_112_STATE_LENGTH,
  referenceSchemes: KCC2_DEFAULT_SCHEMES,

  encode(state: TokenState, schemes: SchemeMap = KCC2_DEFAULT_SCHEMES): Uint8Array {
    this.validate(state, schemes);
    const bytes = concat(
      encodePushExplicit(encodeIntState(state.amount)),
      encodePushExplicit(state.owner.identifier),
      encodePushExplicit(Uint8Array.of(state.owner.schemeByte)),
      encodePushExplicit(state.extra[EXTRA_BORROW_SCHEME]!),
      encodePushExplicit(state.extra[EXTRA_BORROW_GUARD]!),
      encodePushExplicit(state.extra[EXTRA_EXTENSION_COMMITMENT]!),
    );
    if (bytes.length !== KCC0020_112_STATE_LENGTH) {
      throw new ValidationError(`encoded ${bytes.length} bytes, expected ${KCC0020_112_STATE_LENGTH}`);
    }
    return bytes;
  },

  decode(stateBytes: Uint8Array, schemes: SchemeMap): TokenState {
    if (stateBytes.length !== KCC0020_112_STATE_LENGTH) {
      throw new DecodeError(`${KCC0020_112_ID} state must be exactly ${KCC0020_112_STATE_LENGTH} bytes, got ${stateBytes.length}`);
    }
    let at = 0;
    const field = (name: string, width: number): Uint8Array => {
      const r = readPushExplicit(stateBytes, at);
      if (r.payload.length !== width) throw new DecodeError(`${name} must be ${width} bytes, got ${r.payload.length}`);
      at = r.next;
      return r.payload;
    };
    const amount = decodeIntState(field('amount', 8));
    const owner = field('owner', FIELD_WIDTH);
    const ownerScheme = field('owner_scheme', 1)[0]!;
    const borrowScheme = field('borrow_scheme', 1)[0]!;
    const borrowGuard = field('borrow_guard', FIELD_WIDTH);
    const extensionCommitment = field('extension_commitment', FIELD_WIDTH);
    // KCC1 sec 3.7.1: a decoder MUST reject trailing bytes.
    if (at !== stateBytes.length) throw new DecodeError(`trailing bytes: consumed ${at} of ${stateBytes.length}`);

    if (amount < 0n) throw new DecodeError(`negative amount ${amount} in state ${toHex(stateBytes)}`);
    const semantic = schemes.get(ownerScheme);
    if (semantic === undefined) {
      throw new DecodeError(
        `owner_scheme ${hex2(ownerScheme)} is not defined by this template (known: ${knownSchemes(schemes)}). Refusing to guess an owner.`,
      );
    }
    if (!BORROW_SCHEME_NAMES.has(borrowScheme)) {
      // KCC-20 sec 3: unassigned borrow_scheme values are reserved and MUST be treated as invalid.
      throw new DecodeError(`borrow_scheme ${hex2(borrowScheme)} is unassigned (known: 0x00..0x03)`);
    }

    return {
      layoutId: KCC0020_112_ID,
      amount,
      owner: { schemeByte: ownerScheme, semantic, identifier: Uint8Array.from(owner) },
      mintCapable: null,
      extra: Object.freeze({
        [EXTRA_BORROW_SCHEME]: Uint8Array.of(borrowScheme),
        [EXTRA_BORROW_GUARD]: Uint8Array.from(borrowGuard),
        [EXTRA_EXTENSION_COMMITMENT]: Uint8Array.from(extensionCommitment),
      }),
    };
  },

  validate(state: TokenState, schemes: SchemeMap = KCC2_DEFAULT_SCHEMES): void {
    if (state === null || typeof state !== 'object') throw new ValidationError('state must be an object');
    if (state.layoutId !== KCC0020_112_ID) throw new ValidationError(`expected ${KCC0020_112_ID}, got ${String(state.layoutId)}`);

    if (typeof state.amount !== 'bigint') throw new ValidationError(`amount must be a bigint, got ${typeof state.amount}`);
    if (state.amount < 0n) throw new ValidationError(`amount must be non-negative, got ${state.amount}`);
    if (state.amount > INT_MAX) throw new ValidationError(`amount ${state.amount} exceeds the KCC1 int range`);

    const owner = state.owner;
    if (owner === null || typeof owner !== 'object') throw new ValidationError('owner must be an object');
    if (!(owner.identifier instanceof Uint8Array) || owner.identifier.length !== FIELD_WIDTH) {
      throw new ValidationError(`owner must be a ${FIELD_WIDTH}-byte Uint8Array`);
    }
    if (!Number.isInteger(owner.schemeByte) || owner.schemeByte < 0 || owner.schemeByte > 0xff) {
      throw new ValidationError(`owner_scheme must be a single byte, got ${String(owner.schemeByte)}`);
    }
    const expected = schemes.get(owner.schemeByte);
    if (expected === undefined) {
      throw new ValidationError(`owner_scheme ${hex2(owner.schemeByte)} is not defined by this template (known: ${knownSchemes(schemes)})`);
    }
    if (expected !== owner.semantic) {
      throw new ValidationError(
        `owner_scheme ${hex2(owner.schemeByte)} means '${expected}' under this template, but the state claims '${String(owner.semantic)}'`,
      );
    }

    // The layout cannot express minting; a boolean here is a cross-layout mix-up.
    if (state.mintCapable !== null) {
      throw new ValidationError(`${KCC0020_112_ID} has no minter concept; mintCapable must be null, got ${String(state.mintCapable)}`);
    }

    const extra = state.extra;
    if (extra === null || typeof extra !== 'object') throw new ValidationError('extra must be an object');
    const scheme = extra[EXTRA_BORROW_SCHEME];
    if (!(scheme instanceof Uint8Array) || scheme.length !== 1) {
      throw new ValidationError(`extra.${EXTRA_BORROW_SCHEME} must be a 1-byte Uint8Array`);
    }
    if (!BORROW_SCHEME_NAMES.has(scheme[0]!)) {
      throw new ValidationError(`borrow_scheme ${hex2(scheme[0]!)} is unassigned (known: 0x00..0x03)`);
    }
    for (const key of [EXTRA_BORROW_GUARD, EXTRA_EXTENSION_COMMITMENT]) {
      const v = extra[key];
      if (!(v instanceof Uint8Array) || v.length !== FIELD_WIDTH) {
        throw new ValidationError(`extra.${key} must be a ${FIELD_WIDTH}-byte Uint8Array`);
      }
    }
    const keys = Object.keys(extra);
    if (keys.length !== 3) {
      throw new ValidationError(`extra must hold exactly ${EXTRA_BORROW_SCHEME}, ${EXTRA_BORROW_GUARD}, ${EXTRA_EXTENSION_COMMITMENT}; got ${keys.join(', ')}`);
    }
  },

  /**
   * Owner-path structure of a transfer: counts, shared extension commitment,
   * and one owner requirement per consumed input. The borrowed path, which
   * needs the leader's witness, is `checkTransfer`.
   */
  checkOwnershipTransition(prev: readonly StateSlot[], next: readonly StateSlot[]): AuthRequirement[] {
    checkFamilyShape(prev, next, MAX_TOKEN_INPUTS, MAX_TOKEN_OUTPUTS, KCC2_DEFAULT_SCHEMES);
    return prev.map((slot) => describeAuth(slot.state.owner));
  },

  /** KCC-20 sec 2: the leader MUST preserve the total token amount across the family. */
  checkSupply(prev: readonly StateSlot[], next: readonly StateSlot[]): void {
    if (prev.length === 0) throw new SupplyError('a transition must consume at least one state');
    for (const slot of [...prev, ...next]) this.validate(slot.state);
    checkConservation(prev, next);
  },
};

function checkConservation(prev: readonly StateSlot[], next: readonly StateSlot[]): bigint {
  const totalIn = prev.reduce((acc, s) => acc + s.state.amount, 0n);
  const totalOut = next.reduce((acc, s) => acc + s.state.amount, 0n);
  // KCC-20 sec 2 permits limiting the total input amount to 2^63 - 1; the
  // reference arithmetic is 64-bit, so the limit is enforced.
  if (totalIn > INT_MAX) throw new SupplyError(`total input amount ${totalIn} exceeds the KCC1 int range`);
  if (totalIn !== totalOut) {
    throw new SupplyError(`supply not conserved: in=${totalIn} out=${totalOut} (delta ${totalOut - totalIn})`);
  }
  return totalIn;
}

function checkFamilyShape(
  prev: readonly StateSlot[],
  next: readonly StateSlot[],
  maxIn: number,
  maxOut: number,
  schemes: SchemeMap,
): void {
  if (prev.length === 0) throw new TransferError('a transfer must consume at least one state');
  if (prev.length > maxIn) throw new TransferError(`${prev.length} token inputs exceed max_token_inputs ${maxIn}`);
  if (next.length > maxOut) throw new TransferError(`${next.length} token outputs exceed max_token_outputs ${maxOut}`);
  for (const slot of [...prev, ...next]) kcc0020_112.validate(slot.state, schemes);
  // KCC-20 sec 2: every participant carries the same extension_commitment, preserved unchanged.
  const ext = extensionCommitmentOf(prev[0]!.state);
  for (const slot of prev) {
    if (!bytesEqual(extensionCommitmentOf(slot.state), ext)) {
      throw new TransferError(`input ${slot.index}: extension_commitment differs from the leader's`);
    }
  }
  for (const slot of next) {
    if (!bytesEqual(extensionCommitmentOf(slot.state), ext)) {
      throw new TransferError(`output ${slot.index}: extension_commitment differs from the inputs'`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Witness parsing (KCC-20 sec 2 table, sec 5)                                 */
/* -------------------------------------------------------------------------- */

/** The leader's owner witness on the normal path, by owner scheme. */
export type OwnerWitness =
  | { readonly scheme: 'p2pk-schnorr/v1'; readonly signature: Uint8Array }
  | { readonly scheme: 'p2pkh-schnorr/v1'; readonly pubkey: Uint8Array; readonly signature: Uint8Array }
  | { readonly scheme: 'p2pkh-ecdsa/v1'; readonly pubkey: Uint8Array; readonly signature: Uint8Array }
  | { readonly scheme: 'p2sh/v1'; readonly authorityInputIndex: number }
  | { readonly scheme: 'covenant-id/v1' };

/**
 * Parse the owner-authentication bytes of a normal transfer (everything after
 * the path byte) for the leader's owner. Checks widths and, for the P2PKH
 * schemes, that the revealed key hashes to `owner` (KCC-2: plain BLAKE3).
 * Signatures are not verified.
 */
export function parseOwnerWitness(bytes: Uint8Array, owner: TokenState['owner']): OwnerWitness {
  const want = (n: number, what: string): void => {
    if (bytes.length !== n) {
      throw new TransferError(`${KCC2_SCHEME_NAMES.get(owner.semantic)} owner-authentication bytes must be ${what} (${n} bytes), got ${bytes.length}`);
    }
  };
  switch (owner.semantic) {
    case 'pubkey':
      want(SCHNORR_SIGNATURE_LENGTH, 'a 65-byte signature');
      return { scheme: 'p2pk-schnorr/v1', signature: bytes };
    case 'p2pkh-schnorr': {
      want(SCHNORR_PUBKEY_LENGTH + SCHNORR_SIGNATURE_LENGTH, 'a 32-byte public key then a 65-byte signature');
      const pubkey = bytes.subarray(0, SCHNORR_PUBKEY_LENGTH);
      requireKeyHash(pubkey, owner.identifier);
      return { scheme: 'p2pkh-schnorr/v1', pubkey, signature: bytes.subarray(SCHNORR_PUBKEY_LENGTH) };
    }
    case 'p2pkh-ecdsa': {
      want(ECDSA_PUBKEY_LENGTH + SCHNORR_SIGNATURE_LENGTH, 'a 33-byte compressed public key then a 65-byte signature');
      const pubkey = bytes.subarray(0, ECDSA_PUBKEY_LENGTH);
      requireKeyHash(pubkey, owner.identifier);
      return { scheme: 'p2pkh-ecdsa/v1', pubkey, signature: bytes.subarray(ECDSA_PUBKEY_LENGTH) };
    }
    case 'script-hash':
      want(1, 'one unsigned byte, the authority input index');
      return { scheme: 'p2sh/v1', authorityInputIndex: bytes[0]! };
    case 'covenant-id':
      want(0, 'empty');
      return { scheme: 'covenant-id/v1' };
  }
}

function requireKeyHash(pubkey: Uint8Array, owner: Uint8Array): void {
  const h = blake3(pubkey);
  if (!bytesEqual(h, owner)) {
    throw new TransferError(`revealed public key hashes to ${toHex(h)}, but the state's owner is ${toHex(owner)}`);
  }
}

/** The leader's witness on the borrowed path, by borrow scheme. */
export type BorrowWitness =
  | { readonly scheme: 'amount-threshold/v1' }
  | { readonly scheme: 'schnorr-signature/v1'; readonly signature: Uint8Array }
  | {
      readonly scheme: 'hash-chain/v1';
      readonly nextBorrowGuard: Uint8Array;
      readonly oneTimePubkey: Uint8Array;
      readonly signature: Uint8Array;
    };

/** Parse `borrow_witness = witness[1..]` for a borrow scheme (KCC-20 sec 5 table). */
export function parseBorrowWitness(bytes: Uint8Array, borrowScheme: number): BorrowWitness {
  switch (borrowScheme) {
    case BORROW_DISABLED:
      throw new TransferError('borrow_scheme is disabled/v1: borrowing is rejected');
    case BORROW_AMOUNT_THRESHOLD:
      if (bytes.length !== 0) throw new TransferError(`amount-threshold/v1 borrow witness must be empty, got ${bytes.length} bytes`);
      return { scheme: 'amount-threshold/v1' };
    case BORROW_SCHNORR_SIGNATURE:
      if (bytes.length !== SCHNORR_SIGNATURE_LENGTH) {
        throw new TransferError(`schnorr-signature/v1 borrow witness must be a 65-byte signature, got ${bytes.length} bytes`);
      }
      return { scheme: 'schnorr-signature/v1', signature: bytes };
    case BORROW_HASH_CHAIN:
      if (bytes.length !== HASH_CHAIN_WITNESS_LENGTH) {
        throw new TransferError(`hash-chain/v1 borrow witness must be exactly ${HASH_CHAIN_WITNESS_LENGTH} bytes, got ${bytes.length}`);
      }
      return {
        scheme: 'hash-chain/v1',
        nextBorrowGuard: bytes.subarray(0, 32),
        oneTimePubkey: bytes.subarray(32, 64),
        signature: bytes.subarray(64),
      };
    default:
      throw new TransferError(`borrow_scheme ${hex2(borrowScheme)} is unassigned`);
  }
}

/** hash-chain/v1 link: `x_i = Hash(x_(i-1) || pubkey_i)`, unkeyed BLAKE3. */
export function hashChainLink(previous: Uint8Array, pubkey: Uint8Array): Uint8Array {
  if (previous.length !== FIELD_WIDTH || pubkey.length !== SCHNORR_PUBKEY_LENGTH) {
    throw new ValidationError(`hash-chain link needs a 32-byte value and a 32-byte key, got ${previous.length} and ${pubkey.length}`);
  }
  return blake3(concat(previous, pubkey));
}

/* -------------------------------------------------------------------------- */
/* Transfer check                                                              */
/* -------------------------------------------------------------------------- */

/** A family member with, where known, the KAS value of its cell (needed by the borrowed-receive rule). */
export interface FamilySlot extends StateSlot {
  readonly kasValue?: bigint;
}

/** A token-family transfer as `checkTransfer` sees it. */
export interface Transfer {
  /** Family inputs in KIP-20 shared-context order; `inputs[0]` is the leader. */
  readonly inputs: readonly FamilySlot[];
  /** Family continuation outputs in covenant-family output order (= `next_states`). */
  readonly outputs: readonly FamilySlot[];
  /** The leader's complete `witness` argument, path byte first. */
  readonly witness: Uint8Array;
  /** The family's covenant id; when given, outputs are checked for the self-owned footgun. */
  readonly covenantId?: Uint8Array;
  /** Owner schemes the program supports; defaults to the KCC-2 default set. */
  readonly schemes?: SchemeMap;
  /** Family input bound; defaults to `MAX_TOKEN_INPUTS`. */
  readonly maxTokenInputs?: number;
  /** Family output bound; defaults to `MAX_TOKEN_OUTPUTS`. */
  readonly maxTokenOutputs?: number;
}

/** What authorizes the leader input: its owner (normal path) or its borrow scheme (borrowed path). */
export type LeaderAuthorization =
  | { readonly kind: 'owner'; readonly requirement: AuthRequirement; readonly witness: OwnerWitness }
  | {
      readonly kind: 'borrow';
      readonly scheme: number;
      readonly schemeName: string;
      readonly witness: BorrowWitness;
      /** `next_states[0].amount - leader.amount`, already checked against the threshold. */
      readonly increase: bigint;
      readonly effectiveThreshold: bigint;
      /** The key a transaction validator must verify `signature` against, when the scheme has one. */
      readonly signer?: Uint8Array;
    };

/** The result of `checkTransfer`: what must authorize each input. */
export interface TransferCheck {
  /** The witness path the leader took. */
  readonly path: 'normal' | 'borrowed';
  /** How the leader is authorized. */
  readonly leader: LeaderAuthorization;
  /** Owner requirements of `inputs[1..]`, each authenticated by its own `transfer_delegator` witness. */
  readonly delegators: readonly AuthRequirement[];
  /** Total tokens moved (inputs = outputs). */
  readonly totalAmount: bigint;
  /** Indices (into `outputs`) of self-owned cells; empty when `covenantId` was not given. */
  readonly selfOwnedOutputs: readonly number[];
}

/**
 * Check a KCC-20 transfer the way the leader does (KCC-20 sec 2 and sec 5),
 * minus signature verification: counts, state validity, shared extension
 * commitment, amount conservation, the witness path, and -- on the borrowed
 * path -- every borrowed-receive condition. Throws a LayoutError subclass on
 * the first violation; returns what a transaction validator still has to
 * prove.
 */
export function checkTransfer(t: Transfer): TransferCheck {
  const schemes = t.schemes ?? KCC2_DEFAULT_SCHEMES;
  const maxIn = t.maxTokenInputs ?? MAX_TOKEN_INPUTS;
  const maxOut = t.maxTokenOutputs ?? MAX_TOKEN_OUTPUTS;
  checkFamilyShape(t.inputs, t.outputs, maxIn, maxOut, schemes);
  const totalAmount = checkConservation(t.inputs, t.outputs);

  if (!(t.witness instanceof Uint8Array) || t.witness.length === 0) {
    throw new TransferError('leader witness must carry a path byte');
  }
  const path = t.witness[0]!;
  const rest = t.witness.subarray(1);
  const leaderState = t.inputs[0]!.state;

  let leader: LeaderAuthorization;
  let pathName: TransferCheck['path'];
  if (path === WITNESS_PATH_NORMAL) {
    pathName = 'normal';
    leader = { kind: 'owner', requirement: describeAuth(leaderState.owner), witness: parseOwnerWitness(rest, leaderState.owner) };
  } else if (path === WITNESS_PATH_BORROW) {
    pathName = 'borrowed';
    leader = checkBorrowedReceive(t.inputs[0]!, t.outputs[0], rest);
  } else {
    throw new TransferError(`witness path byte ${hex2(path)} is reserved`);
  }

  const selfOwnedOutputs: number[] = [];
  if (t.covenantId !== undefined) {
    t.outputs.forEach((slot, i) => {
      if (isSelfOwned(slot.state, t.covenantId!)) selfOwnedOutputs.push(i);
    });
  }

  return {
    path: pathName,
    leader,
    delegators: t.inputs.slice(1).map((slot) => describeAuth(slot.state.owner)),
    totalAmount,
    selfOwnedOutputs,
  };
}

/** KCC-20 sec 5, the normative pseudocode, over an already shape-checked family. */
function checkBorrowedReceive(leader: FamilySlot, successor: FamilySlot | undefined, borrowWitness: Uint8Array): LeaderAuthorization {
  if (successor === undefined) throw new TransferError('a borrowed receive needs a successor at next_states[0]');
  const from = leader.state;
  const to = successor.state;
  const scheme = borrowSchemeOf(from);
  const guard = borrowGuardOf(from);

  const witness = parseBorrowWitness(borrowWitness, scheme);
  let amountThreshold = 0n;
  let nextBorrowGuard = guard;
  let signer: Uint8Array | undefined;
  switch (witness.scheme) {
    case 'amount-threshold/v1':
      amountThreshold = decodeThresholdGuard(guard).effective;
      break;
    case 'schnorr-signature/v1':
      signer = guard;
      break;
    case 'hash-chain/v1': {
      const link = hashChainLink(witness.nextBorrowGuard, witness.oneTimePubkey);
      if (!bytesEqual(link, guard)) {
        throw new TransferError(`revealed link hashes to ${toHex(link)}, not to the leader's borrow_guard ${toHex(guard)}`);
      }
      nextBorrowGuard = witness.nextBorrowGuard;
      signer = witness.oneTimePubkey;
      break;
    }
  }

  const increase = to.amount - from.amount;
  if (increase < 0n) {
    throw new TransferError(`borrowed successor amount ${to.amount} is smaller than the leader's ${from.amount}`);
  }
  if (increase <= amountThreshold) {
    throw new TransferError(`amount increase ${increase} does not strictly exceed the effective threshold ${amountThreshold}`);
  }
  if (!bytesEqual(to.owner.identifier, from.owner.identifier)) throw new TransferError('borrowed successor does not preserve owner');
  if (to.owner.schemeByte !== from.owner.schemeByte) throw new TransferError('borrowed successor does not preserve owner_scheme');
  if (borrowSchemeOf(to) !== scheme) throw new TransferError('borrowed successor does not preserve borrow_scheme');
  if (!bytesEqual(borrowGuardOf(to), nextBorrowGuard)) {
    throw new TransferError(`borrowed successor does not carry the expected next_borrow_guard ${toHex(nextBorrowGuard)}`);
  }
  // extension_commitment equality is already enforced family-wide by checkFamilyShape.
  if (leader.kasValue !== undefined && successor.kasValue !== undefined && successor.kasValue < leader.kasValue) {
    throw new TransferError(
      `borrowed successor output carries ${successor.kasValue} sompi, less than the borrowed input's ${leader.kasValue}`,
    );
  }

  return {
    kind: 'borrow',
    scheme,
    schemeName: BORROW_SCHEME_NAMES.get(scheme)!,
    witness,
    increase,
    effectiveThreshold: amountThreshold,
    ...(signer === undefined ? {} : { signer }),
  };
}

/* -------------------------------------------------------------------------- */
/* Invocation arguments (KCC-1 sec 3.4.6 record arrays)                        */
/* -------------------------------------------------------------------------- */

/** Encoded `transfer(next_states, witness)` arguments. */
export interface TransferArguments {
  /** One PushMinimal per KCC20State field, each over the field concatenated across all records. */
  readonly groupedFieldPushes: readonly Uint8Array[];
  /** PushMinimal of the witness. */
  readonly witnessPush: Uint8Array;
  /** `OP_DATA_4 || tag`, i.e. PushMinimal of the 4-byte transfer tag. */
  readonly dispatchTagPush: Uint8Array;
  /** `PushArguments(next_states, witness) || dispatch tag push`; the program push `PushMinimal(R)` follows it in a sigscript. */
  readonly bytes: Uint8Array;
}

/** Encode `transfer(next_states, witness)` arguments. Every state is validated first. */
export function encodeTransferArguments(
  nextStates: readonly TokenState[],
  witness: Uint8Array,
  schemes: SchemeMap = KCC2_DEFAULT_SCHEMES,
): TransferArguments {
  if (nextStates.length > MAX_TOKEN_OUTPUTS) {
    throw new TransferError(`${nextStates.length} next_states exceed max_token_outputs ${MAX_TOKEN_OUTPUTS}`);
  }
  const fields = nextStates.map((s) => kcc0020Fields(s, schemes));
  const group = (f: (x: Kcc0020Fields) => Uint8Array): Uint8Array => encodePushMinimal(concat(...fields.map(f)));
  const groupedFieldPushes = [
    group((f) => encodeIntState(f.amount)),
    group((f) => f.owner),
    group((f) => Uint8Array.of(f.ownerScheme)),
    group((f) => Uint8Array.of(f.borrowScheme)),
    group((f) => f.borrowGuard),
    group((f) => f.extensionCommitment),
  ];
  const witnessPush = encodePushMinimal(witness);
  const dispatchTagPush = encodePushMinimal(fromHex(KCC0020_DISPATCH.transfer.tagHex));
  return {
    groupedFieldPushes,
    witnessPush,
    dispatchTagPush,
    bytes: concat(...groupedFieldPushes, witnessPush, dispatchTagPush),
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const hex2 = (b: number): string => '0x' + b.toString(16).padStart(2, '0');
const knownSchemes = (schemes: SchemeMap): string => [...schemes.keys()].map(hex2).join(', ');

function extraByte(state: TokenState, key: string): number {
  const v = state.extra?.[key];
  if (!(v instanceof Uint8Array) || v.length !== 1) throw new ValidationError(`extra.${key} must be a 1-byte Uint8Array`);
  return v[0]!;
}

function extra32(state: TokenState, key: string): Uint8Array {
  const v = state.extra?.[key];
  if (!(v instanceof Uint8Array) || v.length !== FIELD_WIDTH) throw new ValidationError(`extra.${key} must be a ${FIELD_WIDTH}-byte Uint8Array`);
  return v;
}
