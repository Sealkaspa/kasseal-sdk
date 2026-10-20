/**
 * KCC-23 token declarations and the Kasseal launch proof.
 *
 * Declaration (KCC-23 section 3.1, Manyfestation/kccs@d51721a): the payload of
 * a version-1 preparation transaction is `0x00 || UTF-8 I-JSON object`. The
 * parser here is strict I-JSON (RFC 7493) and rejects what `JSON.parse`
 * silently accepts: duplicate member names, numbers that are not finite
 * binary64 values (`1e999`), lone surrogates, nesting deeper than 64, a
 * byte-order mark, non-object roots, invalid UTF-8 and trailing bytes.
 *
 * Preparation txid: KIP-24 (`kip24.ts`), whose rest preimage carries the
 * `bool || u16 || id32` covenant field of every output. tx01 binds its curve
 * genesis output, so a recomputation that omits the field yields a different
 * txid.
 *
 * Launch proof: nine verification steps (`LAUNCH_PROOF_STEPS`) over a bundle
 * `{tx01, tx2, T, C, H_T, H_C, curvePrefix, curveSuffix, tokenSuffix, params,
 * states, declaration, graduation}`. The verifier trusts only its own inputs
 * (the reference token suffix and the curve-template acceptance rule passed in
 * `VerifierTrust`); every hash in the bundle is recomputed. Outcomes:
 *
 *   bound       every step passed, the declaration is bound to T
 *   unverified  the preparation transaction is not in the bundle: lineage T
 *               and the sealed supply are proven, C and the declaration are not
 *   invalid     any recomputation disagreed with the bundle
 *
 * A missing preparation transaction is never `bound`.
 *
 * Step 9 (graduation group integrity) runs on the graduation transaction once
 * the API holds one: a KIP-20 genesis group may carry any output its
 * authorizing input lists, so a second output bound to the pool id P would
 * later satisfy the reference token's owner check (scheme 0x04) and release
 * the pool-owned reserve without the pool program running. The
 * step requires exactly one output bound to P (the pool genesis cell at index
 * 0, P recomputed over the whole group) and exactly one output bound to T (the
 * reserve, committing to `{gradReserve, owner P}`). Before graduation the step
 * passes as not applicable.
 *
 * Signature scripts (steps 8 and 9: tx2's `init`, submitted by the creator,
 * and the `graduate`, which anyone may submit) are read by the consensus rules
 * (`push-rule.ts`, `number-rule.ts`), not by
 * the builder's minimal-encoding rule: rusty-kaspa v2.1.0 accepts any push
 * form and any ScriptNum of up to 8 bytes, so a submitter could otherwise
 * choose an encoding that makes the proof fail everywhere although the chain
 * ran the same program on the same arguments. The facts checked are unchanged;
 * a non-minimal encoding is reported as a note (`LaunchProofResult.notes` and
 * the step's `detail.encoding`), never as a failure. What consensus refuses
 * (a non-push opcode, OP_RESERVED, a truncated push, a number of more than 8
 * bytes) is still refused.
 *
 * Pure TypeScript without Node built-ins: the Kasseal API and the browser run
 * the same code.
 */

import { covenantIdKip20, p2shScript } from './blake2b.ts';
import { CURVE_STATE_LENGTH, OWNER_SCHEME_COVENANT_ID, PHASE_ACTIVE, PHASE_UNINIT, ZERO32, decodeCurveState, encodeCurveState } from './cell-state.ts';
import { DecodeError } from './errors.ts';
import { kcc0020Fields, kcc0020_112, makeKcc0020State } from './kcc0020-112.ts';
import { plainTxFromJson, plainTxToJson, txidV1, type PlainTx } from './kip24.ts';
import { NON_MINIMAL_NUMBER, decodeInvocationByConsensus, type ConsensusInvocation } from './number-rule.ts';
import { NON_MINIMAL_PUSH, consensusSigScript } from './push-rule.ts';
import { bytesEqual, concat, fromHex, toHex } from './push.ts';
import { templateHash } from './template-hash.ts';
import { REFERENCE_KCC0020_TEMPLATE_HASH } from './templates.ts';

/* -------------------------------------------------------------------------- */
/* I-JSON                                                                      */
/* -------------------------------------------------------------------------- */

/** A payload or text that is not a valid KCC-23 declaration. */
export class DeclarationError extends DecodeError {}

/** An I-JSON value. */
export type IJsonValue = null | boolean | number | string | IJsonValue[] | { [name: string]: IJsonValue };
/** An I-JSON object. */
export type IJsonObject = { [name: string]: IJsonValue };

/** RFC 7493 section 2.3 recommends at most this nesting; KCC-23 adopts it as a limit. */
export const IJSON_MAX_DEPTH = 64;

const NUMBER_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const ESCAPES: Readonly<Record<string, string>> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Parse one I-JSON value from `text` (already decoded from UTF-8). Objects are
 * returned with a null prototype, so member names such as `__proto__` are
 * plain data. Throws `DeclarationError` with the offset of the first
 * violation.
 */
