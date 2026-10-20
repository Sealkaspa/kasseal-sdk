/**
 * Signature scripts of the three Kasseal lineages: program recovery, dispatch
 * tag extraction, and typed encoding and decoding of every entrypoint's
 * arguments.
 *
 *   T  token  reference KCC20 `transfer(next_states, witness)` and
 *             `transfer_delegator(witness)`
 *   C  curve  `init`, `buy`, `sell`, `sweep`, `graduate`   (curve.sil)
 *   P  pool   `swapKasForTokens`, `swapTokensForKas`, `sweep`, `bindLp`,
 *             `addLiquidity`, `removeLiquidity`   (pool.sil)
 *
 * Envelope (KCC-1 section 3.6): `PushArguments || OP_DATA_4 tag || PushMinimal(R)`.
 * The program `R` of a P2SH spend is the last push; the
 * dispatch tag is the 4-byte push before it, `BLAKE3(signature)[0:4]` of the
 * entry's declaration (KCC-1 section 3.5).
 *
 * Argument lowering (KCC-1 sections 3.4.2 and 3.4.6), as accepted on testnet-10:
 *   int       PushMinimal(ScriptNum), minimal little-endian with a sign bit
 *             (`ScriptBuilder::add_i64`): 0 is OP_0, 1..16 are OP_1..OP_16
 *   byte      PushMinimal of one byte: 0x00 is `01 00`, 0x04 is OP_4
 *   byte[N]   PushMinimal of exactly N bytes; byte[] any length
 *   record    one push per field, declaration order (`KCC20Full`, 7 fields)
 *   record[]  one push per field over the field concatenated across records
 *             (the token's `next_states`; an `int` field is the 8-byte state
 *             payload per record there)
 *
 * Decoding is strict: every push must be the minimal encoding of its payload,
 * the tag must name an entry of the stated contract, the argument count and
 * every field width must match the declaration, and the decoded invocation
 * must re-encode to the input byte for byte. Anything else throws
 * `SigScriptError`; a decoder never returns a partial result.
 *
 * A dispatch tag names a declaration, not a template: any program declaring
 * the same signature (`init(byte[],byte[])`, `sweep()`) yields the same tag.
 * The caller identifies the program by its recomputed template hash first and
 * passes the contract; decoding the arguments never establishes that a script
 * belongs to a Kasseal lineage.
 *
 * Pure TypeScript, no Node built-ins: servers and the browser share it.
 */

import { DecodeError } from './errors.ts';
import { KCC0020_DISPATCH, MAX_TOKEN_OUTPUTS, dispatchTag, encodeTransferArguments, kcc0020Fields, makeKcc0020State } from './kcc0020-112.ts';
import {
  INT_MAX, INT_STATE_WIDTH, OP_0, OP_1, OP_1NEGATE, OP_PUSHDATA1, OP_PUSHDATA2, OP_PUSHDATA4, bytesEqual, concat, decodeIntState, encodePushMinimal, fromHex, toHex,
} from './push.ts';
import type { TokenState } from './types.ts';

/** A sigscript that is not a well-formed invocation of a known entrypoint. */
export class SigScriptError extends DecodeError {}

/* -------------------------------------------------------------------------- */
/* Pushes                                                                      */
/* -------------------------------------------------------------------------- */

const OP_16 = 0x60;
const MAX_DIRECT_PUSH = 75;

/** One data push of a script. */
export interface ScriptPush {
  /** Offset of the push opcode. */
  readonly offset: number;
  /** Offset of the first payload byte (equal to `offset + 1` for OP_0 and the small-number opcodes, whose payload is implied). */
  readonly dataOffset: number;
  /** Offset immediately after the push. */
  readonly end: number;
  /** The pushed bytes. */
  readonly payload: Uint8Array;
}

/**
 * Every push of a push-only script, in order. Throws on a non-push opcode, a
 * truncated push, or any push that is not the minimal encoding of its payload
 * (OP_0 for empty, OP_1..OP_16 and OP_1NEGATE for the matching single byte,
 * a direct push up to 75 bytes, then PUSHDATA1/2/4 by size).
 */
