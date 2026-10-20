/**
 * kcc20-46 -- the de-facto layout, and the first implementation of LayoutCodec.
 *
 * Field order was confirmed against LIVE on-chain bytecode (testnet-10
 * covenant 5f381583..8445), not inferred from the reference .sil source:
 *
 *   6b                            OpToAltStack (template prefix, offset varies)
 *   20 <32 bytes>   ownerIdentifier   byte[32]   33 bytes
 *   01 <1 byte>     identifierType    byte        2 bytes
 *   08 <8 bytes>    amount            int         9 bytes
 *   01 <1 byte>     isMinter          bool        2 bytes
 *                                                = 46 bytes
 *
 * The program's own offset constants (0x20, 0x23, 0x25, 0x2e) land exactly on
 * these boundaries, and 0x2e = 46 = total state length.
 *
 * Supply rules mirror kcc20.sil:
 *   checkAmounts          non-minter leader => sum(in) == sum(out)
 *   checkMintingTransfer  non-minter leader => no output may be a minter
 * A minter cell is unconstrained in both respects. Both rules key on the
 * LEADER (prev[0], the authorizing input in KIP-20 order) and on nothing else:
 * a 0-amount minter co-input behind a non-minter leader does not lift the
 * conservation rule.
 */

import { DecodeError, OwnershipError, SupplyError, ValidationError } from './errors.ts';
import {
  INT_MAX, concat, decodeBoolState, decodeIntState, encodeBoolState, encodeIntState,
  encodePushExplicit, readPushExplicit, toHex,
} from './push.ts';
import { describeAuth, type AuthRequirement } from './auth.ts';
import type { LayoutCodec, OwnerSemantic, SchemeMap, StateSlot, TokenState } from './types.ts';

/** Layout id of the de-facto 46-byte KCC-20 state. */
export const KCC20_46_ID = 'kcc20-46';
/** Length of a `kcc20-46` state, in bytes. */
export const KCC20_46_STATE_LENGTH = 46;
const IDENTIFIER_WIDTH = 32;

/**
 * Identifier semantics of the REFERENCE program family (kcc20.sil): three
 * branches only. Registered per-template -- never applied to a program that
 * has not been disassembled and verified.
 */
export const REFERENCE_SCHEMES: SchemeMap = new Map<number, OwnerSemantic>([
  [0x00, 'pubkey'],
  [0x01, 'script-hash'],
  [0x02, 'covenant-id'],
]);

const hex2 = (b: number): string => '0x' + b.toString(16).padStart(2, '0');

