/**
 * The safety gate. All decoding goes through here.
 *
 * Hard rule: a layout is identified by its KCC-1 template hash, RECOMPUTED
 * from the program bytes (sec 3.7.3), and by nothing else. We never trust a
 * caller-supplied hash, never sniff a leading byte, never fall back to a
 * "default" layout, and never decode a template we have not verified.
 *
 * Identification: every registered or quarantined template declares the
 * state window its hash is cut on. For a program we hash it once per distinct
 * window (three on testnet-10 today) and look each result up. A caller MAY
 * still pass the hash it believes applies; that is an assertion we check, not
 * an input we act on.
 */

import {
  DecodeError, TemplateMismatchError, TemplateNotDecodableError, UnknownTemplateError,
} from './errors.ts';
import { toHex } from './push.ts';
import { TEMPLATE_HASH_RE, templateHashOfProgram } from './template-hash.ts';
import type { LayoutCodec, QuarantinedTemplate, StateWindow, TemplateDescriptor, TokenState } from './types.ts';

function windowOf(d: TemplateDescriptor): StateWindow {
  return d.hashWindow ?? { start: d.stateOffset, length: d.stateLength };
}

function assertWindow(w: StateWindow, what: string): void {
  if (!Number.isInteger(w.start) || w.start < 0 || !Number.isInteger(w.length) || w.length < 0) {
    throw new Error(`${what}: invalid state window start=${w.start} length=${w.length}`);
  }
}

/**
 * Maps verified template hashes to layout codecs. A template is decoded only when its hash is registered; an unknown
 * or quarantined hash is refused, never guessed.
 */
export class LayoutRegistry {
  readonly #codecs = new Map<string, LayoutCodec>();
  readonly #templates = new Map<string, TemplateDescriptor>();
  readonly #quarantine = new Map<string, string>();
  /** Distinct hash windows, keyed "start:length". */
  readonly #windows = new Map<string, StateWindow>();

  registerCodec(codec: LayoutCodec): this {
    this.#codecs.set(codec.id, codec);
    return this;
  }

  registerTemplate(descriptor: TemplateDescriptor): this {
    const hash = descriptor.templateHash;
    if (!TEMPLATE_HASH_RE.test(hash)) {
      throw new Error(`cannot register template: hash must match ^[0-9a-f]{64}$, got "${hash}"`);
    }
    if (this.#templates.has(hash) || this.#quarantine.has(hash)) {
      throw new Error(`template ${hash} is already registered; refusing to overwrite`);
    }
    assertWindow({ start: descriptor.stateOffset, length: descriptor.stateLength }, `template ${hash}`);
    const window = windowOf(descriptor);
    assertWindow(window, `template ${hash} hashWindow`);
    if (
      descriptor.stateOffset < window.start ||
      descriptor.stateOffset + descriptor.stateLength > window.start + window.length
    ) {
      throw new Error(`template ${hash}: codec state window must lie inside the hash window`);
    }
    if (descriptor.prefixHex !== undefined) {
      // The prefix check covers bytes before the codec's state; it may reach
      // into the hash window (e.g. the `20` push opcode of a context field).
      if (!/^([0-9a-f]{2})*$/.test(descriptor.prefixHex) || descriptor.prefixHex.length / 2 > descriptor.stateOffset) {
        throw new Error(`template ${hash}: prefixHex must be lowercase hex and end before stateOffset`);
      }
    }

    if (descriptor.recognisedOnly === undefined) {
      const codec = this.#codecs.get(descriptor.layoutId);
      if (!codec) {
        throw new Error(`cannot register template ${hash}: no codec for layout ${descriptor.layoutId}`);
      }
      if (descriptor.stateLength !== codec.stateLength) {
        throw new Error(
          `template ${hash} declares stateLength ${descriptor.stateLength} but codec ` +
            `${codec.id} uses ${codec.stateLength}`,
        );
      }
    }

    this.#templates.set(hash, descriptor);
    this.#addWindow(window);
    return this;
  }

  quarantineTemplate(q: QuarantinedTemplate): this {
    if (!TEMPLATE_HASH_RE.test(q.templateHash)) {
      throw new Error(`cannot quarantine template: hash must match ^[0-9a-f]{64}$, got "${q.templateHash}"`);
    }
    if (this.#templates.has(q.templateHash) || this.#quarantine.has(q.templateHash)) {
      throw new Error(`template ${q.templateHash} is already registered; refusing to overwrite`);
    }
    assertWindow(q.window, `quarantined template ${q.templateHash}`);
    this.#quarantine.set(q.templateHash, q.reason);
    this.#addWindow(q.window);
    return this;
  }