export function parseSigScriptPushes(script: Uint8Array): ScriptPush[] {
  const out: ScriptPush[] = [];
  let at = 0;
  while (at < script.length) {
    const op = script[at]!;
    if (op === OP_0) {
      out.push({ offset: at, dataOffset: at + 1, end: at + 1, payload: new Uint8Array(0) });
      at += 1;
      continue;
    }
    if (op === OP_1NEGATE || (op >= OP_1 && op <= OP_16)) {
      out.push({ offset: at, dataOffset: at + 1, end: at + 1, payload: Uint8Array.of(op === OP_1NEGATE ? 0x81 : op - OP_1 + 1) });
      at += 1;
      continue;
    }
    let n: number;
    let header: number;
    if (op <= MAX_DIRECT_PUSH) {
      n = op;
      header = 1;
    } else if (op === OP_PUSHDATA1) {
      need(script, at, 2);
      n = script[at + 1]!;
      header = 2;
      if (n <= MAX_DIRECT_PUSH) throw new SigScriptError(`offset ${at}: non-minimal push, PUSHDATA1 for ${n} bytes`);
    } else if (op === OP_PUSHDATA2) {
      need(script, at, 3);
      n = script[at + 1]! | (script[at + 2]! << 8);
      header = 3;
      if (n <= 0xff) throw new SigScriptError(`offset ${at}: non-minimal push, PUSHDATA2 for ${n} bytes`);
    } else if (op === OP_PUSHDATA4) {
      need(script, at, 5);
      n = (script[at + 1]! | (script[at + 2]! << 8) | (script[at + 3]! << 16) | (script[at + 4]! << 24)) >>> 0;
      header = 5;
      if (n <= 0xffff) throw new SigScriptError(`offset ${at}: non-minimal push, PUSHDATA4 for ${n} bytes`);
    } else {
      throw new SigScriptError(`offset ${at}: opcode 0x${op.toString(16).padStart(2, '0')} is not a data push`);
    }
    need(script, at, header + n);
    const payload = script.subarray(at + header, at + header + n);
    if (n === 1 && ((payload[0]! >= 1 && payload[0]! <= 16) || payload[0] === 0x81)) {
      throw new SigScriptError(`offset ${at}: non-minimal push of byte 0x${payload[0]!.toString(16)} (a small-number opcode exists)`);
    }
    out.push({ offset: at, dataOffset: at + header, end: at + header + n, payload });
    at += header + n;
  }
  return out;
}

function need(script: Uint8Array, at: number, len: number): void {
  if (at + len > script.length) throw new SigScriptError(`offset ${at}: truncated push, need ${len} bytes, have ${script.length - at}`);
}

/** The program `R` of a P2SH spend: the last push of its sigscript. */
export function programFromSigScript(sigscript: Uint8Array): Uint8Array {
  const pushes = parseSigScriptPushes(sigscript);
  if (pushes.length === 0) throw new SigScriptError('empty sigscript');
  return pushes[pushes.length - 1]!.payload;
}

/** A sigscript split into its argument pushes, dispatch tag and program. */
export interface SigScriptEnvelope {
  /** The argument pushes, in order (everything before the tag push). */
  readonly argumentPushes: readonly ScriptPush[];
  /** Dispatch tag, lowercase hex (8 characters). */
  readonly tag: string;
  /** The program `R` (the last push). */
  readonly program: Uint8Array;
  /** Offset of the program push opcode. */
  readonly programOffset: number;
}

/** Split a KCC-1 sigscript into arguments, dispatch tag and program. */
export function parseSigScriptEnvelope(sigscript: Uint8Array): SigScriptEnvelope {
  const pushes = parseSigScriptPushes(sigscript);
  if (pushes.length < 2) throw new SigScriptError(`a KCC-1 sigscript has a tag push and a program push, got ${pushes.length} push(es)`);
  const tagPush = pushes[pushes.length - 2]!;
  if (sigscript[tagPush.offset] !== 0x04 || tagPush.payload.length !== 4) throw new SigScriptError(`offset ${tagPush.offset}: the dispatch tag must be OP_DATA_4 with 4 bytes`);
  const programPush = pushes[pushes.length - 1]!;
  if (programPush.payload.length === 0) throw new SigScriptError('empty program push');
  return { argumentPushes: pushes.slice(0, -2), tag: toHex(tagPush.payload), program: programPush.payload, programOffset: programPush.offset };
}

/** The dispatch tag of a KCC-1 sigscript, lowercase hex. */
export function dispatchTagOfSigScript(sigscript: Uint8Array): string {
  return parseSigScriptEnvelope(sigscript).tag;
}

/* -------------------------------------------------------------------------- */
/* ScriptNum                                                                   */
/* -------------------------------------------------------------------------- */

/** Widest ScriptNum an `int` argument takes (i64). */
export const SCRIPT_NUM_MAX_LENGTH = 8;

/** Minimal ScriptNum encoding of a KCC-1 `int` argument (`ScriptBuilder::add_i64`). */
export function encodeScriptNum(value: bigint): Uint8Array {
  if (value > INT_MAX || value < -INT_MAX) throw new SigScriptError(`int argument out of range: ${value}`);
  if (value === 0n) return new Uint8Array(0);
  const negative = value < 0n;
  let magnitude = negative ? -value : value;
  const out: number[] = [];
  while (magnitude > 0n) {
    out.push(Number(magnitude & 0xffn));
    magnitude >>= 8n;
  }
  if ((out[out.length - 1]! & 0x80) !== 0) out.push(negative ? 0x80 : 0x00);
  else if (negative) out[out.length - 1]! |= 0x80;
  return Uint8Array.from(out);
}

