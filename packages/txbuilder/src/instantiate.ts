/**
 * Per-creator curve templates.
 *
 * The creator's script public key is a constructor constant of the curve
 * (the creator's fee share is paid to it), so every launch has its own curve
 * template. The committed artifacts carry a placeholder creator; the compiler
 * emits that constant as a 36-byte push (`24 || spk`) at each use in the
 * suffix (the two fee-split outputs and the pool genesis state). A creator's template is the committed one with
 * every such slot replaced by the creator's `0000 20 <x-only key> ac`, nothing
 * else changed: the structural rule the Kasseal API accepts and the app's
 * factory applies.
 *
 * The pool template carries no per-creator constant: the pool keeps the
 * creator in its state, which the curve's `graduate` writes, so the
 * curve's `poolH` stays one constant per set.
 */

import { bytesEqual, concat, templateHash } from '@kasseal/codec';
import type { BuilderContext } from './cells.ts';
import { SPK36_LENGTH, isP2pkSpk36, type CurveTemplate } from './program.ts';

const OP_DATA_36 = 0x24;

/** Offsets of the 36-byte constant `spk` in `suffix` (each directly after a `24` push opcode). */
export function creatorSlots(suffix: Uint8Array, spk: Uint8Array): number[] {
  if (spk.length !== SPK36_LENGTH) throw new Error(`a creator slot holds ${SPK36_LENGTH} bytes`);
  const out: number[] = [];
  outer: for (let i = 0; i + 1 + spk.length <= suffix.length; i++) {
    if (suffix[i] !== OP_DATA_36) continue;
    for (let j = 0; j < spk.length; j++) if (suffix[i + 1 + j] !== spk[j]) continue outer;
    out.push(i + 1);
    i += spk.length;
  }
  return out;
}

/** The committed preset's context with `creatorSpk` in every creator slot of the curve. */
export function instantiateCurve(base: BuilderContext, creatorSpk: Uint8Array): BuilderContext {
  if (!isP2pkSpk36(creatorSpk)) throw new Error('creator script must be a version-0 P2PK script in the 36-byte form');
  const c = base.curve;
  const slots = creatorSlots(c.suffix, c.params.creatorSpk);
  if (slots.length === 0) throw new Error(`preset ${c.preset}: no creator slot in the compiled suffix`);
  const suffix = Uint8Array.from(c.suffix);
  for (const s of slots) suffix.set(creatorSpk, s);
  const state = c.bytecode.subarray(c.stateOffset, c.stateOffset + c.stateLength);
  const curve: CurveTemplate = {
    ...c,
    suffix,
    bytecode: concat(c.prefix, state, suffix),
    templateHash: templateHash(c.prefix, suffix),
    params: { ...c.params, creatorSpk: Uint8Array.from(creatorSpk) },
  };
  return { ...base, curve };
}

/**
 * The context of the committed preset `program` (a live curve program R)
 * instantiates, among `bases` (committed presets of any set), or null. The
 * program must equal the base everywhere except the creator slots, which
 * must all hold the same version-0 P2PK script.
 */
export function contextForCurveProgram(program: Uint8Array, bases: Iterable<BuilderContext>): BuilderContext | null {
  for (const base of bases) {
    const c = base.curve;
    if (program.length !== c.bytecode.length || !bytesEqual(program.subarray(0, c.stateOffset), c.prefix)) continue;
    const slot = creatorSlots(c.suffix, c.params.creatorSpk)[0];
    if (slot === undefined) continue;
    const suffix = program.subarray(c.stateOffset + c.stateLength);
    const creator = suffix.subarray(slot, slot + SPK36_LENGTH);
    if (!isP2pkSpk36(creator)) continue;
    const inst = instantiateCurve(base, creator);
    if (bytesEqual(inst.curve.suffix, suffix)) return inst;
  }
  return null;
}