export function parseIJson(text: string, maxDepth: number = IJSON_MAX_DEPTH): IJsonValue {
  let at = 0;
  const fail = (m: string): never => {
    throw new DeclarationError(`I-JSON: ${m} at offset ${at}`);
  };
  const ws = (): void => {
    while (at < text.length) {
      const c = text.charCodeAt(at);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
      at++;
    }
  };
  const str = (): string => {
    at++; // opening quote
    let s = '';
    for (;;) {
      if (at >= text.length) fail('unterminated string');
      const c = text[at++]!;
      if (c === '"') break;
      if (c === '\\') {
        const e = text[at++];
        if (e === 'u') {
          const h = text.slice(at, at + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) fail('malformed \\u escape');
          s += String.fromCharCode(parseInt(h, 16));
          at += 4;
        } else if (e !== undefined && Object.prototype.hasOwnProperty.call(ESCAPES, e)) {
          s += ESCAPES[e]!;
        } else {
          fail(`invalid escape \\${e ?? ''}`);
        }
      } else {
        if (c.charCodeAt(0) < 0x20) fail('unescaped control character in string');
        s += c;
      }
    }
    if (hasLoneSurrogate(s)) fail('string contains a lone surrogate');
    return s;
  };
  const value = (depth: number): IJsonValue => {
    ws();
    const c = text[at];
    if (c === '{') {
      if (depth > maxDepth) fail(`nesting deeper than ${maxDepth}`);
      at++;
      const o = Object.create(null) as IJsonObject;
      ws();
      if (text[at] === '}') {
        at++;
        return o;
      }
      for (;;) {
        ws();
        if (text[at] !== '"') fail('expected a member name');
        const name = str();
        if (Object.prototype.hasOwnProperty.call(o, name)) fail(`duplicate member name "${name}"`);
        ws();
        if (text[at] !== ':') fail('expected ":"');
        at++;
        o[name] = value(depth + 1);
        ws();
        if (text[at] === ',') {
          at++;
          continue;
        }
        if (text[at] === '}') {
          at++;
          return o;
        }
        fail('expected "," or "}"');
      }
    }
    if (c === '[') {
      if (depth > maxDepth) fail(`nesting deeper than ${maxDepth}`);
      at++;
      const a: IJsonValue[] = [];
      ws();
      if (text[at] === ']') {
        at++;
        return a;
      }
      for (;;) {
        a.push(value(depth + 1));
        ws();
        if (text[at] === ',') {
          at++;
          continue;
        }
        if (text[at] === ']') {
          at++;
          return a;
        }
        fail('expected "," or "]"');
      }
    }
    if (c === '"') return str();
    if (text.startsWith('true', at)) {
      at += 4;
      return true;
    }
    if (text.startsWith('false', at)) {
      at += 5;
      return false;
    }
    if (text.startsWith('null', at)) {
      at += 4;
      return null;
    }
    NUMBER_RE.lastIndex = at;
    const m = NUMBER_RE.exec(text);
    if (m === null) return fail('unexpected character');
    const n = Number(m[0]);
    if (!Number.isFinite(n)) fail(`number ${m[0]} is not a finite binary64 value`);
    at += m[0].length;
    return n;
  };
  const v = value(1);
  ws();
  if (at !== text.length) fail('trailing characters');
  return v;
}

/** The KCC-23 codec prefix byte of a JSON declaration. */
export const DECLARATION_CODEC_JSON = 0x00;

/** The result of `decodeDeclaration`: the parsed object and its text, or why it is not a declaration. */
export type DeclarationResult =
  | { readonly valid: true; readonly object: IJsonObject; readonly text: string }
  | { readonly valid: false; readonly reason: string };

/** KCC-23 section 3.1: `0x00 || UTF-8 I-JSON object`, no byte-order mark. Never throws. */
export function decodeDeclaration(payload: Uint8Array): DeclarationResult {
  if (payload.length === 0) return { valid: false, reason: 'empty payload (no codec prefix)' };
  if (payload[0] !== DECLARATION_CODEC_JSON) return { valid: false, reason: `unknown codec prefix 0x${payload[0]!.toString(16).padStart(2, '0')}` };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload.subarray(1));
  } catch {
    return { valid: false, reason: 'payload is not valid UTF-8' };
  }
  if (text.charCodeAt(0) === 0xfeff) return { valid: false, reason: 'payload starts with a byte-order mark' };
  let v: IJsonValue;
  try {
    v = parseIJson(text);
  } catch (e) {
    return { valid: false, reason: (e as Error).message };
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return { valid: false, reason: 'the declaration is not a JSON object' };
  return { valid: true, object: v, text };
}

/** Canonical declaration payload: `0x00 ||` compact JSON in the given member order. Throws if it would not decode. */
export function encodeDeclaration(object: Readonly<Record<string, IJsonValue>>): Uint8Array {
  const bytes = concat(Uint8Array.of(DECLARATION_CODEC_JSON), new TextEncoder().encode(JSON.stringify(object)));
  const d = decodeDeclaration(bytes);
  if (!d.valid) throw new DeclarationError(`metadata does not round-trip as a KCC-23 declaration: ${d.reason}`);
  return bytes;
}

/** The display fields of a declaration, each present only when it has the expected JSON type. */
export interface DeclarationFields {
  readonly name?: string;
  readonly symbol?: string;
  readonly decimals?: number;
  readonly image?: string;
  readonly description?: string;
}

/** Pick the display fields out of a declaration object (`decimals` only when it is an integer 0..255). */
export function declarationFields(object: IJsonObject): DeclarationFields {
  const s = (k: string): string | undefined => (typeof object[k] === 'string' ? (object[k] as string) : undefined);
  const decimals = object['decimals'];
  const out: { -readonly [K in keyof DeclarationFields]: DeclarationFields[K] } = {};
  const name = s('name');
  const symbol = s('symbol');
  const image = s('image');
  const description = s('description');
  if (name !== undefined) out.name = name;
  if (symbol !== undefined) out.symbol = symbol;
  if (typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 && decimals <= 255) out.decimals = decimals;
  if (image !== undefined) out.image = image;
  if (description !== undefined) out.description = description;
  return out;
}

/* -------------------------------------------------------------------------- */
/* KCC-23 binding (section 3.3)                                                */
/* -------------------------------------------------------------------------- */

/** The result of a KCC-23 binding check: bound, unverified (preparation transaction unavailable) or invalid. */
export type BindingResult =
  | { readonly status: 'bound'; readonly authorizingInput: number; readonly outpoint: string; readonly declaration: IJsonObject; readonly text: string; readonly prepTxid: string }
  | { readonly status: 'unverified'; readonly reason: string; readonly outpoint: string }
  | { readonly status: 'invalid'; readonly reason: string; readonly step: number };

/**
 * KCC-23 section 3.3 for any lineage: the genesis group bound to `covenantId`
 * shares one authorizing input `a`; the covenant id recomputes from
 * `in[a].previous_outpoint`; the preparation transaction (looked up by the
 * outpoint's txid; `undefined` when unavailable) is version 1 with a
 * declaration payload, has the spent output, and its KIP-24 txid equals the
 * outpoint's txid.
 */
