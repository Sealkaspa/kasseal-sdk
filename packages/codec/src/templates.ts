/**
 * Verified template allowlist.
 *
 * A template earns an entry only after its state offset AND identifier-byte
 * semantics have been read out of real bytecode. Everything else is rejected.
 *
 * Census (testnet-10, 14 coins sampled 2026-09-04) -- five distinct programs
 * already share the 46-byte layout:
 *
 *   hash prefix        offset  identifier branches      asm ops
 *   5b136633944a2371   1 (6b)  00,01,02                 1720
 *   55306914ff3ddbfa   1 (6b)  00,01,02                 4408
 *   0f6db65e251cb849   1 (6b)  00,01,02                 4241
 *   0338146fbf175bd1   1 (6b)  00,01,02                 5355
 *   b2c23636332e1ddd   0       00,01,02,03              2621   <-- NOT registered
 *
 * The four offset-1 programs agree on semantics and differ only in size
 * (different maxCovIns/maxCovOuts unrolling). The 0x03 family diverges in both
 * state offset and identifier semantics, so it stays out until disassembled.
 *
 * Every hash here is a KCC-1 sec 3.7.3 TemplateHash cut on the declared
 * window; the registry recomputes it from program bytes on every decode
 * (verified 2026-10-07: 154/154 live 5b136633 cells and 4/4 b2c23636 cells
 * from kascov reproduce kascov's `kcc1_template_hash` exactly).
 */

import { KCC20_46_ID, KCC20_46_STATE_LENGTH, REFERENCE_SCHEMES } from './kcc20-46.ts';
import { KCC0020_112_ID, KCC0020_112_STATE_LENGTH, KCC2_DEFAULT_SCHEMES } from './kcc0020-112.ts';
import type { QuarantinedTemplate, TemplateDescriptor } from './types.ts';

const OFFSET_TO_ALTSTACK = 1; // leading 0x6b OpToAltStack
const OP_TO_ALT_STACK_HEX = '6b';

function referenceTemplate(templateHash: string, provenance: string): TemplateDescriptor {
  return {
    templateHash,
    layoutId: KCC20_46_ID,
    stateOffset: OFFSET_TO_ALTSTACK,
    stateLength: KCC20_46_STATE_LENGTH,
    prefixHex: OP_TO_ALT_STACK_HEX,
    schemes: REFERENCE_SCHEMES,
    provenance,
  };
}

/** Programs whose offset and semantics we have verified from live bytecode. */
export const VERIFIED_TEMPLATES: readonly TemplateDescriptor[] = Object.freeze([
  referenceTemplate(
    '5b136633944a2371a1d0f6a94fdc0d329327ffc700fdec097fc59e76e1d33ae1',
    'tn10 covenant 5f381583..8445; revealed_hex 6b|20+32|01+01|08+08|01+01; branches 00,01,02; ' +
      'kascov names it "KForge · token cell" (142 covenants); hash reproduced on 154 live cells 2026-10-07',
  ),
  referenceTemplate(
    '55306914ff3ddbfa0f4db6d5c5a01ec26f5f13f8c8d042076ed793fe82640513',
    'tn10 census 2026-09-04; offset 1 (6b); branches 00,01,02',
  ),
  referenceTemplate(
    '0f6db65e251cb8498aa9b201276ebeb569ac2c1eef270075143cd515d71ec3f1',
    'tn10 census 2026-09-04; offset 1 (6b); branches 00,01,02',
  ),
  referenceTemplate(
    '0338146fbf175bd1650b404d141ea4b1193180bee014f46fd617c6a6e3cc309c',
    'tn10 census 2026-09-04; offset 1 (6b); branches 00,01,02',
  ),
]);