/** Decode a minimally encoded ScriptNum of at most `maxLength` bytes. */
export function decodeScriptNum(payload: Uint8Array, maxLength = SCRIPT_NUM_MAX_LENGTH): bigint {
  if (payload.length > maxLength) throw new SigScriptError(`int argument is ${payload.length} bytes, above ${maxLength}`);
  if (payload.length === 0) return 0n;
  const last = payload[payload.length - 1]!;
  if ((last & 0x7f) === 0 && (payload.length === 1 || (payload[payload.length - 2]! & 0x80) === 0)) {
    throw new SigScriptError(`int argument ${toHex(payload)} is not minimally encoded`);
  }
  let magnitude = BigInt(last & 0x7f);
  for (let i = payload.length - 2; i >= 0; i--) magnitude = (magnitude << 8n) | BigInt(payload[i]!);
  const value = (last & 0x80) !== 0 ? -magnitude : magnitude;
  if (value > INT_MAX || value < -INT_MAX) throw new SigScriptError(`int argument out of range: ${value}`);
  return value;
}

/** `int` argument push: the minimal push of the minimal ScriptNum of `value`. */
export const pushScriptNum = (value: bigint): Uint8Array => encodePushMinimal(encodeScriptNum(value));
/** `byte` argument push: the minimal push of one byte; throws `SigScriptError` outside 0..255. */
export const pushByteArgument = (b: number): Uint8Array => {
  if (!Number.isInteger(b) || b < 0 || b > 0xff) throw new SigScriptError(`byte argument out of range: ${b}`);
  return encodePushMinimal(Uint8Array.of(b));
};

/* -------------------------------------------------------------------------- */
/* KCC20Full                                                                   */
/* -------------------------------------------------------------------------- */

/** The curve's and pool's 7-field view of a reference token state (`KCC20Full`): the template context first. */
export interface Kcc20Full {
  readonly ctx: Uint8Array;
  readonly amount: bigint;
  readonly owner: Uint8Array;
  readonly scheme: number;
  readonly borrow: number;
  readonly guard: Uint8Array;
  readonly ext: Uint8Array;
}

/** The `KCC20Full` record type as it appears in a Silverscript function signature. */
export const KCC20_FULL_TYPE = '{byte[32],int,byte[32],byte,byte,byte[32],byte[32]}';
const KCC20_FULL_PUSHES = 7;

/** `KCC20Full` view of a reference token state under template hash `tokenTemplateHash` (hex). */
export function kcc20Full(state: TokenState, tokenTemplateHash: string): Kcc20Full {
  const f = kcc0020Fields(state);
  return { ctx: fromHex(tokenTemplateHash), amount: f.amount, owner: f.owner, scheme: f.ownerScheme, borrow: f.borrowScheme, guard: f.borrowGuard, ext: f.extensionCommitment };
}

/** One PushMinimal per field, declaration order (KCC-1 section 3.4.6). */
export function encodeKcc20Full(f: Kcc20Full): Uint8Array {
  for (const [name, v] of [['ctx', f.ctx], ['owner', f.owner], ['guard', f.guard], ['ext', f.ext]] as const) {
    if (v.length !== 32) throw new SigScriptError(`KCC20Full.${name} must be 32 bytes, got ${v.length}`);
  }
  return concat(encodePushMinimal(f.ctx), pushScriptNum(f.amount), encodePushMinimal(f.owner), pushByteArgument(f.scheme), pushByteArgument(f.borrow), encodePushMinimal(f.guard), encodePushMinimal(f.ext));
}