export function verifyKcc23Binding(covenantId: string, genesis: PlainTx, lookup: (txid: string) => PlainTx | undefined): BindingResult {
  const bound = genesis.outputs.map((o, i) => ({ i, o })).filter(({ o }) => o.covenant?.covenantId === covenantId);
  if (bound.length === 0) return { status: 'invalid', step: 1, reason: 'no genesis output is bound to the covenant id' };
  const auths = new Set(bound.map(({ o }) => o.covenant!.authorizingInput));
  if (auths.size !== 1) return { status: 'invalid', step: 1, reason: `outputs bound to the id name ${auths.size} authorizing inputs` };
  const a = [...auths][0]!;
  const input = genesis.inputs[a];
  if (input === undefined) return { status: 'invalid', step: 1, reason: `authorizing input ${a} does not exist` };
  const outpoint = `${input.transactionId}:${input.index}`;
  const id = covenantIdKip20(input.transactionId, input.index, bound.map(({ i, o }) => ({ index: i, value: o.value, scriptVersion: o.scriptVersion, script: fromHex(o.script) })));
  if (id !== covenantId) return { status: 'invalid', step: 2, reason: `recomputed covenant id ${id} differs from ${covenantId}` };
  const prep = lookup(input.transactionId);
  if (prep === undefined) return { status: 'unverified', outpoint, reason: `preparation transaction ${input.transactionId} is not available` };
  if (prep.version !== 1) return { status: 'invalid', step: 3, reason: `preparation transaction is version ${prep.version}, not 1` };
  if (prep.outputs[input.index] === undefined) return { status: 'invalid', step: 3, reason: `preparation transaction has no output ${input.index}` };
  const decl = decodeDeclaration(fromHex(prep.payload));
  if (!decl.valid) return { status: 'invalid', step: 3, reason: `payload is not a KCC-23 declaration: ${decl.reason}` };
  const prepTxid = txidV1(prep).txid;
  if (prepTxid !== input.transactionId) return { status: 'invalid', step: 4, reason: `recomputed preparation txid ${prepTxid} differs from the spent outpoint's ${input.transactionId}` };
  return { status: 'bound', authorizingInput: a, outpoint, declaration: decl.object, text: decl.text, prepTxid };
}

/* -------------------------------------------------------------------------- */
/* Launch proof                                                                */
/* -------------------------------------------------------------------------- */

/** Version string of this verifier, reported in every `LaunchProofResult`. */
export const LAUNCH_PROOF_VERIFIER_VERSION = 'kcc0023-launch-proof/1';

const BORROW_DISABLED = 0x00;
const TOKEN_PROGRAM_LENGTH = 4031;
const TOKEN_STATE_OFFSET = 34;

// The curve state (53 B) is read and written with the shared cell-state codec (`cell-state.ts`).

/** The bundle served at `GET /v1/tokens/:id/launch-proof`, in memory form. */
export interface LaunchProofBundle {
  /** tx01, the preparation and curve genesis transaction; `null` when the server does not hold it. */
  readonly tx01: PlainTx | null;
  /** tx2, the token genesis and curve init. */
  readonly tx2: PlainTx;
  /** The token lineage id T, hex. */
  readonly T: string;
  /** The curve lineage id C, hex. */
  readonly C: string;
  /** Reference token template hash. */
  readonly H_T: string;
  /** Curve template hash. */
  readonly H_C: string;
  /** Curve template prefix, hex. */
  readonly curvePrefix: string;
  /** Curve template suffix, hex. */
  readonly curveSuffix: string;
  /** Reference token suffix (3,885 B). */
  readonly tokenSuffix: string;
  /** The curve's constructor constants as the server decoded them (decimal strings and hex). */
  readonly params: Readonly<Record<string, string | number>>;
  /** Genesis token amounts by tx2 output index. */
  readonly states: readonly { readonly index: number; readonly amount: string }[];
  /** The declaration as the server decoded it; informational, the verifier decodes tx01's payload itself. */
  readonly declaration: IJsonObject | null;
  /** The graduation transaction with the pool id P; `null` while the curve is bonding (step 9 is then not applicable). */
  readonly graduation?: LaunchProofGraduation | null;
}

/** The answer of `VerifierTrust.curveTemplate`. */
export interface CurveTemplateCheck {
  /** Whether the template is an accepted Kasseal curve template. */
  readonly ok: boolean;
  /** Why not, when `ok` is false. */
  readonly reason?: string;
  /** Constructor constants recovered from the template bytes; compared with the bundle's `params` when present. */
  readonly params?: Readonly<Record<string, string | number>>;
}

/** What the verifier trusts independently of the bundle. */
export interface VerifierTrust {
  /** The reference KCC20 suffix (3,885 B) from the pinned artifact. */
  readonly referenceSuffix: Uint8Array;
  /** Whether `(prefix, suffix)` is a Kasseal curve template (and, optionally, its constants). */
  readonly curveTemplate?: (prefix: Uint8Array, suffix: Uint8Array) => CurveTemplateCheck;
}

/** One verification step's outcome. */
export interface ProofStep {
  /** Step number, 1..9. */
  readonly step: number;
  /** Step name. */
  readonly name: string;
  /** Whether it passed. */
  readonly ok: boolean;
  /** What was checked, for display. */
  readonly detail: Record<string, unknown>;
}

/** Overall launch-proof outcome; only `bound` means the token was proven launched as declared. */
export type LaunchProofStatus = 'bound' | 'unverified' | 'invalid';

/**
 * Something the verifier tolerated and reports without failing a step: a signature script in a consensus-valid
 * but non-minimal encoding. `kind` is `non-minimal-push` (a push form other than the minimal one, the same
 * payloads) or `non-minimal-number` (`arguments`: push indices of `int` arguments padded beyond their minimal
 * ScriptNum, the same numbers).
 */
export interface ProofNote {
  readonly step: number;
  /** The transaction whose input it is: tx2 (`init`, step 8) or the graduation (`graduate`, step 9). */
  readonly tx: 'tx2' | 'graduation';
  readonly input: number;
  readonly kind: typeof NON_MINIMAL_PUSH | typeof NON_MINIMAL_NUMBER;
  readonly arguments?: readonly number[];
}

