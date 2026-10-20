/**
 * `int` arguments as consensus reads them (the companion of the push rule in `push-rule.ts`).
 *
 * The codec's `decodeScriptNum` (`program.ts`) accepts an `int` argument only as the minimal
 * ScriptNum (`ScriptBuilder::add_i64`: no trailing zero byte, no negative zero). Consensus does not require that. In
 * rusty-kaspa v2.1.0 (the node version Kasseal runs), crypto/txscript/src:
 *
 *   - data_stack.rs 164-178 `deserialize_i64`: "Numbers are not required to be minimally encoded, but they are still
 *     bounded in width": more than 8 bytes fails (`NotMinimalData`), empty is 0, otherwise little-endian magnitude with
 *     the sign in bit 7 of the last byte (so `05 00` is 5, `05 80` is -5, `80` and `00` are 0);
 *   - data_stack.rs 180-217: the i64 and i32 readers go through `SizedEncodeInt<8>` (more than 8 bytes:
 *     `NumberTooBig`); i32 readers (OP_PICK, the introspection indices) also fail outside the i32 range;
 *   - data_stack.rs 605-607, the engine's own vectors: `00` is 0, `0100` is 1, `7f00` is 127;
 *   - opcodes/mod.rs 590-760: every arithmetic and comparison opcode (OP_ADD .. OP_WITHIN, OP_NUMEQUAL) pops its
 *     operands with `pop_items::<i64>`; opcodes/mod.rs 1297-1316: OP_NUM2BIN and OP_BIN2NUM read their number the
 *     same way. Nothing in v2.1.0 re-checks the minimal form (the only `NotMinimalData` errors left are the 8-byte
 *     bound and OP_NUM2BIN's size, data_stack.rs 168, opcodes/mod.rs 1301);
 *   - opcodes/mod.rs 874-886 OP_CHECKLOCKTIMEVERIFY (and 926-940 OP_CHECKSEQUENCEVERIFY) do not read a ScriptNum at
 *     all: at most 8 bytes, zero-padded, unsigned little-endian. No Kasseal entry passes an argument to them.
 *
 * What the Kasseal programs do with an `int` argument (silverscript 3ed9733, the pinned compiler; every curve and pool
 * build): the entry prologue checks `OP_SIZE 9 OP_LESSTHAN OP_VERIFY` (at most 8 bytes, no minimal
 * check; silverscript-lang/src/compiler/compile/statement.rs 140-149, visible in the curve v1 bytecode at the `buy`
 * entry), and every later use is numeric: `==` on ints is OP_NUMEQUAL (compile/expression.rs 377, 425, 673-678),
 * arithmetic and comparisons are the i64 opcodes, and an int written into a state or cast with `as byte[8]` goes
 * through OP_NUM2BIN (compile/state.rs 499-501, compile/expression/builtin.rs 110-129). No entry hashes, concatenates
 * or compares the raw bytes of an `int` argument, and no program reads another input's arguments at an offset that an
 * earlier `int` could move (the programs that read a signature script read the program at its end, or the first
 * argument). So a non-minimal `int` of at most 8 bytes is the same number to the program, and an accepted transaction
 * has the effects of the minimal one; more than 8 bytes is refused by the prologue and by the opcodes.
 *
 * `canonicalNumbers` rewrites the `int` arguments of a curve or pool sigscript (already in minimal push form,
 * `consensusSigScript`) to their minimal ScriptNum, so the codec's strict decoders read the number consensus read.
 * Which arguments are `int` comes from the codec's declared signatures (the strings the dispatch tags hash). A number
 * of more than 8 bytes, or a sigscript that is not an invocation of the contract, is left as it is: the strict decoder
 * then fails the proof, as before.
 *
 * Who reads by this rule: an indexer, which must follow what the chain accepted, and the launch proof verifier
 * (`kcc0023.ts`, run by the Kasseal API and in the browser) for the transactions it checks, which others submitted
 * (`decodeInvocationByConsensus`). The builders keep the strict rule: they encode the minimal form only
 * (`encodeScriptNum`), and `decodeScriptNum` and `decodeInvocation` keep refusing anything else.
 */
import {
  ENTRY_SIGNATURES, POOL_BUY_COMPOSABLE_SIGNATURE, POOL_BUY_COMPOSABLE_TAG, POOL_BUY_MIN_SIGNATURE, POOL_BUY_MIN_TAG, POOL_SELL_COMPOSABLE_SIGNATURE,
  POOL_SELL_COMPOSABLE_TAG, POOL_V3_ENTRY_SIGNATURES, SCRIPT_NUM_MAX_LENGTH, SigScriptError,
  decodeInvocation, encodeScriptNum, entriesOfTag, parseSigScriptEnvelope, type ContractKind, type DecodedSigScript,
} from './program.ts';
import { bytesEqual, concat, encodePushMinimal, fromHex } from './push.ts';
import { consensusSigScript } from './push-rule.ts';

/** The value of ScriptNum `payload` as rusty-kaspa v2.1.0 `deserialize_i64` reads it; throws `SigScriptError` above 8 bytes. */
export function decodeScriptNumConsensus(payload: Uint8Array): bigint {
  if (payload.length > SCRIPT_NUM_MAX_LENGTH) throw new SigScriptError(`int argument is ${payload.length} bytes, above ${SCRIPT_NUM_MAX_LENGTH} (consensus refuses it)`);
  if (payload.length === 0) return 0n;
  const last = payload[payload.length - 1]!;
  let magnitude = BigInt(last & 0x7f);
  for (let i = payload.length - 2; i >= 0; i--) magnitude = (magnitude << 8n) | BigInt(payload[i]!);
  return (last & 0x80) !== 0 ? -magnitude : magnitude;
}

