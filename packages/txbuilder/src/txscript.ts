/**
 * Small pieces of the Kaspa script layer shared by several contract builders (the token locks among them):
 * kaspa-txscript's lock-time threshold, an opcode walk over a compiled program, the count of a pushed constant, and the
 * sigscript of an entry without arguments. Moved here unchanged so that a builder needs none of the other contract
 * modules that used to hold them (they re-export these names).
 */

import { bytesEqual, concat, fromHex } from '@kasseal/codec';
import { pushMinimal } from './sigscript.ts';

/** kaspa-txscript LOCK_TIME_THRESHOLD: a lock time below it is a DAA score, at or above it a Unix timestamp in ms. */
export const LOCK_TIME_THRESHOLD = 500_000_000_000n;

/** Every opcode position of a script (pushes skipped whole), for reading a constant back out of a compiled program. */
export function opcodes(script: Uint8Array): { at: number; op: number; push?: Uint8Array }[] {
  const out: { at: number; op: number; push?: Uint8Array }[] = [];
  for (let at = 0; at < script.length;) {
    const op = script[at]!;
    let n = -1;
    let header = 1;
    if (op >= 0x01 && op <= 0x4b) n = op;
    else if (op === 0x4c) { n = script[at + 1]!; header = 2; }
    else if (op === 0x4d) { n = script[at + 1]! | (script[at + 2]! << 8); header = 3; }
    else if (op === 0x4e) { n = (script[at + 1]! | (script[at + 2]! << 8) | (script[at + 3]! << 16) | (script[at + 4]! << 24)) >>> 0; header = 5; }
    if (n >= 0) {
      if (at + header + n > script.length) throw new Error('truncated push in a compiled program');
      out.push({ at, op, push: script.subarray(at + header, at + header + n) });
      at += header + n;
    } else {
      out.push({ at, op });
      at += 1;
    }
  }
  return out;
}

/** How many data pushes of a compiled program push exactly `value`. */
export function pushCountOf(program: Uint8Array, value: Uint8Array): number {
  return opcodes(program).filter((o) => o.push !== undefined && bytesEqual(o.push, value)).length;
}

/** `OP_DATA_4 tag || PushMinimal(R)`: the sigscript of an entry without arguments. */
export function noArgSigScript(tagHex: string, program: Uint8Array): Uint8Array {
  if (!/^[0-9a-f]{8}$/.test(tagHex)) throw new Error(`dispatch tag ${tagHex} is not 4 bytes of hex`);
  return concat(Uint8Array.of(0x04), fromHex(tagHex), pushMinimal(program));
}