/** The result of `verifyLaunchProof`. */
export interface LaunchProofResult {
  /** Overall outcome. */
  readonly status: LaunchProofStatus;
  /** Every step run, in order. */
  readonly steps: readonly ProofStep[];
  /** The sealed total supply in whole tokens, once proven. */
  readonly totalSupply?: bigint;
  /** The bound declaration, when `bound`. */
  readonly declaration?: IJsonObject;
  /** Why the proof is not `bound`. */
  readonly reason?: string;
  /** `LAUNCH_PROOF_VERIFIER_VERSION`. */
  readonly verifier: string;
  /** Informational notes (non-minimal encodings the chain accepted); absent when there are none. */
  readonly notes?: readonly ProofNote[];
}

/** Number of launch-proof steps. */
export const LAUNCH_PROOF_STEPS = 9;

const STEP_NAMES: Readonly<Record<number, string>> = {
  1: 'lineage T', 2: 'program', 3: 'state', 4: 'sealing argument', 5: 'lineage C', 6: 'custody argument', 7: 'metadata (KCC-23)', 8: 'R recovery',
  9: 'graduation group integrity',
};

/** The graduation transaction and the pool id it created, once the curve has graduated. */
export interface LaunchProofGraduation {
  /** The graduation transaction. */
  readonly tx: PlainTx;
  /** The pool lineage id P, as the server recorded it (recomputed by step 9). */
  readonly P: string;
}

function paramBig(params: LaunchProofBundle['params'], key: string): bigint {
  const v = params[key];
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)) return BigInt(v);
  throw new DecodeError(`params.${key} is not a non-negative integer`);
}

function tokenGenesisState(amount: bigint, owner: string): Uint8Array {
  return kcc0020_112.encode(makeKcc0020State({ amount, owner: fromHex(owner), ownerScheme: OWNER_SCHEME_COVENANT_ID, borrowScheme: BORROW_DISABLED }));
}

/** The notes of one input read by the consensus rules: none when its encoding was the minimal one. */
function encodingNotes(step: number, tx: ProofNote['tx'], input: number, c: ConsensusInvocation): ProofNote[] {
  const notes: ProofNote[] = [];
  if (!c.minimalPushes) notes.push({ step, tx, input, kind: NON_MINIMAL_PUSH });
  if (c.nonMinimalNumbers.length > 0) notes.push({ step, tx, input, kind: NON_MINIMAL_NUMBER, arguments: [...c.nonMinimalNumbers] });
  return notes;
}

/** A step's `detail.encoding`, present only when an input of it was not minimally encoded. */
function encodingDetail(notes: readonly ProofNote[]): Record<string, unknown> {
  if (notes.length === 0) return {};
  const numbers = notes.find((n) => n.kind === NON_MINIMAL_NUMBER);
  return { encoding: { minimalPushes: !notes.some((n) => n.kind === NON_MINIMAL_PUSH), nonMinimalNumbers: numbers?.arguments ?? [] } };
}

/**
 * The curve `init` invocation revealed by tx2's curve input `input`, read by the consensus rules: the `init(prefix,
 * suffix)` arguments and program, or a reason it is not one.
 */
