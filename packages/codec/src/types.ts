/**
 * The layout seam.
 *
 * Everything above this file speaks `TokenState` and never touches bytes.
 * Everything spec-dependent lives behind `LayoutCodec`, so adding the
 * KCC-0020 `kcc0020-112` layout later is a new file plus a registry entry --
 * not a refactor of the launchpad.
 *
 * The two layouts genuinely disagree, which is why the domain type is a
 * superset rather than either layout's field list:
 *
 *   kcc20-46    (de-facto)  amount, owner, identifierType, isMinter
 *   kcc0020-112 (KCC-0020)  amount, owner, owner_scheme, borrow_scheme,
 *                           borrow_guard, extension_commitment  -- NO isMinter
 *
 * KCC-0020 has no supply or minting model at all (confirmed: no issuance KCC
 * exists in kaspanet/kccs, merged or proposed). So `mintCapable` is `null` on
 * any layout that cannot express it, and our provable-fixed-supply guarantee
 * is expressible ONLY on kcc20-46 today.
 */

import type { AuthRequirement } from './auth.ts';

/** What an owner identifier means. Never inferred -- always supplied by a verified template. */
export type OwnerSemantic =
  | 'pubkey'            // legacy 0x00 / KCC2 p2pk-schnorr
  | 'script-hash'       // legacy 0x01 / KCC2 p2sh
  | 'covenant-id'       // legacy 0x02 / KCC2 covenant-id
  | 'p2pkh-schnorr'     // KCC2 only
  | 'p2pkh-ecdsa';      // KCC2 only

/** Verified scheme-byte -> meaning map. Comes from a template descriptor or a codec's reference map. */
export type SchemeMap = ReadonlyMap<number, OwnerSemantic>;

/** A token cell's owner: the raw scheme byte, its verified meaning and the identifier. */
export interface OwnerRef {
  /** The raw scheme byte as stored in state. Meaningless without a template. */
  readonly schemeByte: number;
  /** The resolved meaning, from the verified template descriptor. */
  readonly semantic: OwnerSemantic;
  /** 32-byte identifier: pubkey, script hash, or covenant id. */
  readonly identifier: Uint8Array;
}

/** A token cell's state in layout-independent form. */
export interface TokenState {
  /** The layout codec that produced it. */
  readonly layoutId: string;
  /** Whole tokens held by the cell. */
  readonly amount: bigint;
  /** The cell's owner. */
  readonly owner: OwnerRef;
  /**
   * Whether this cell may create supply.
   * `true`/`false` on kcc20-46; `null` where the layout cannot express it.
   * `null` must never be treated as `false`.
   */
  readonly mintCapable: boolean | null;
  /** Layout-specific fields with no cross-layout meaning (e.g. -112 borrow guard). */
  readonly extra: Readonly<Record<string, Uint8Array>>;
}

/** A state plus where it sits in a transition, for supply and ownership checks. */
export interface StateSlot {
  readonly state: TokenState;
  /** Position within the covenant family (KIP-20 shared context order). */
  readonly index: number;
}

/**
 * The five operations every layout must provide.
 * Named exactly as specified: encode / decode / validate /
 * checkOwnershipTransition / checkSupply.
 */
export interface LayoutCodec {
  readonly id: string;
  /** Exact encoded-state byte length. Half of the (length, templateHash) key. */
  readonly stateLength: number;
  /**
   * The codec's reference scheme map: what each scheme byte means under the
   * reference program family. `validate`/`encode` fall back to it when no
   * template-specific map is supplied, so a state can never carry a
   * (schemeByte, semantic) pair the layout does not define.
   */
  readonly referenceSchemes: SchemeMap;

  /**
   * State -> canonical KCC1 encoded-state bytes. Validates first (see
   * `validate`); `schemes` defaults to `referenceSchemes`.
   */
  encode(state: TokenState, schemes?: SchemeMap): Uint8Array;

  /**
   * Encoded-state bytes -> state.
   * `schemes` comes from a verified template; decode never guesses semantics.
   * Rejects malformed pushes, wrong widths, and trailing bytes.
   */
  decode(stateBytes: Uint8Array, schemes: SchemeMap): TokenState;

  /**
   * Layout invariants for a single state: field types, non-negative in-range
   * amount, identifier width, scheme byte in range AND consistent with its
   * semantic under `schemes` (default: `referenceSchemes`).
   */
  validate(state: TokenState, schemes?: SchemeMap): void;

  /**
   * Structural ownership rules for a transition, and what must authorize it.
   * Returns one requirement per consumed state; it does NOT verify signatures
   * (that needs full transaction context and belongs to the tx validator).
   */
  checkOwnershipTransition(prev: readonly StateSlot[], next: readonly StateSlot[]): AuthRequirement[];

  /** Supply conservation and the minter rule for a transition. Validates every slot first. */
  checkSupply(prev: readonly StateSlot[], next: readonly StateSlot[]): void;
}

/** A contiguous byte range of a covenant program: the KCC-1 state window a template hash is cut on. */
export interface StateWindow {
  readonly start: number;
  readonly length: number;
}

/**
 * A program whose state offset and identifier semantics have been verified by
 * disassembly. Decoding is allowed ONLY for registered templates.
 */
export interface TemplateDescriptor {
  /**
   * KCC-1 sec 3.7.3 TemplateHash of the program with the state window cut
   * out, lowercase hex. This is what kascov reports as `kcc1_template_hash`.
   * The registry recomputes it from program bytes; it is never trusted from a
   * caller.
   */
  readonly templateHash: string;
  readonly layoutId: string;
  /** Byte offset of the encoded state the codec reads, within the redeem script. */
  readonly stateOffset: number;
  readonly stateLength: number;
  /**
   * The window `templateHash` is cut on, when it is wider than the codec's
   * state (a KCC-1 sec 3.7.4 template view). Defaults to
   * `[stateOffset, stateOffset + stateLength)`. Must contain the codec window.
   */
  readonly hashWindow?: StateWindow;
  /**
   * Bytes the program MUST start with, lowercase hex (e.g. `6b` for the
   * OpToAltStack prefix of the offset-1 reference family). Checked on every
   * decode in addition to the hash, so a descriptor's stated layout and the
   * bytes it is applied to can never silently drift apart.
   */
  readonly prefixHex?: string;
  /** Verified identifier-byte -> meaning map for THIS program. */
  readonly schemes: SchemeMap;
  /**
   * Set when the template is recognised (hash verified, layout known) but no
   * codec can decode it yet. The value is the reason. Such a template is
   * identified by the registry but never decoded.
   */
  readonly recognisedOnly?: string;
  /** How this entry was verified, so a reviewer can re-check it. */
  readonly provenance: string;
}

/** A known-but-rejected program: the registry names it so the error can say why. */
export interface QuarantinedTemplate {
  readonly templateHash: string;
  readonly reason: string;
  /** The window the hash is cut on, so the registry can recognise the program from its bytes. */
  readonly window: StateWindow;
}