function decodeKcc20Full(pushes: readonly ScriptPush[]): Kcc20Full {
  if (pushes.length !== KCC20_FULL_PUSHES) throw new SigScriptError(`KCC20Full takes ${KCC20_FULL_PUSHES} pushes, got ${pushes.length}`);
  const [ctx, amount, owner, scheme, borrow, guard, ext] = pushes.map((p) => p.payload) as [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  return {
    ctx: bytesN(ctx, 32, 'KCC20Full.ctx'), amount: decodeScriptNum(amount), owner: bytesN(owner, 32, 'KCC20Full.owner'),
    scheme: byteArg(scheme, 'KCC20Full.scheme'), borrow: byteArg(borrow, 'KCC20Full.borrow'), guard: bytesN(guard, 32, 'KCC20Full.guard'), ext: bytesN(ext, 32, 'KCC20Full.ext'),
  };
}

function bytesN(b: Uint8Array, n: number, what: string): Uint8Array {
  if (b.length !== n) throw new SigScriptError(`${what} must be ${n} bytes, got ${b.length}`);
  return Uint8Array.from(b);
}

function byteArg(b: Uint8Array, what: string): number {
  if (b.length !== 1) throw new SigScriptError(`${what} must be one byte, got ${b.length}`);
  return b[0]!;
}

/* -------------------------------------------------------------------------- */
/* Entrypoints                                                                 */
/* -------------------------------------------------------------------------- */

/** The three Kasseal lineages: the KCC-20 token, the bonding curve and the pool. */
export type ContractKind = 'token' | 'curve' | 'pool';

/** Declared argument types of every curve and pool entry, as compiled (`curve.sil`, `pool.sil`; the pool entries listed are the swap-only forms). */
export const ENTRY_SIGNATURES: Readonly<Record<'Curve' | 'Pool', Readonly<Record<string, readonly string[]>>>> = Object.freeze({
  Curve: Object.freeze({ init: ['byte[]', 'byte[]'], buy: ['int', KCC20_FULL_TYPE], sell: ['int'], sweep: [], graduate: ['byte[]', 'byte[]'] }),
  Pool: Object.freeze({ swapKasForTokens: ['int', KCC20_FULL_TYPE], swapTokensForKas: ['int', 'int'], sweep: [] }),
});

/**
 * The entries the open-liquidity pool adds (the v1 `pool.sil`). The three swap-only entries keep their tags; these
 * three are dispatched by the open-liquidity program only.
 */
export const POOL_V3_ENTRY_SIGNATURES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  bindLp: ['byte[]', 'byte[]'], addLiquidity: ['int', KCC20_FULL_TYPE], removeLiquidity: ['int', KCC20_FULL_TYPE],
});

/**
 * The v1 pool's bounded buy:
 * `swapKasForTokens(int kasInScaled, int minTokensOut, KCC20Full user)`, the buyer's on-chain bound on the token leg.
 * Same entry name, its own dispatch tag; earlier pool builds keep the two-argument form. An invocation carries `minTokensOut` exactly when it uses this form.
 */
export const POOL_BUY_MIN_SIGNATURE: readonly string[] = Object.freeze(['int', 'int', KCC20_FULL_TYPE]);

/**
 * The composable swaps of the `v1-kasseal-mainnet-2` pool:
 * `swapKasForTokens(int kasInScaled, int minTokensOut, int reserveK, int restK)` and
 * `swapTokensForKas(int tokensIn, int minOutScaled, int reserveK, int mergedK)`. `reserveK` is the reserve's position
 * among the token's inputs, `restK` / `mergedK` its successor's among the token's outputs; the buy names no user cell.
 * Same entry names, their own dispatch tags. An invocation carries `reserveK` exactly when it uses these forms.
 */
export const POOL_BUY_COMPOSABLE_SIGNATURE: readonly string[] = Object.freeze(['int', 'int', 'int', 'int']);
/** Argument types of the composable sell `swapTokensForKas(int tokensIn, int minOutScaled, int reserveK, int mergedK)`. */
export const POOL_SELL_COMPOSABLE_SIGNATURE: readonly string[] = Object.freeze(['int', 'int', 'int', 'int']);

/** Dispatch tag of a `#[covenant...]` declaration: BLAKE3(`__covenant_entrypoint_auth_<decl>(<types>)`)[0:4], hex. */
export function covenantDispatchTag(decl: string, argTypes: readonly string[]): string {
  return toHex(dispatchTag(`__covenant_entrypoint_auth_${decl}(${argTypes.join(',')})`));
}

/** Entry points of the reference KCC-20 token. */
export type TokenEntry = 'transfer' | 'transferDelegator';
/** Entry points of the curve covenant. */
export type CurveEntry = 'init' | 'buy' | 'sell' | 'sweep' | 'graduate';
/** Entry points of the pool covenant. */
export type PoolEntry = 'swapKasForTokens' | 'swapTokensForKas' | 'sweep' | 'bindLp' | 'addLiquidity' | 'removeLiquidity';

const tagsOf = (decls: Readonly<Record<string, readonly string[]>>): Record<string, string> =>
  Object.fromEntries(Object.entries(decls).map(([d, types]) => [d, covenantDispatchTag(d, types)]));

/**
 * Dispatch tags (hex) per contract and entry. Curve and pool `sweep()` share a tag; the contract disambiguates.
 * `pool` lists the swap-only pool's entries and the three open-liquidity additions (`bindLp e411082d`, `addLiquidity ec0aa00c`,
 * `removeLiquidity 85e9489a`, as in the pool's compiled constants).
 */