/**
 * The argent-lang KCC-20 reference token template (KCC-0020 layout).
 *
 * Program R is 4,031 bytes. The compiler's state span is [1, 146): a 33-byte
 * context field `20 || H` (gen__kcc20_template, H = this template hash) followed
 * by the 112-byte KCC20State. `templateHash` is the KCC-1 hash cut on that
 * full span (prefix `6b`, suffix 3,885 bytes) -- what the artifact calls
 * `template_hash` and what the contract commits to in its context field. The
 * ABI state the kcc0020-112 codec reads sits at offset 34; the template VIEW
 * cut there (prefix `6b 20 || H`, KCC-1 sec 3.7.4) hashes to
 * 734850b0af0aeef49f009167bf9ddd238fd8c5cdbe214234f97181ac6f5cc498.
 *
 * `prefixHex` is the full 34-byte prefix `6b 20 || H`, so every decode also
 * checks that the context field carries exactly this template's hash: a
 * program whose suffix matches but whose context field does not is refused.
 *
 * Owner-scheme meanings are the KCC-2 default set, which is the configuration
 * the reference program publishes (KCC-20 sec 3; schemes 00 and 04 exercised
 * on testnet-10).
 */
/** Template hash of the reference KCC-20 token program (hex). */
export const REFERENCE_KCC0020_TEMPLATE_HASH = '9703112ee6e3555107cd168858992b77d3b74f655205b2b463b1f9ec2ec73cf7';
/** Template VIEW hash of the reference token, cut at the ABI state (hex). */
export const REFERENCE_KCC0020_VIEW_HASH = '734850b0af0aeef49f009167bf9ddd238fd8c5cdbe214234f97181ac6f5cc498';
/** Byte offset of the 112-byte token state inside the reference program. */
export const REFERENCE_KCC0020_STATE_OFFSET = 34;
/** The reference program's 34-byte prefix `6b 20 || H`, hex. */
export const REFERENCE_KCC0020_CONTEXT_PREFIX_HEX = '6b20' + REFERENCE_KCC0020_TEMPLATE_HASH;

/** Descriptor of the reference KCC-20 token template, as registered by `createDefaultRegistry()`. */
export const REFERENCE_KCC0020_TEMPLATE: TemplateDescriptor = Object.freeze({
  templateHash: REFERENCE_KCC0020_TEMPLATE_HASH,
  layoutId: KCC0020_112_ID,
  stateOffset: REFERENCE_KCC0020_STATE_OFFSET,
  stateLength: KCC0020_112_STATE_LENGTH,
  hashWindow: { start: 1, length: 145 },
  prefixHex: REFERENCE_KCC0020_CONTEXT_PREFIX_HEX,
  schemes: KCC2_DEFAULT_SCHEMES,
  provenance:
    'argent-lang/kcc20-reference@c8a0871 fixtures/public-mint/artifact.json ' +
    'sil_abi.contracts.KCC20.compiled {bytecode, state_span {offset 1, len 145}, template_hash}; ' +
    'recomputed 2026-10-07; decoded against real testnet-10 cells',
});

/** Templates the registry recognises by hash but will not decode. None at present. */
export const RECOGNISED_TEMPLATES: readonly TemplateDescriptor[] = Object.freeze([]);

/**
 * Known-but-rejected programs. Present so the error message can say WHY,
 * rather than the caller assuming the hash was simply unseen.
 */
export const QUARANTINED_TEMPLATES: readonly QuarantinedTemplate[] = Object.freeze([
  {
    templateHash: 'b2c23636332e1ddde48ceb0c4ea54ce5b8f18439044aa9a7121ac00e46263973',
    window: { start: 0, length: 46 },
    reason:
      'the 0x03 identifier family: state at offset 0 (no 6b prefix) and FOUR identifier ' +
      'branches (00,01,02,03). The meaning of 0x03 is unverified -- plausibly a p2pkh ' +
      'variant, but plausible is not verified. 107 live tn10 tokens use 0x03.',
  },
  {
    templateHash: '2ed46a7edf5b168e67dba56998c58255235bebac436940a85115ca31d5c559f2',
    window: { start: 0, length: 46 },
    reason: 'second 0x03-family program, same reason.',
  },
]);