  #addWindow(w: StateWindow): void {
    this.#windows.set(`${w.start}:${w.length}`, { start: w.start, length: w.length });
  }

  getCodec(layoutId: string): LayoutCodec {
    const codec = this.#codecs.get(layoutId);
    if (!codec) throw new Error(`no codec registered for layout ${layoutId}`);
    return codec;
  }

  /** Resolve a template by hash or fail loudly. Never returns a fallback. */
  resolveTemplate(templateHash: string): TemplateDescriptor {
    const hash = templateHash.toLowerCase();
    const found = this.#templates.get(hash);
    if (found) return found;

    const quarantined = this.#quarantine.get(hash);
    if (quarantined) {
      throw new UnknownTemplateError(`${hash} (quarantined: ${quarantined})`);
    }
    throw new UnknownTemplateError(hash);
  }

  /** True only for templates we can both recognise AND decode. */
  isDecodable(templateHash: string): boolean {
    const d = this.#templates.get(templateHash.toLowerCase());
    return d !== undefined && d.recognisedOnly === undefined;
  }

  /**
   * Identify a program from its bytes alone: recompute the KCC-1 template
   * hash under every known state window and look it up. Throws
   * UnknownTemplateError when no registered template matches (naming a
   * quarantine reason if one does).
   */
  identifyTemplate(program: Uint8Array): TemplateDescriptor {
    const tried: string[] = [];
    for (const w of this.#windows.values()) {
      if (w.start + w.length > program.length) continue;
      const hash = templateHashOfProgram(program, w.start, w.length);
      const found = this.#templates.get(hash);
      if (found) return found;
      const quarantined = this.#quarantine.get(hash);
      if (quarantined !== undefined) {
        throw new UnknownTemplateError(`${hash} (quarantined: ${quarantined})`);
      }
      tried.push(`${hash} over window [${w.start}, ${w.start + w.length})`);
    }
    throw new UnknownTemplateError(
      tried.length === 0
        ? `(none: ${program.length}-byte program is shorter than every known state window)`
        : `(computed ${tried.join('; ')})`,
    );
  }

  /**
   * Decode the token state out of a full redeem script. The template is
   * identified by hashing the program; `expectedTemplateHash`, if given, is
   * asserted against the computed hash and never used to pick the layout.
   * This is the only supported entry point for on-chain bytes.
   */
  decodeProgram(program: Uint8Array, expectedTemplateHash?: string): TokenState {
    const template = this.#identify(program, expectedTemplateHash);
    if (template.recognisedOnly !== undefined) {
      throw new TemplateNotDecodableError(template.templateHash, template.recognisedOnly);
    }
    const stateBytes = this.#stateBytes(program, template);
    const codec = this.getCodec(template.layoutId);
    const state = codec.decode(stateBytes, template.schemes);
    codec.validate(state, template.schemes);
    return state;
  }

  /** Re-encode a state and confirm it reproduces the on-chain bytes exactly. */
  assertRoundTrip(program: Uint8Array, expectedTemplateHash?: string): TokenState {
    const template = this.#identify(program, expectedTemplateHash);
    const state = this.decodeProgram(program, template.templateHash);
    const reencoded = this.getCodec(template.layoutId).encode(state, template.schemes);
    const original = this.#stateBytes(program, template);
    if (toHex(reencoded) !== toHex(original)) {
      throw new DecodeError(
        `round-trip mismatch for template ${template.templateHash}: ` +
          `on-chain ${toHex(original)} vs re-encoded ${toHex(reencoded)}`,
      );
    }
    return state;
  }

  #identify(program: Uint8Array, expectedTemplateHash?: string): TemplateDescriptor {
    // An asserted hash must itself be known, so an unknown or quarantined
    // claim is reported as such before we look at the bytes.
    const expected = expectedTemplateHash === undefined ? undefined : this.resolveTemplate(expectedTemplateHash);
    const template = this.identifyTemplate(program);
    if (expected !== undefined && expected.templateHash !== template.templateHash) {
      throw new TemplateMismatchError(expected.templateHash, template.templateHash);
    }
    return template;
  }

  #stateBytes(program: Uint8Array, template: TemplateDescriptor): Uint8Array {
    const end = template.stateOffset + template.stateLength;
    if (program.length < end) {
      throw new DecodeError(
        `program is ${program.length} bytes; template ${template.templateHash} needs at least ${end}`,
      );
    }
    if (template.prefixHex !== undefined) {
      const want = template.prefixHex;
      const got = toHex(program.subarray(0, want.length / 2));
      if (got !== want) {
        throw new DecodeError(`template ${template.templateHash} expects program prefix ${want}, got ${got}`);
      }
    }
    return program.subarray(template.stateOffset, end);
  }
}