export const ENTRY_TAGS: Readonly<{ token: Readonly<Record<TokenEntry, string>>; curve: Readonly<Record<CurveEntry, string>>; pool: Readonly<Record<PoolEntry, string>> }> = Object.freeze({
  token: Object.freeze({ transfer: KCC0020_DISPATCH.transfer.tagHex, transferDelegator: KCC0020_DISPATCH.transferDelegator.tagHex }),
  curve: Object.freeze(tagsOf(ENTRY_SIGNATURES.Curve) as Record<CurveEntry, string>),
  pool: Object.freeze(tagsOf({ ...ENTRY_SIGNATURES.Pool, ...POOL_V3_ENTRY_SIGNATURES }) as Record<PoolEntry, string>),
});

/** Dispatch tag (hex) of the bounded buy `swapKasForTokens(int, int, KCC20Full)` (`5c76f792`, `POOL_BUY_MIN_SIGNATURE`). */
export const POOL_BUY_MIN_TAG: string = covenantDispatchTag('swapKasForTokens', POOL_BUY_MIN_SIGNATURE);

/** Dispatch tag (hex) of the composable buy `swapKasForTokens(int, int, int, int)` (`855ca714`). */
export const POOL_BUY_COMPOSABLE_TAG: string = covenantDispatchTag('swapKasForTokens', POOL_BUY_COMPOSABLE_SIGNATURE);
/** Dispatch tag (hex) of the composable sell `swapTokensForKas(int, int, int, int)`. */
export const POOL_SELL_COMPOSABLE_TAG: string = covenantDispatchTag('swapTokensForKas', POOL_SELL_COMPOSABLE_SIGNATURE);

/** The entries a dispatch tag names, across the three contracts (more than one only for `sweep`). */
export function entriesOfTag(tagHex: string): { contract: ContractKind; entry: string }[] {
  const out: { contract: ContractKind; entry: string }[] = [];
  for (const contract of ['token', 'curve', 'pool'] as const) {
    for (const [entry, t] of Object.entries(ENTRY_TAGS[contract])) if (t === tagHex) out.push({ contract, entry });
  }
  if (tagHex === POOL_BUY_MIN_TAG || tagHex === POOL_BUY_COMPOSABLE_TAG) out.push({ contract: 'pool', entry: 'swapKasForTokens' });
  if (tagHex === POOL_SELL_COMPOSABLE_TAG) out.push({ contract: 'pool', entry: 'swapTokensForKas' });
  return out;
}

/** A decoded token invocation. */
export type TokenInvocation =
  | { readonly contract: 'token'; readonly entry: 'transfer'; readonly nextStates: readonly TokenState[]; readonly witness: Uint8Array }
  | { readonly contract: 'token'; readonly entry: 'transferDelegator'; readonly witness: Uint8Array };

/** A decoded curve invocation; `n` is a lot count. */
export type CurveInvocation =
  | { readonly contract: 'curve'; readonly entry: 'init'; readonly tokenPrefix: Uint8Array; readonly tokenSuffix: Uint8Array }
  | { readonly contract: 'curve'; readonly entry: 'buy'; readonly n: bigint; readonly user: Kcc20Full }
  | { readonly contract: 'curve'; readonly entry: 'sell'; readonly n: bigint }
  | { readonly contract: 'curve'; readonly entry: 'sweep' }
  | { readonly contract: 'curve'; readonly entry: 'graduate'; readonly poolPrefix: Uint8Array; readonly poolSuffix: Uint8Array };

/** A decoded pool invocation; KAS amounts are scaled units of 0.01 KAS, token amounts whole tokens. */
export type PoolInvocation =
  /** `minTokensOut` present: the bounded buy (`POOL_BUY_MIN_TAG`); absent: the earlier two-argument form. */
  | { readonly contract: 'pool'; readonly entry: 'swapKasForTokens'; readonly kasInScaled: bigint; readonly minTokensOut?: bigint; readonly user: Kcc20Full; readonly reserveK?: undefined }
  /** The composable buy (`POOL_BUY_COMPOSABLE_TAG`): positions instead of a user cell. */
  | { readonly contract: 'pool'; readonly entry: 'swapKasForTokens'; readonly kasInScaled: bigint; readonly minTokensOut: bigint; readonly reserveK: bigint; readonly restK: bigint; readonly user?: undefined }
  /** `reserveK` / `mergedK` present: the composable sell (`POOL_SELL_COMPOSABLE_TAG`). */
  | { readonly contract: 'pool'; readonly entry: 'swapTokensForKas'; readonly tokensIn: bigint; readonly minOutScaled: bigint; readonly reserveK?: bigint; readonly mergedK?: bigint }
  | { readonly contract: 'pool'; readonly entry: 'sweep' }
  /** Open liquidity: the reference token template (the bytes `init` receives), so the pool validates the L genesis output. */
  | { readonly contract: 'pool'; readonly entry: 'bindLp'; readonly tokenPrefix: Uint8Array; readonly tokenSuffix: Uint8Array }
  /** Open liquidity: `shares` deposited, `lpUser` the depositor's L cell (ctx = H_T). */
  | { readonly contract: 'pool'; readonly entry: 'addLiquidity'; readonly shares: bigint; readonly lpUser: Kcc20Full }
  /** Open liquidity: `shares` withdrawn, `tokUser` the withdrawer's T cell (ctx = H_T). */
  | { readonly contract: 'pool'; readonly entry: 'removeLiquidity'; readonly shares: bigint; readonly tokUser: Kcc20Full };

