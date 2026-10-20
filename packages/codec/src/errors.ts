/**
 * Layout errors. Every one of these is a HARD failure by design.
 *
 * Funds-safety rule (non-negotiable): we never guess a layout and never guess
 * an owner. On testnet-10 at least five distinct programs share the 46-byte
 * `kcc20-46` state layout, and they do not agree on what an identifier byte
 * means -- the `0x03` family branches on four identifier types where the
 * reference program branches on three. Resolving an owner from the leading
 * byte would silently report the WRONG OWNER for 107 live tokens.
 */

/** Base class of every codec error; `name` is the concrete class name. */
export class LayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The template hash is not on the verified allowlist. Never fall back. */
export class UnknownTemplateError extends LayoutError {
  readonly templateHash: string;
  constructor(templateHash: string) {
    super(
      `unknown template hash ${templateHash}: refusing to decode. ` +
        `A program is decodable only after its state offset and identifier ` +
        `semantics have been verified and registered. Never infer them.`,
    );
    this.templateHash = templateHash;
  }
}

/**
 * The caller asserted a template hash, but the hash recomputed from the
 * program bytes (KCC-1 sec 3.7.3) is a different, registered template.
 */
export class TemplateMismatchError extends LayoutError {
  readonly expected: string;
  readonly computed: string;
  constructor(expected: string, computed: string) {
    super(`template hash mismatch: caller asserted ${expected} but the program hashes to ${computed}`);
    this.expected = expected;
    this.computed = computed;
  }
}

/** The template is recognised (hash verified) but no codec exists for its layout yet. */
export class TemplateNotDecodableError extends LayoutError {
  readonly templateHash: string;
  constructor(templateHash: string, reason: string) {
    super(`template ${templateHash} is recognised but not decodable: ${reason}`);
    this.templateHash = templateHash;
  }
}

/** Bytes are not a canonical KCC1 encoding (malformed push, bad payload, trailing bytes). */
export class DecodeError extends LayoutError {}

/** A decoded or constructed state violates a layout invariant. */
export class ValidationError extends LayoutError {}

/** A proposed transition breaks supply conservation or the minter rule. */
export class SupplyError extends LayoutError {}

/** A proposed transition breaks an ownership rule. */
export class OwnershipError extends LayoutError {}

/**
 * A proposed KCC-20 transfer breaks a structural rule of the transfer
 * interface: input or output counts, the witness path byte, the shared
 * extension commitment, or a borrowed-receive condition (KCC-20 sec 2, sec 5).
 */
export class TransferError extends LayoutError {}
