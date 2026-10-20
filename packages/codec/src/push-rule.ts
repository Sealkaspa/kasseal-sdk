/**
 * Signature-script pushes as consensus reads them (shared by indexers and the launch proof verifier, `kcc0023.ts`,
 * which the browser runs too).
 *
 * The codec's `parseSigScriptPushes` (`program.ts`) accepts a push only in its minimal form: OP_0
 * for an empty payload, OP_1..OP_16 and OP_1NEGATE for the matching single byte, a direct push up to 75 bytes, then
 * PUSHDATA1/2/4 by size. Consensus does not require that. In rusty-kaspa v2.1.0, crypto/txscript/src:
 *
 *   - lib.rs 577-599 `execute_opcode`: no minimal-data check before a push executes;
 *   - lib.rs 618-631 `execute_script` and 698-704: the signature script (script 0 of a transaction input) must be
 *     push-only, `SignatureScriptNotPushOnly` otherwise;
 *   - opcodes/mod.rs 142-144 `is_push_opcode`: every opcode up to 0x60 (OP_16), OP_RESERVED (0x50) included, which
 *     fails when executed (opcodes/mod.rs 335, `OpcodeReserved`);
 *   - opcodes/macros.rs 9-27: PUSHDATA1/2/4 read a little-endian length of 1, 2 or 4 bytes and fail only when the data
 *     is shorter than that length (`MalformedPush`);
 *   - data_stack.rs 164-169 `deserialize_i64`: "Numbers are not required to be minimally encoded".
 *
 * The rule existed before: rusty-kaspa 2.0.1 (commit a41a333) has `check_minimal_data_push`
 * (opcodes/mod.rs 178-223) but calls it only when covenants are disabled (lib.rs 626-629); v2.1.0 removed it. The
 * mempool's standardness check (mining/src/mempool/check_transaction_standard.rs, v2.1.0) does not test the pushes of
 * a signature script either, so a node relays such a transaction.
 *
 * So an accepted transaction can spend a Kasseal cell with a non-minimal push (`4c 05 <5 bytes>`, `01 05` for OP_5,
 * PUSHDATA2 for the program). The stack, and so the program and every argument the contract saw, is the same as for
 * the minimal form. `consensusSigScript` reads the pushes by the consensus rule, says whether they were minimal and
 * gives the minimal re-encoding, which the codec's strict decoders then read. It rejects exactly what consensus rejects
 * in a signature script: a non-push opcode, OP_RESERVED, a truncated push.
 *
 * The number inside a push is a separate rule: an `int` argument in a non-minimal ScriptNum form is read by
 * `number-rule.ts` (the same number the program read).
 *
 * Building stays strict: the builders push the minimal form only (`encodePushMinimal`), and `parseSigScriptPushes`
 * keeps refusing anything else. This reader is for transactions others submitted, which consensus already accepted.
 */
import { SigScriptError } from './program.ts';
import { bytesEqual, concat, encodePushMinimal } from './push.ts';

const OP_0 = 0x00;
const MAX_DIRECT_PUSH = 0x4b;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_PUSHDATA4 = 0x4e;
const OP_1NEGATE = 0x4f;
const OP_RESERVED = 0x50;
const OP_1 = 0x51;
const OP_16 = 0x60;

/** A signature script read by the consensus push rule (`consensusSigScript`). */
export interface ConsensusSigScript {
  /** The payload of every push, in order: what the script engine puts on the stack. */
  readonly payloads: readonly Uint8Array[];
  /** Every push is in the codec's minimal form (the codec's strict parser accepts the script as it is). */
  readonly minimal: boolean;
  /** The same payloads, each pushed in its minimal form; equal to the input when `minimal`. */
  readonly canonical: Uint8Array;
}

/** The pushes of signature script `script` under the consensus rule; throws `SigScriptError` where consensus fails it. */
export function consensusSigScript(script: Uint8Array): ConsensusSigScript {
  const payloads: Uint8Array[] = [];
  let at = 0;
  const take = (from: number, len: number): Uint8Array => {
    if (from + len > script.length) throw new SigScriptError(`offset ${at}: truncated push, need ${len} bytes, have ${Math.max(0, script.length - from)}`);
    return script.subarray(from, from + len);
  };
  while (at < script.length) {
    const op = script[at]!;
    if (op === OP_0) {
      payloads.push(new Uint8Array(0));
      at += 1;
    } else if (op <= MAX_DIRECT_PUSH) {
      payloads.push(take(at + 1, op));
      at += 1 + op;
    } else if (op === OP_PUSHDATA1 || op === OP_PUSHDATA2 || op === OP_PUSHDATA4) {
      const width = op === OP_PUSHDATA1 ? 1 : op === OP_PUSHDATA2 ? 2 : 4;
      const l = take(at + 1, width);
      let n = 0;
      for (let i = width - 1; i >= 0; i--) n = n * 256 + l[i]!;
      payloads.push(take(at + 1 + width, n));
      at += 1 + width + n;
    } else if (op === OP_1NEGATE) {
      payloads.push(Uint8Array.of(0x81));
      at += 1;
    } else if (op === OP_RESERVED) {
      throw new SigScriptError(`offset ${at}: OP_RESERVED fails when executed`);
    } else if (op >= OP_1 && op <= OP_16) {
      payloads.push(Uint8Array.of(op - OP_1 + 1));
      at += 1;
    } else {
      throw new SigScriptError(`offset ${at}: opcode 0x${op.toString(16).padStart(2, '0')} is not a data push (a signature script is push-only)`);
    }
  }
  const canonical = concat(...payloads.map((p) => encodePushMinimal(p)));
  return { payloads, minimal: bytesEqual(canonical, script), canonical };
}

/**
 * The note (launch proof) and anomaly kind (API) of a signature script that uses a push form other than the
 * minimal one: valid on chain, read with the same payloads.
 */
export const NON_MINIMAL_PUSH = 'non-minimal-push';