/** Any decoded Kasseal invocation. */
export type Invocation = TokenInvocation | CurveInvocation | PoolInvocation;

/** Argument pushes of an invocation (`PushArguments`), without the tag and program. */
export function encodeInvocationArguments(inv: Invocation): Uint8Array {
  switch (inv.contract) {
    case 'token':
      if (inv.entry === 'transfer') return groupedTransferPushes(inv.nextStates, inv.witness);
      return encodePushMinimal(inv.witness);
    case 'curve':
      switch (inv.entry) {
        case 'init': return concat(encodePushMinimal(inv.tokenPrefix), encodePushMinimal(inv.tokenSuffix));
        case 'buy': return concat(pushScriptNum(inv.n), encodeKcc20Full(inv.user));
        case 'sell': return pushScriptNum(inv.n);
        case 'sweep': return new Uint8Array(0);
        case 'graduate': return concat(encodePushMinimal(inv.poolPrefix), encodePushMinimal(inv.poolSuffix));
      }
      break;
    case 'pool':
      switch (inv.entry) {
        case 'swapKasForTokens':
          // A buy names either its user cell (exact-count pools) or positions (composable), never both.
          if (inv.reserveK !== undefined && inv.user !== undefined) throw new SigScriptError('swapKasForTokens: a user cell and positions together');
          if (inv.reserveK !== undefined) return concat(pushScriptNum(inv.kasInScaled), pushScriptNum(inv.minTokensOut), pushScriptNum(inv.reserveK), pushScriptNum(inv.restK));
          return inv.minTokensOut === undefined
            ? concat(pushScriptNum(inv.kasInScaled), encodeKcc20Full(inv.user))
            : concat(pushScriptNum(inv.kasInScaled), pushScriptNum(inv.minTokensOut), encodeKcc20Full(inv.user));
        case 'swapTokensForKas':
          if ((inv.reserveK === undefined) !== (inv.mergedK === undefined)) throw new SigScriptError('swapTokensForKas: reserveK and mergedK come together');
          return inv.reserveK === undefined
            ? concat(pushScriptNum(inv.tokensIn), pushScriptNum(inv.minOutScaled))
            : concat(pushScriptNum(inv.tokensIn), pushScriptNum(inv.minOutScaled), pushScriptNum(inv.reserveK), pushScriptNum(inv.mergedK!));
        case 'sweep': return new Uint8Array(0);
        case 'bindLp': return concat(encodePushMinimal(inv.tokenPrefix), encodePushMinimal(inv.tokenSuffix));
        case 'addLiquidity': return concat(pushScriptNum(inv.shares), encodeKcc20Full(inv.lpUser));
        case 'removeLiquidity': return concat(pushScriptNum(inv.shares), encodeKcc20Full(inv.tokUser));
      }
  }
  throw new SigScriptError('unknown invocation');
}

function groupedTransferPushes(nextStates: readonly TokenState[], witness: Uint8Array): Uint8Array {
  const a = encodeTransferArguments(nextStates, witness);
  return concat(...a.groupedFieldPushes, a.witnessPush);
}

/** The dispatch tag (hex) of an invocation. */
export function tagOfInvocation(inv: Invocation): string {
  if (inv.contract === 'pool' && inv.entry === 'swapKasForTokens' && inv.reserveK !== undefined) return POOL_BUY_COMPOSABLE_TAG;
  if (inv.contract === 'pool' && inv.entry === 'swapKasForTokens' && inv.minTokensOut !== undefined) return POOL_BUY_MIN_TAG;
  if (inv.contract === 'pool' && inv.entry === 'swapTokensForKas' && inv.reserveK !== undefined) return POOL_SELL_COMPOSABLE_TAG;
  return (ENTRY_TAGS[inv.contract] as Record<string, string>)[inv.entry]!;
}

/** The complete sigscript `PushArguments || OP_DATA_4 tag || PushMinimal(program)`. */
export function encodeInvocation(inv: Invocation, program: Uint8Array): Uint8Array {
  if (program.length === 0) throw new SigScriptError('empty program');
  return concat(encodeInvocationArguments(inv), Uint8Array.of(0x04), fromHex(tagOfInvocation(inv)), encodePushMinimal(program));
}