/** The `kcc20-46` layout codec. */
export const kcc20_46: LayoutCodec = {
  id: KCC20_46_ID,
  stateLength: KCC20_46_STATE_LENGTH,
  referenceSchemes: REFERENCE_SCHEMES,

  encode(state: TokenState, schemes: SchemeMap = REFERENCE_SCHEMES): Uint8Array {
    // Every invariant -- including scheme byte <-> semantic consistency -- is
    // checked before a single byte is written.
    this.validate(state, schemes);
    if (state.mintCapable === null) {
      throw new ValidationError(`${KCC20_46_ID} requires an explicit isMinter; refusing to encode mintCapable=null`);
    }

    const bytes = concat(
      encodePushExplicit(state.owner.identifier),
      encodePushExplicit(Uint8Array.of(state.owner.schemeByte)),
      encodePushExplicit(encodeIntState(state.amount)),
      encodePushExplicit(encodeBoolState(state.mintCapable)),
    );
    if (bytes.length !== KCC20_46_STATE_LENGTH) {
      throw new ValidationError(`encoded ${bytes.length} bytes, expected ${KCC20_46_STATE_LENGTH}`);
    }
    return bytes;
  },

  decode(stateBytes: Uint8Array, schemes: SchemeMap): TokenState {
    if (stateBytes.length !== KCC20_46_STATE_LENGTH) {
      throw new DecodeError(`${KCC20_46_ID} state must be exactly ${KCC20_46_STATE_LENGTH} bytes, got ${stateBytes.length}`);
    }

    const f0 = readPushExplicit(stateBytes, 0);
    if (f0.payload.length !== IDENTIFIER_WIDTH) {
      throw new DecodeError(`ownerIdentifier must be ${IDENTIFIER_WIDTH} bytes, got ${f0.payload.length}`);
    }
    const f1 = readPushExplicit(stateBytes, f0.next);
    if (f1.payload.length !== 1) {
      throw new DecodeError(`identifierType must be 1 byte, got ${f1.payload.length}`);
    }
    const f2 = readPushExplicit(stateBytes, f1.next);
    const amount = decodeIntState(f2.payload);
    const f3 = readPushExplicit(stateBytes, f2.next);
    const isMinter = decodeBoolState(f3.payload);

    // KCC1 sec 3.7.1: a decoder MUST reject trailing bytes.
    if (f3.next !== stateBytes.length) {
      throw new DecodeError(`trailing bytes: consumed ${f3.next} of ${stateBytes.length}`);
    }

    const schemeByte = f1.payload[0]!;
    const semantic = schemes.get(schemeByte);
    if (semantic === undefined) {
      // Never guess. 107 live tokens use 0x03 under programs that branch on
      // four identifier types; the reference program defines only three.
      throw new DecodeError(
        `identifierType 0x${schemeByte.toString(16).padStart(2, '0')} is not defined by this template ` +
          `(known: ${[...schemes.keys()].map((k) => '0x' + k.toString(16).padStart(2, '0')).join(', ')}). ` +
          `Refusing to guess an owner.`,
      );
    }
    if (amount < 0n) {
      throw new DecodeError(`negative amount ${amount} in state ${toHex(stateBytes)}`);
    }

    return {
      layoutId: KCC20_46_ID,
      amount,
      owner: { schemeByte, semantic, identifier: Uint8Array.from(f0.payload) },
      mintCapable: isMinter,
      extra: Object.freeze({}),
    };
  },

  validate(state: TokenState, schemes: SchemeMap = REFERENCE_SCHEMES): void {
    if (state === null || typeof state !== 'object') throw new ValidationError('state must be an object');
    if (state.layoutId !== KCC20_46_ID) throw new ValidationError(`expected ${KCC20_46_ID}, got ${String(state.layoutId)}`);

    if (typeof state.amount !== 'bigint') {
      throw new ValidationError(`amount must be a bigint, got ${typeof state.amount}`);
    }
    if (state.amount < 0n) throw new ValidationError(`amount must be non-negative, got ${state.amount}`);
    if (state.amount > INT_MAX) throw new ValidationError(`amount ${state.amount} exceeds the KCC1 int range`);

    const owner = state.owner;
    if (owner === null || typeof owner !== 'object') throw new ValidationError('owner must be an object');
    if (!(owner.identifier instanceof Uint8Array) || owner.identifier.length !== IDENTIFIER_WIDTH) {
      throw new ValidationError(`ownerIdentifier must be a ${IDENTIFIER_WIDTH}-byte Uint8Array`);
    }
    if (!Number.isInteger(owner.schemeByte) || owner.schemeByte < 0 || owner.schemeByte > 0xff) {
      throw new ValidationError(`identifierType must be a single byte, got ${String(owner.schemeByte)}`);
    }
    // The scheme byte and the semantic must agree under the map that governs
    // this state. A state claiming 0x02/'pubkey' would encode as a
    // covenant-owned cell while the app treats it as key-owned.
    const expected = schemes.get(owner.schemeByte);
    if (expected === undefined) {
      throw new ValidationError(
        `identifierType ${hex2(owner.schemeByte)} is not defined by this template ` +
          `(known: ${[...schemes.keys()].map(hex2).join(', ')})`,
      );
    }
    if (expected !== owner.semantic) {
      throw new ValidationError(
        `identifierType ${hex2(owner.schemeByte)} means '${expected}' under this template, ` +
          `but the state claims '${String(owner.semantic)}'`,
      );
    }

    if (typeof state.mintCapable !== 'boolean') {
      throw new ValidationError(`${KCC20_46_ID} always carries isMinter; got ${String(state.mintCapable)}`);
    }
  },

  checkOwnershipTransition(prev: readonly StateSlot[], next: readonly StateSlot[]): AuthRequirement[] {
    if (prev.length === 0) throw new OwnershipError('a transition must consume at least one state');
    for (const slot of [...prev, ...next]) this.validate(slot.state);

    // kcc20.sil checkMintingTransfer: a non-minter leader may not mint authority.
    const leader = prev[0]!.state;
    if (leader.mintCapable === false) {
      for (const slot of next) {
        if (slot.state.mintCapable === true) {
          throw new OwnershipError(
            `non-minter leader may not create a minter successor (output index ${slot.index})`,
          );
        }
      }
    }
    return prev.map((slot) => describeAuth(slot.state.owner));
  },

  checkSupply(prev: readonly StateSlot[], next: readonly StateSlot[]): void {
    if (prev.length === 0) throw new SupplyError('a transition must consume at least one state');
    // Validate before arithmetic: a null mintCapable or foreign layoutId must
    // never reach the sums as if it were a well-formed non-minter.
    for (const slot of [...prev, ...next]) this.validate(slot.state);

    // kcc20.sil checkAmounts keys on the LEADER only. A minter elsewhere in
    // the input set does not relax conservation.
    const leader = prev[0]!.state;
    if (leader.mintCapable === true) return; // a minter branch may increase or decrease supply

    const totalIn = prev.reduce((acc, s) => acc + s.state.amount, 0n);
    const totalOut = next.reduce((acc, s) => acc + s.state.amount, 0n);
    if (totalIn !== totalOut) {
      throw new SupplyError(`supply not conserved: in=${totalIn} out=${totalOut} (delta ${totalOut - totalIn})`);
    }
  },
};

/**
 * Our anti-rug guarantee, stated as a check.
 *
 * Soundness (kcc20-46 only): a non-minter cell can never create a minter
 * successor (checkMintingTransfer), and only a minter can create a minter.
 * Therefore once no live cell is a minter, none can ever exist again, and
 * non-minter transfers conserve supply -- so total supply is permanently fixed.
 *
 * This is the 5% minority pattern on testnet-10. The 95% majority keeps a live
 * minter branch and bounds issuance with a controller covenant, which a generic
 * indexer cannot verify.
 */
export function assertSupplyPermanentlyFixed(liveStates: readonly TokenState[]): void {
  const minters = liveStates.filter((s) => s.mintCapable === true);
  if (minters.length > 0) {
    throw new SupplyError(
      `supply is NOT provably fixed: ${minters.length} live minter cell(s) remain. ` +
        `Retire minting by spending every minter cell without creating a minter successor.`,
    );
  }
  const unknown = liveStates.filter((s) => s.mintCapable === null);
  if (unknown.length > 0) {
    throw new SupplyError(
      `cannot prove fixed supply: ${unknown.length} state(s) use a layout with no minter concept ` +
        `(mintCapable=null). KCC-0020 has no supply model; this guarantee is kcc20-46 only.`,
    );
  }
}