/** Whether `payload` is the minimal ScriptNum of its value (what the codec's strict `decodeScriptNum` accepts). */
export function isMinimalScriptNum(payload: Uint8Array): boolean {
  return payload.length <= SCRIPT_NUM_MAX_LENGTH && bytesEqual(encodeScriptNum(decodeScriptNumConsensus(payload)), payload);
}

/** The flattened argument types of an entry: one per push, a record's fields in declaration order (KCC-1 section 3.4.6). */
function pushTypes(types: readonly string[]): string[] {
  return types.flatMap((t) => (t.startsWith('{') && t.endsWith('}') ? t.slice(1, -1).split(',') : [t]));
}

const POOL_SIGNATURES: Readonly<Record<string, readonly string[]>> = { ...ENTRY_SIGNATURES.Pool, ...POOL_V3_ENTRY_SIGNATURES };

/** Push indices of the `int` arguments of the `contract` entry dispatch tag `tag` names, or undefined when it names none. */
export function intArgumentPushes(contract: 'curve' | 'pool', tag: string): number[] | undefined {
  const entry = entriesOfTag(tag).find((e) => e.contract === contract)?.entry;
  if (entry === undefined) return undefined;
  const declared = contract === 'curve'
    ? ENTRY_SIGNATURES.Curve[entry]
    : tag === POOL_BUY_MIN_TAG ? POOL_BUY_MIN_SIGNATURE
    : tag === POOL_BUY_COMPOSABLE_TAG ? POOL_BUY_COMPOSABLE_SIGNATURE
    : tag === POOL_SELL_COMPOSABLE_TAG ? POOL_SELL_COMPOSABLE_SIGNATURE
    : POOL_SIGNATURES[entry];
  if (declared === undefined) return undefined;
  return pushTypes(declared).flatMap((t, i) => (t === 'int' ? [i] : []));
}

/** The result of `canonicalNumbers`. */
export interface CanonicalNumbers {
  /** The sigscript with every `int` argument in minimal form; the input itself when nothing changed. */
  readonly sigscript: Uint8Array;
  /** Push indices of the `int` arguments that were not minimal (empty when nothing changed). */
  readonly nonMinimal: readonly number[];
}

/**
 * The `int` arguments of curve or pool sigscript `sigscript` (minimal pushes) rewritten to the minimal ScriptNum of the
 * value consensus reads. Anything this does not recognise, and a number consensus refuses (more than 8 bytes), is left
 * unchanged for the strict decoder to reject.
 */
export function canonicalNumbers(sigscript: Uint8Array, contract: 'curve' | 'pool'): CanonicalNumbers {
  const unchanged = { sigscript, nonMinimal: [] };
  let env;
  try {
    env = parseSigScriptEnvelope(sigscript);
  } catch (e) {
    if (e instanceof SigScriptError) return unchanged;
    throw e;
  }
  const ints = intArgumentPushes(contract, env.tag);
  if (ints === undefined) return unchanged;
  const args = env.argumentPushes.map((p) => p.payload);
  const nonMinimal: number[] = [];
  for (const i of ints) {
    const p = args[i];
    if (p === undefined || p.length > SCRIPT_NUM_MAX_LENGTH || isMinimalScriptNum(p)) continue;
    args[i] = encodeScriptNum(decodeScriptNumConsensus(p));
    nonMinimal.push(i);
  }
  if (nonMinimal.length === 0) return unchanged;
  return { sigscript: concat(...args.map((a) => encodePushMinimal(a)), Uint8Array.of(0x04), fromHex(env.tag), encodePushMinimal(env.program)), nonMinimal };
}

/**
 * The note (launch proof) and anomaly kind (API) of a signature script that passes an `int` argument in a
 * non-minimal form: valid on chain, read as the same number.
 */
export const NON_MINIMAL_NUMBER = 'non-minimal-number';

/** A sigscript decoded by the consensus rules, with how far its encoding was from the minimal one. */
export interface ConsensusInvocation {
  readonly decoded: DecodedSigScript;
  /** Every push was in its minimal form (`push-rule.ts`). */
  readonly minimalPushes: boolean;
  /** Push indices of the `int` arguments that were not minimal ScriptNums (empty when all were). */
  readonly nonMinimalNumbers: readonly number[];
}

/**
 * `decodeInvocation` of a sigscript someone else submitted, read as consensus reads it: the pushes by the consensus
 * push rule (`consensusSigScript`), then a curve or pool invocation's `int` arguments by the consensus number rule
 * (`canonicalNumbers`), then the strict decoder on that minimal form, so the invocation (program, entry, every
 * argument) is the one the script engine ran. Throws `SigScriptError` where consensus refuses the script (a non-push
 * opcode, OP_RESERVED, a truncated push, a number of more than 8 bytes) and wherever the strict decoder refuses the
 * minimal form (not an invocation of `contract`).
 */
export function decodeInvocationByConsensus(sigscript: Uint8Array, contract: ContractKind): ConsensusInvocation {
  const pushes = consensusSigScript(sigscript);
  const numbers = contract === 'token' ? { sigscript: pushes.canonical, nonMinimal: [] } : canonicalNumbers(pushes.canonical, contract);
  return { decoded: decodeInvocation(numbers.sigscript, contract), minimalPushes: pushes.minimal, nonMinimalNumbers: numbers.nonMinimal };
}