/** A decoded sigscript: the invocation, its dispatch tag (hex) and the program `R`. */
export interface DecodedSigScript {
  /** The typed invocation. */
  readonly invocation: Invocation;
  /** Dispatch tag, lowercase hex. */
  readonly tag: string;
  /** The program `R`. */
  readonly program: Uint8Array;
}

/**
 * Decode a sigscript as an invocation of `contract` (or, when omitted, of the
 * unique contract whose entry the tag names; `sweep()` is ambiguous between
 * curve and pool and needs the contract, which the caller knows from the
 * program's template hash). Throws `SigScriptError` on anything malformed and
 * asserts that the result re-encodes to the input byte for byte.
 */
export function decodeInvocation(sigscript: Uint8Array, contract?: ContractKind): DecodedSigScript {
  const env = parseSigScriptEnvelope(sigscript);
  const candidates = entriesOfTag(env.tag).filter((c) => contract === undefined || c.contract === contract);
  if (candidates.length === 0) throw new SigScriptError(`dispatch tag ${env.tag} names no entry of ${contract ?? 'the token, curve or pool'}`);
  if (candidates.length > 1) throw new SigScriptError(`dispatch tag ${env.tag} is ambiguous (${candidates.map((c) => `${c.contract}.${c.entry}`).join(', ')}); name the contract`);
  const { contract: kind, entry } = candidates[0]!;
  const args = env.argumentPushes;
  const arity = (n: number): void => {
    if (args.length !== n) throw new SigScriptError(`${kind}.${entry} takes ${n} argument push(es), got ${args.length}`);
  };
  let invocation: Invocation;
  try {
    invocation = decodeArguments(kind, entry, args, arity, env.tag);
  } catch (e) {
    if (e instanceof SigScriptError) throw e;
    throw new SigScriptError(`${kind}.${entry}: ${(e as Error).message}`);
  }
  let reencoded: Uint8Array;
  try {
    reencoded = encodeInvocation(invocation, env.program);
  } catch (e) {
    throw new SigScriptError(`${kind}.${entry}: decoded arguments do not re-encode: ${(e as Error).message}`);
  }
  if (!bytesEqual(reencoded, sigscript)) throw new SigScriptError(`${kind}.${entry}: sigscript is not the canonical encoding of its arguments`);
  return { invocation, tag: env.tag, program: Uint8Array.from(env.program) };
}

function decodeArguments(kind: ContractKind, entry: string, args: readonly ScriptPush[], arity: (n: number) => void, tag: string): Invocation {
  const p = (i: number): Uint8Array => args[i]!.payload;
  if (kind === 'token') {
    if (entry === 'transfer') {
      arity(7);
      return { contract: 'token', entry: 'transfer', nextStates: decodeGroupedStates(args.slice(0, 6).map((a) => a.payload)), witness: Uint8Array.from(p(6)) };
    }
    arity(1);
    return { contract: 'token', entry: 'transferDelegator', witness: Uint8Array.from(p(0)) };
  }
  if (kind === 'curve') {
    switch (entry as CurveEntry) {
      case 'init':
        arity(2);
        return { contract: 'curve', entry: 'init', tokenPrefix: Uint8Array.from(p(0)), tokenSuffix: Uint8Array.from(p(1)) };
      case 'buy':
        arity(1 + KCC20_FULL_PUSHES);
        return { contract: 'curve', entry: 'buy', n: decodeScriptNum(p(0)), user: decodeKcc20Full(args.slice(1)) };
      case 'sell':
        arity(1);
        return { contract: 'curve', entry: 'sell', n: decodeScriptNum(p(0)) };
      case 'sweep':
        arity(0);
        return { contract: 'curve', entry: 'sweep' };
      case 'graduate':
        arity(2);
        return { contract: 'curve', entry: 'graduate', poolPrefix: Uint8Array.from(p(0)), poolSuffix: Uint8Array.from(p(1)) };
    }
  }
  switch (entry as PoolEntry) {
    case 'swapKasForTokens':
      if (tag === POOL_BUY_COMPOSABLE_TAG) {
        arity(4);
        return { contract: 'pool', entry: 'swapKasForTokens', kasInScaled: decodeScriptNum(p(0)), minTokensOut: decodeScriptNum(p(1)), reserveK: decodeScriptNum(p(2)), restK: decodeScriptNum(p(3)) };
      }
      if (tag === POOL_BUY_MIN_TAG) {
        arity(2 + KCC20_FULL_PUSHES);
        return { contract: 'pool', entry: 'swapKasForTokens', kasInScaled: decodeScriptNum(p(0)), minTokensOut: decodeScriptNum(p(1)), user: decodeKcc20Full(args.slice(2)) };
      }
      arity(1 + KCC20_FULL_PUSHES);
      return { contract: 'pool', entry: 'swapKasForTokens', kasInScaled: decodeScriptNum(p(0)), user: decodeKcc20Full(args.slice(1)) };
    case 'swapTokensForKas':
      if (tag === POOL_SELL_COMPOSABLE_TAG) {
        arity(4);
        return { contract: 'pool', entry: 'swapTokensForKas', tokensIn: decodeScriptNum(p(0)), minOutScaled: decodeScriptNum(p(1)), reserveK: decodeScriptNum(p(2)), mergedK: decodeScriptNum(p(3)) };
      }
      arity(2);
      return { contract: 'pool', entry: 'swapTokensForKas', tokensIn: decodeScriptNum(p(0)), minOutScaled: decodeScriptNum(p(1)) };
    case 'sweep':
      arity(0);
      return { contract: 'pool', entry: 'sweep' };
    case 'bindLp':
      arity(2);
      return { contract: 'pool', entry: 'bindLp', tokenPrefix: Uint8Array.from(p(0)), tokenSuffix: Uint8Array.from(p(1)) };
    case 'addLiquidity':
      arity(1 + KCC20_FULL_PUSHES);
      return { contract: 'pool', entry: 'addLiquidity', shares: decodeScriptNum(p(0)), lpUser: decodeKcc20Full(args.slice(1)) };
    case 'removeLiquidity':
      arity(1 + KCC20_FULL_PUSHES);
      return { contract: 'pool', entry: 'removeLiquidity', shares: decodeScriptNum(p(0)), tokUser: decodeKcc20Full(args.slice(1)) };
  }
  throw new SigScriptError(`no decoder for ${kind}.${entry}`);
}