function curveInit(sigscript: string, input: number): { program: Uint8Array; tokenPrefix: Uint8Array; tokenSuffix: Uint8Array; notes: ProofNote[] } | string {
  try {
    const c = decodeInvocationByConsensus(fromHex(sigscript), 'curve');
    const d = c.decoded;
    if (d.invocation.contract !== 'curve' || d.invocation.entry !== 'init') return `the curve input invokes ${d.invocation.entry}, not init`;
    return { program: d.program, tokenPrefix: d.invocation.tokenPrefix, tokenSuffix: d.invocation.tokenSuffix, notes: encodingNotes(8, 'tx2', input, c) };
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * Run the nine launch-proof steps over `bundle`, trusting only `trust`; every hash in the bundle is recomputed.
 * Never throws on bundle content: a failure is an `invalid` result. Treat a token as launched as declared only when
 * `status === 'bound'`.
 */
export function verifyLaunchProof(bundle: LaunchProofBundle, trust: VerifierTrust): LaunchProofResult {
  const steps: ProofStep[] = [];
  const notes: ProofNote[] = [];
  const withNotes = (): { notes?: readonly ProofNote[] } => (notes.length === 0 ? {} : { notes });
  const pass = (step: number, detail: Record<string, unknown> = {}): void => {
    steps.push({ step, name: STEP_NAMES[step]!, ok: true, detail });
  };
  const invalid = (step: number, reason: string): LaunchProofResult => {
    steps.push({ step, name: STEP_NAMES[step]!, ok: false, detail: { reason } });
    return { status: 'invalid', steps, reason: `step ${step} (${STEP_NAMES[step]}): ${reason}`, verifier: LAUNCH_PROOF_VERIFIER_VERSION, ...withNotes() };
  };
  try {
    return run();
  } catch (e) {
    return invalid(Math.min(steps.length + 1, LAUNCH_PROOF_STEPS), `malformed bundle: ${(e as Error).message}`);
  }

  function run(): LaunchProofResult {
    const { tx01, tx2, T, C } = bundle;
    // 1. Lineage T: the outputs bound to T share one authorizing input spending a non-T outpoint, and the id recomputes.
    const bound = tx2.outputs.map((o, i) => ({ i, o })).filter(({ o }) => o.covenant?.covenantId === T);
    if (bound.length === 0) return invalid(1, 'no tx2 output is bound to T');
    const auths = new Set(bound.map(({ o }) => o.covenant!.authorizingInput));
    if (auths.size !== 1) return invalid(1, `the outputs bound to T name ${auths.size} authorizing inputs`);
    const a = [...auths][0]!;
    const authIn = tx2.inputs[a];
    if (authIn === undefined) return invalid(1, `authorizing input ${a} does not exist`);
    const recomputedT = covenantIdKip20(authIn.transactionId, authIn.index, bound.map(({ i, o }) => ({ index: i, value: o.value, scriptVersion: o.scriptVersion, script: fromHex(o.script) })));
    if (recomputedT !== T) return invalid(1, `recomputed ${recomputedT} differs from T ${T}`);
    if (bound.length !== 2 || bound[0]!.i !== 0 || bound[1]!.i !== 1) return invalid(1, `expected outputs 0 and 1 bound to T, got ${bound.map((b) => b.i).join(',')}`);
    pass(1, { authorizingInput: a, outpoint: `${authIn.transactionId}:${authIn.index}`, groupOutputs: bound.map((b) => b.i) });

    // 2. Program: R = 6b 20 H_T || EncodeState_112 || suffix with the reference suffix, hashing to each spk.
    const suffix = fromHex(bundle.tokenSuffix);
    if (!bytesEqual(suffix, trust.referenceSuffix)) return invalid(2, 'the token suffix differs from the reference artifact');
    if (bundle.H_T !== REFERENCE_KCC0020_TEMPLATE_HASH || templateHash(Uint8Array.of(0x6b), trust.referenceSuffix) !== REFERENCE_KCC0020_TEMPLATE_HASH) {
      return invalid(2, 'the token template is not the reference KCC20');
    }
    let totalSupply = 0n;
    const cells: Record<string, unknown>[] = [];
    for (const { i, o } of bound) {
      const expected = bundle.states.find((s) => s.index === i);
      if (expected === undefined) return invalid(3, `no genesis state for output ${i}`);
      const amount = BigInt(expected.amount);
      const stateBytes = tokenGenesisState(amount, C);
      const R = concat(Uint8Array.of(0x6b, 0x20), fromHex(REFERENCE_KCC0020_TEMPLATE_HASH), stateBytes, trust.referenceSuffix);
      if (R.length !== TOKEN_PROGRAM_LENGTH) return invalid(2, `token program is ${R.length} B`);
      if (o.scriptVersion !== 0 || toHex(p2shScript(R)) !== o.script) return invalid(2, `output ${i} does not commit to the token program with the stated genesis state`);
      // 3. State: decode the window back (canonical, no trailing bytes) and check the sealing fields.
      const decoded = kcc0020_112.decode(R.subarray(TOKEN_STATE_OFFSET, TOKEN_STATE_OFFSET + 112), kcc0020_112.referenceSchemes);
      const f = kcc0020Fields(decoded);
      if (toHex(f.owner) !== C || f.ownerScheme !== OWNER_SCHEME_COVENANT_ID) return invalid(3, `output ${i}: owner is not C under covenant-id/v1`);
      if (f.borrowScheme !== BORROW_DISABLED || !bytesEqual(f.borrowGuard, ZERO32) || !bytesEqual(f.extensionCommitment, ZERO32)) return invalid(3, `output ${i}: borrow or extension fields are not zero`);
      totalSupply += f.amount;
      cells.push({ index: i, amount: f.amount.toString(), value: o.value.toString() });
    }
    pass(2, { templateHash: REFERENCE_KCC0020_TEMPLATE_HASH, programBytes: TOKEN_PROGRAM_LENGTH });
    const expectedSupply = paramBig(bundle.params, 'curveLots') * paramBig(bundle.params, 'lot') + paramBig(bundle.params, 'gradReserve');
    if (totalSupply !== expectedSupply) return invalid(3, `genesis amounts sum to ${totalSupply}, the parameters give ${expectedSupply}`);
    pass(3, { cells, totalSupply: totalSupply.toString() });
    pass(4, { statement: 'the reference program exposes transfer (conserving) and transfer_delegator only; consensus derives covenant ids from genesis outpoints, so no further output with id T can be created; the sum over live T cells equals the genesis sum forever' });

    if (tx01 === null) {
      const g = graduationStep();
      if (g !== undefined) return g;
      return {
        status: 'unverified', steps, totalSupply, verifier: LAUNCH_PROOF_VERIFIER_VERSION, ...withNotes(),
        reason: `the preparation transaction ${authIn.transactionId} is not available; lineage C and the declaration are not proven`,
      };
    }

    // 5. Lineage C.
    const in0 = tx01.inputs[0];
    const out1 = tx01.outputs[1];
    if (in0 === undefined || out1 === undefined) return invalid(5, 'tx01 lacks input 0 or output 1');
    const recomputedC = covenantIdKip20(in0.transactionId, in0.index, [{ index: 1, value: out1.value, scriptVersion: out1.scriptVersion, script: fromHex(out1.script) }]);
    if (recomputedC !== C) return invalid(5, `recomputed ${recomputedC} differs from C ${C}`);
    if (out1.covenant?.covenantId !== C || out1.covenant.authorizingInput !== 0) return invalid(5, 'tx01 output 1 is not bound (0, C)');
    if (tx01.outputs.some((o, i) => i !== 1 && o.covenant?.covenantId === C)) return invalid(5, 'tx01 binds C to more than output 1');
    if (tx01.version < 1) return invalid(7, `tx01 is version ${tx01.version}, not 1`);
    const tx01id = txidV1(tx01).txid;
    const curveIn = tx2.inputs.findIndex((i) => i.transactionId === tx01id && i.index === 1);
    if (curveIn < 0) return invalid(5, 'tx2 does not spend tx01:1');
    const cOut = tx2.outputs.map((o, i) => ({ i, o })).filter(({ o }) => o.covenant?.covenantId === C);
    if (cOut.length !== 1 || cOut[0]!.o.covenant!.authorizingInput !== curveIn) return invalid(5, `expected exactly one tx2 output bound (${curveIn}, C), found ${cOut.length}`);
    const prefixC = fromHex(bundle.curvePrefix);
    const suffixC = fromHex(bundle.curveSuffix);
    const hC = templateHash(prefixC, suffixC);
    if (hC !== bundle.H_C) return invalid(5, `the curve template hashes to ${hC}, the bundle states ${bundle.H_C}`);
    if (trust.curveTemplate !== undefined) {
      const check = trust.curveTemplate(prefixC, suffixC);
      if (!check.ok) return invalid(5, `not a Kasseal curve template: ${check.reason ?? 'rejected'}`);
      if (check.params !== undefined) {
        for (const [k, v] of Object.entries(check.params)) {
          if (String(bundle.params[k]) !== String(v)) return invalid(5, `params.${k} is ${String(bundle.params[k])}, the template carries ${String(v)}`);
        }
      }
    }
    const rInit = concat(prefixC, encodeCurveState({ tokenCovId: fromHex(T), lotsSold: 0n, feeAccrued: 0n, phase: PHASE_ACTIVE }), suffixC);
    if (cOut[0]!.o.scriptVersion !== 0 || toHex(p2shScript(rInit)) !== cOut[0]!.o.script) return invalid(5, 'the tx2 curve output does not commit to the program with state {T, 0, 0, active}');
    const rGenesis = concat(prefixC, encodeCurveState({ tokenCovId: ZERO32, lotsSold: 0n, feeAccrued: 0n, phase: PHASE_UNINIT }), suffixC);
    if (out1.scriptVersion !== 0 || toHex(p2shScript(rGenesis)) !== out1.script) return invalid(5, 'tx01 output 1 does not commit to the program with state {0^32, 0, 0, uninit}');
    pass(5, { H_C: hC, curveBytes: rInit.length, params: bundle.params });
    pass(6, { statement: 'C-owned token cells move only in a transaction with a C input; C exposes init, buy, sell, graduate and sweep, each forbidding or fully validating the T transition at the coded price; sweep is bounded by feeAccrued; there is no operator path to tokens or escrow' });

    // 7. Metadata: the T group's authorizing input spends tx01:0; tx01 carries a declaration and its KIP-24 txid (covenant field included) matches.
    if (authIn.transactionId !== tx01id || authIn.index !== 0) return invalid(7, `the T group's authorizing input spends ${authIn.transactionId}:${authIn.index}, not tx01:0 (${tx01id})`);
    const binding = verifyKcc23Binding(T, tx2, (id) => (id === tx01id ? tx01 : undefined));
    if (binding.status !== 'bound') return invalid(7, binding.reason);
    const id = txidV1(tx01);
    pass(7, { prepTxid: id.txid, payloadDigest: id.payloadDigest, restDigest: id.restDigest, declaration: binding.text });

    // 8. R recovery: the program revealed by tx2's curve input is the genesis program and hashes to tx01:1.
    const init = curveInit(tx2.inputs[curveIn]!.signatureScript, curveIn);
    if (typeof init === 'string') return invalid(8, init);
    notes.push(...init.notes);
    const recovered = init.program;
    if (toHex(p2shScript(recovered)) !== out1.script) return invalid(8, 'the recovered program does not hash to tx01 output 1');
    if (!bytesEqual(recovered, rGenesis)) return invalid(8, 'the recovered program differs from the genesis program');
    if (!bytesEqual(init.tokenPrefix, Uint8Array.of(0x6b)) || !bytesEqual(init.tokenSuffix, trust.referenceSuffix)) return invalid(8, 'init was not given the reference token template');
    const st = decodeCurveState(recovered.subarray(prefixC.length, prefixC.length + CURVE_STATE_LENGTH));
    pass(8, { recoveredBytes: recovered.length, state: { tokenCovId: toHex(st.tokenCovId), lotsSold: st.lotsSold.toString(), phase: st.phase }, ...encodingDetail(init.notes) });

    const g = graduationStep();
    if (g !== undefined) return g;
    return { status: 'bound', steps, totalSupply, declaration: binding.declaration, verifier: LAUNCH_PROOF_VERIFIER_VERSION, ...withNotes() };
  }

  /**
   * Step 9, graduation group integrity. Returns the invalid
   * result when the check fails, undefined when it passes or does not apply.
   */
  function graduationStep(): LaunchProofResult | undefined {
    const g = bundle.graduation ?? null;
    if (g === null) {
      pass(9, { applicable: false, reason: 'the curve has not graduated; the check runs on the graduation transaction' });
      return undefined;
    }
    const r = checkGraduationGroup(g, bundle, trust.referenceSuffix);
    if (!r.ok) return invalid(9, r.reason);
    notes.push(...r.notes);
    pass(9, { applicable: true, ...r.detail, ...encodingDetail(r.notes) });
    return undefined;
  }
}

const P2SH_SCRIPT_RE = /^aa20[0-9a-f]{64}87$/;

/** The result of `checkGraduationGroup`. */
export type GraduationGroupCheck =
  | { readonly ok: true; readonly detail: Record<string, unknown>; readonly notes: readonly ProofNote[] }
  | { readonly ok: false; readonly reason: string };

/**
 * The checks of step 9 over a graduation transaction, independent of the
 * server that served it:
 *
 *   a. P is a 32-byte id distinct from T and C;
 *   b. the outputs bound to P share one authorizing input and P recomputes
 *      over that whole group per KIP-20 section 3.2 (keyed BLAKE2b over
 *      `(outpoint, [(index, value, script version, script)...])`);
 *   c. that group is output 0 alone: exactly one output bound to P, a
 *      version-0 P2SH cell (the pool genesis), never a plain output;
 *   d. exactly one output is bound to T, and it commits to the reference
 *      token program with state `{amount gradReserve, owner P, scheme 0x04,
 *      borrow 0x00, zero guard and extension}`: the pool-owned reserve;
 *   e. no output is bound to C (graduation is terminal);
 *   f. one input invokes `graduate(poolPrefix, poolSuffix)` on the curve
 *      program `curvePrefix || state || curveSuffix` with state
 *      `{T, curveLots, _, active}`, and `TemplateHash(poolPrefix, poolSuffix)`
 *      equals `params.poolH` when the bundle carries it. Anyone may submit the
 *      graduation, so its signature scripts are read by the consensus rules
 *      (`decodeInvocationByConsensus`); a non-minimal encoding is returned in
 *      `notes`, not as a failure;
 *   g. one input spends C's own reserve: its redeem script (the last push of
 *      its signature script, read by the consensus push rule) is exactly the reference
 *      token program with the reserve's genesis state `{amount gradReserve,
 *      owner C, scheme 0x04, borrow 0x00, zero guard and extension}`. A
 *      counterfeit curve cell running C's program can graduate a reserve it
 *      owns itself into a pool naming T; only C's own
 *      reserve makes the pool T's.
 */
export function checkGraduationGroup(g: LaunchProofGraduation, bundle: Pick<LaunchProofBundle, 'T' | 'C' | 'curvePrefix' | 'curveSuffix' | 'params'>, referenceSuffix: Uint8Array): GraduationGroupCheck {
  const { T, C } = bundle;
  const P = g.P;
  const tx = g.tx;
  const fail = (reason: string): GraduationGroupCheck => ({ ok: false, reason });
  if (!/^[0-9a-f]{64}$/.test(P)) return fail('the pool id P is not a 32-byte id');
  if (P === T || P === C) return fail('the pool id P equals T or C');
  // b. the P group and its recomputation
  const group = tx.outputs.map((o, i) => ({ i, o })).filter(({ o }) => o.covenant?.covenantId === P);
  if (group.length === 0) return fail('no output of the graduation transaction is bound to the pool id P');
  const auths = new Set(group.map(({ o }) => o.covenant!.authorizingInput));
  if (auths.size !== 1) return fail(`the outputs bound to P name ${auths.size} authorizing inputs`);
  const a = [...auths][0]!;
  const authIn = tx.inputs[a];
  if (authIn === undefined) return fail(`the P group's authorizing input ${a} does not exist`);
  const recomputed = covenantIdKip20(authIn.transactionId, authIn.index, group.map(({ i, o }) => ({ index: i, value: o.value, scriptVersion: o.scriptVersion, script: fromHex(o.script) })));
  if (recomputed !== P) return fail(`the P group (outputs ${group.map((x) => x.i).join(',')}) recomputes to ${recomputed}, not P ${P}`);
  // c. exactly one output bound to P: the pool genesis cell at index 0
  if (group.length !== 1 || group[0]!.i !== 0) {
    return fail(`${group.length} outputs are bound to the pool id P (${group.map((x) => x.i).join(', ')}); the pool genesis group must be output 0 alone, or any other member carries P and can release the pool-owned reserve by presence`);
  }
  const pool = group[0]!.o;
  if (pool.scriptVersion !== 0 || !P2SH_SCRIPT_RE.test(pool.script)) return fail('output 0 (bound to P) is not a version-0 P2SH covenant cell');
  // d. the reserve: the only output bound to T, pool-owned, gradReserve tokens
  const tOuts = tx.outputs.map((o, i) => ({ i, o })).filter(({ o }) => o.covenant?.covenantId === T);
  if (tOuts.length !== 1) return fail(`${tOuts.length} outputs are bound to T; graduation re-owns exactly one reserve cell to the pool`);
  const reserve = tOuts[0]!;
  if (tx.inputs[reserve.o.covenant!.authorizingInput] === undefined) return fail(`the reserve output names a missing authorizing input ${reserve.o.covenant!.authorizingInput}`);
  const gradReserve = paramBig(bundle.params, 'gradReserve');
  const reserveProgram = concat(Uint8Array.of(0x6b, 0x20), fromHex(REFERENCE_KCC0020_TEMPLATE_HASH), tokenGenesisState(gradReserve, P), referenceSuffix);
  if (reserve.o.scriptVersion !== 0 || toHex(p2shScript(reserveProgram)) !== reserve.o.script) {
    return fail(`output ${reserve.i} (bound to T) does not commit to the reference token program with state {${gradReserve}, owner P, 0x04}`);
  }
  // e. terminal for C
  if (tx.outputs.some((o) => o.covenant?.covenantId === C)) return fail('an output is bound to C; graduation leaves no curve continuation');
  // f. the graduate invocation on C's program at the last lot
  const prefixC = fromHex(bundle.curvePrefix);
  const suffixC = fromHex(bundle.curveSuffix);
  const curveLots = paramBig(bundle.params, 'curveLots');
  let found: { input: number; poolTemplateHash: string; lotsSold: bigint; notes: ProofNote[] } | undefined;
  for (const [k, input] of tx.inputs.entries()) {
    let c;
    try {
      c = decodeInvocationByConsensus(fromHex(input.signatureScript), 'curve');
    } catch {
      continue;
    }
    const d = c.decoded;
    if (d.invocation.contract !== 'curve' || d.invocation.entry !== 'graduate') continue;
    const program = d.program;
    if (program.length !== prefixC.length + CURVE_STATE_LENGTH + suffixC.length) return fail(`input ${k} invokes graduate on a program of ${program.length} B, not the curve template's length`);
    if (!bytesEqual(program.subarray(0, prefixC.length), prefixC) || !bytesEqual(program.subarray(prefixC.length + CURVE_STATE_LENGTH), suffixC)) {
      return fail(`input ${k} invokes graduate on a program that is not the curve template of C`);
    }
    let st;
    try {
      st = decodeCurveState(program.subarray(prefixC.length, prefixC.length + CURVE_STATE_LENGTH));
    } catch (e) {
      return fail(`input ${k} graduates a curve whose state does not decode: ${(e as Error).message}`);
    }
    if (toHex(st.tokenCovId) !== T || st.phase !== PHASE_ACTIVE) return fail(`input ${k} graduates a curve whose state names ${toHex(st.tokenCovId)} in phase ${st.phase}, not T active`);
    if (st.lotsSold !== curveLots) return fail(`input ${k} graduates at ${st.lotsSold} of ${curveLots} lots`);
    const hP = templateHash(d.invocation.poolPrefix, d.invocation.poolSuffix);
    const poolH = bundle.params['poolH'];
    if (typeof poolH === 'string' && poolH !== hP) return fail(`graduate names pool template ${hP}, the curve requires ${poolH}`);
    found = { input: k, poolTemplateHash: hP, lotsSold: st.lotsSold, notes: encodingNotes(9, 'graduation', k, c) };
    break;
  }
  if (found === undefined) return fail('no input of the graduation transaction invokes graduate on the curve program of C');
  // g. the reserve spent is C's own: the reference token program with the reserve's genesis state, owner C.
  // The redeem script is the LAST PUSH of the signature script, read by the consensus push rule, and must equal the
  // program exactly. A suffix match on the raw bytes is not enough: an anyone-can-spend
  // P2SH input whose redeem script is `OP_PUSHDATA2 len || R_C` ends with the same bytes without spending C's reserve.
  const cReserve = concat(Uint8Array.of(0x6b, 0x20), fromHex(REFERENCE_KCC0020_TEMPLATE_HASH), tokenGenesisState(gradReserve, C), referenceSuffix);
  const redeemIs = (sigscript: string, program: Uint8Array): boolean => {
    try {
      const payloads = consensusSigScript(fromHex(sigscript.toLowerCase())).payloads;
      return payloads.length > 0 && bytesEqual(payloads[payloads.length - 1]!, program);
    } catch {
      return false;
    }
  };
  if (!tx.inputs.some((input) => redeemIs(input.signatureScript, cReserve))) {
    return fail(`no input of the graduation transaction spends C's reserve ({${gradReserve}, owner C, 0x04}); a curve with C's program but another id graduated its own reserve`);
  }
  let txid: string | undefined;
  try {
    txid = txidV1(tx).txid;
  } catch {
    txid = undefined;
  }
  return {
    ok: true,
    detail: {
      ...(txid === undefined ? {} : { txid }), P, poolOutput: 0, groupOutputs: [0], authorizingInput: a, outpoint: `${authIn.transactionId}:${authIn.index}`,
      reserveOutput: reserve.i, reserveAmount: gradReserve.toString(), curveInput: found.input, poolTemplateHash: found.poolTemplateHash, lotsSold: found.lotsSold.toString(),
    },
    notes: found.notes,
  };
}

/* -------------------------------------------------------------------------- */
/* JSON form                                                                   */
/* -------------------------------------------------------------------------- */

/** JSON form of a bundle (transactions via `plainTxToJson`, bigints as decimal strings). */
export function launchProofToJson(b: LaunchProofBundle): Record<string, unknown> {
  return {
    tx01: b.tx01 === null ? null : plainTxToJson(b.tx01),
    tx2: plainTxToJson(b.tx2),
    T: b.T, C: b.C, H_T: b.H_T, H_C: b.H_C,
    curvePrefix: b.curvePrefix, curveSuffix: b.curveSuffix, tokenSuffix: b.tokenSuffix,
    states: b.states.map((s) => ({ index: s.index, amount: s.amount })),
    params: { ...b.params },
    declaration: b.declaration,
    graduation: b.graduation === undefined || b.graduation === null ? null : { tx: plainTxToJson(b.graduation.tx), P: b.graduation.P },
  };
}

const HEX_RE = /^(?:[0-9a-f]{2})*$/;
const ID_RE = /^[0-9a-f]{64}$/;

/** Parse the JSON form; throws `DecodeError` on any shape violation. */
export function launchProofFromJson(j: unknown): LaunchProofBundle {
  if (j === null || typeof j !== 'object' || Array.isArray(j)) throw new DecodeError('launch proof: expected an object');
  const o = j as Record<string, unknown>;
  const id = (k: string): string => {
    const v = o[k];
    if (typeof v !== 'string' || !ID_RE.test(v)) throw new DecodeError(`launch proof: ${k} must be 32-byte lowercase hex`);
    return v;
  };
  const hex = (k: string): string => {
    const v = o[k];
    if (typeof v !== 'string' || !HEX_RE.test(v)) throw new DecodeError(`launch proof: ${k} must be lowercase hex`);
    return v;
  };
  const tx = (k: string): PlainTx => {
    const v = o[k];
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new DecodeError(`launch proof: ${k} must be a transaction object`);
    try {
      return plainTxFromJson(v as Record<string, unknown>);
    } catch (e) {
      throw new DecodeError(`launch proof: ${k}: ${(e as Error).message}`);
    }
  };
  const states = o['states'];
  if (!Array.isArray(states)) throw new DecodeError('launch proof: states must be an array');
  const params = o['params'];
  if (params === null || typeof params !== 'object' || Array.isArray(params)) throw new DecodeError('launch proof: params must be an object');
  const declaration = o['declaration'];
  const graduation = o['graduation'];
  let grad: LaunchProofGraduation | null = null;
  if (graduation !== null && graduation !== undefined) {
    if (typeof graduation !== 'object' || Array.isArray(graduation)) throw new DecodeError('launch proof: graduation must be an object or null');
    const gr = graduation as Record<string, unknown>;
    if (typeof gr['P'] !== 'string' || !ID_RE.test(gr['P'])) throw new DecodeError('launch proof: graduation.P must be 32-byte lowercase hex');
    if (gr['tx'] === null || typeof gr['tx'] !== 'object' || Array.isArray(gr['tx'])) throw new DecodeError('launch proof: graduation.tx must be a transaction object');
    try {
      grad = { tx: plainTxFromJson(gr['tx'] as Record<string, unknown>), P: gr['P'] };
    } catch (e) {
      throw new DecodeError(`launch proof: graduation.tx: ${(e as Error).message}`);
    }
  }
  return {
    tx01: o['tx01'] === null || o['tx01'] === undefined ? null : tx('tx01'),
    tx2: tx('tx2'),
    T: id('T'), C: id('C'), H_T: id('H_T'), H_C: id('H_C'),
    curvePrefix: hex('curvePrefix'), curveSuffix: hex('curveSuffix'), tokenSuffix: hex('tokenSuffix'),
    states: states.map((s, i) => {
      const r = s as Record<string, unknown>;
      if (!Number.isInteger(r['index']) || typeof r['amount'] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(r['amount'])) throw new DecodeError(`launch proof: states[${i}] is malformed`);
      return { index: r['index'] as number, amount: r['amount'] };
    }),
    params: params as Record<string, string | number>,
    declaration: declaration !== null && typeof declaration === 'object' && !Array.isArray(declaration) ? (declaration as IJsonObject) : null,
    graduation: grad,
  };
}