/** The six grouped field pushes of `next_states` back into states (KCC-1 section 3.4.6). */
function decodeGroupedStates(groups: readonly Uint8Array[]): TokenState[] {
  const [amounts, owners, schemes, borrows, guards, exts] = groups as [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  if (amounts.length % INT_STATE_WIDTH !== 0) throw new SigScriptError(`next_states.amount group is ${amounts.length} bytes, not a multiple of ${INT_STATE_WIDTH}`);
  const k = amounts.length / INT_STATE_WIDTH;
  if (k > MAX_TOKEN_OUTPUTS) throw new SigScriptError(`${k} next_states exceed max_token_outputs ${MAX_TOKEN_OUTPUTS}`);
  const widths: [string, Uint8Array, number][] = [['owner', owners, 32], ['owner_scheme', schemes, 1], ['borrow_scheme', borrows, 1], ['borrow_guard', guards, 32], ['extension_commitment', exts, 32]];
  for (const [name, g, w] of widths) if (g.length !== k * w) throw new SigScriptError(`next_states.${name} group is ${g.length} bytes, expected ${k} x ${w}`);
  const states: TokenState[] = [];
  for (let i = 0; i < k; i++) {
    states.push(makeKcc0020State({
      amount: decodeIntState(amounts.subarray(i * 8, i * 8 + 8)),
      owner: owners.subarray(i * 32, i * 32 + 32),
      ownerScheme: schemes[i]!,
      borrowScheme: borrows[i]!,
      borrowGuard: guards.subarray(i * 32, i * 32 + 32),
      extensionCommitment: exts.subarray(i * 32, i * 32 + 32),
    }));
  }
  return states;
}

/* -------------------------------------------------------------------------- */
/* Signature slots                                                             */
/* -------------------------------------------------------------------------- */

/** Length of a Schnorr signature with its sighash-type byte (`sig64 || hashtype`). */
export const SIG65_LENGTH = 65;

/**
 * Offset of the 65-byte signature inside a token sigscript whose witness
 * carries one: a leader's `00 || sig65` (after the witness push opcode `42`
 * and the path byte; 113 for a one-record leader) or a delegator's `sig65`
 * (offset 1). Undefined when the witness carries no signature.
 */
export function tokenSignatureOffset(sigscript: Uint8Array): number | undefined {
  const { invocation } = decodeInvocation(sigscript, 'token');
  if (invocation.contract !== 'token') throw new SigScriptError('not a token sigscript');
  const pushes = parseSigScriptPushes(sigscript);
  if (invocation.entry === 'transfer') {
    if (invocation.witness.length !== 1 + SIG65_LENGTH || invocation.witness[0] !== 0x00) return undefined;
    return pushes[6]!.dataOffset + 1;
  }
  return invocation.witness.length === SIG65_LENGTH ? pushes[0]!.dataOffset : undefined;
}
