/**
 * KCC-1 signature scripts for every entrypoint of the three contracts.
 *
 * Envelope (KCC-1 section 3.6): `PushArguments || OP_DATA_4 tag || PushMinimal(R)`.
 * Arguments use PushMinimal (section 3.4.2); an `int` argument is a minimal
 * ScriptNum (rusty-kaspa `ScriptBuilder::add_i64`); a `byte` is a one-byte
 * push (so `0x04` is `OP_4` and `0x00` is `OP_DATA_1 00`); a record argument
 * is one push per field in declaration order (section 3.4.6), while the
 * reference token's `next_states` array of records is grouped per field, which
 * `@kasseal/codec` `encodeTransferArguments` produces. Layouts were accepted
 * on testnet-10 byte for byte.
 *
 * Signature slots: a user-signed token leader carries `00 || sig65` as its
 * witness push, a signed delegator carries `sig65`. The builder emits the
 * sigscript with a zero-filled slot and records its offset, so the signature
 * (computed over the v1 sighash, which excludes sigscripts) is spliced in
 * afterwards, either from a local key or from a wallet's P2PK-style
 * `41 || sig64 || 01` response (the Kaspire B1 path: offset 113 for a
 * one-record leader).
 *
 * The argument encodings themselves live in `@kasseal/codec` (`program.ts`:
 * `encodeInvocation`, `encodeKcc20Full`, `encodeScriptNum`), next to their
 * decoding counterpart `decodeInvocation`; this module adds the builder's
 * checks (positive amounts, template lengths, artifact tags) and the slots.
 */

import { hasOpenLiquidity } from './artifacts.ts';
import {
  KCC0020_DISPATCH, POOL_BUY_COMPOSABLE_TAG, POOL_BUY_MIN_TAG, POOL_SELL_COMPOSABLE_TAG, concat, covenantDispatchTag, encodeInvocation, encodeKcc20Full, encodePushMinimal, encodeScriptNum, encodeTransferArguments, fromHex, parseSigScriptPushes,
  pushByteArgument, pushScriptNum, toHex, type Kcc20Full, type TokenState,
} from '@kasseal/codec';
import { POOL_V3_ENTRY_SIGNATURES, type CurveTemplate, type PoolTemplate, type TokenTemplate } from './program.ts';

export {
  SigScriptError, decodeInvocation, dispatchTagOfSigScript, encodeInvocation, kcc20Full, parseSigScriptEnvelope, programFromSigScript, tokenSignatureOffset,
  type ContractKind, type DecodedSigScript, type Invocation, type Kcc20Full,
} from '@kasseal/codec';

/** Length of a signature slot: a 64-byte Schnorr signature plus the sighash type byte. */
export const SCHNORR_SIG_LENGTH = 65;
/** A zero-filled signature slot of a P2PK-style signature (`sig64 || hashtype`). */
export const ZERO_SIG65: Uint8Array = new Uint8Array(SCHNORR_SIG_LENGTH);
/** The token witness path byte of a normal (non-borrowed) transfer. */
export const WITNESS_PATH_NORMAL = 0x00;

/** Minimal ScriptNum encoding of a KCC-1 `int` argument (`ScriptBuilder::add_i64`); `@kasseal/codec` `encodeScriptNum`. */
export const scriptNum = encodeScriptNum;
/** KCC-1 PushMinimal of a byte string. */
export const pushMinimal = encodePushMinimal;
/** Push of an `int` argument (minimal ScriptNum). */
export const pushInt = pushScriptNum;
/** Push of a `byte` argument. */
export const pushByte = pushByteArgument;
const tagPush = (tagHex: string): Uint8Array => concat(Uint8Array.of(0x04), fromHex(tagHex));

/** One PushMinimal per `KCC20Full` field, declaration order (KCC-1 section 3.4.6); `@kasseal/codec` `encodeKcc20Full`. */
export const pushKcc20Full: (f: Kcc20Full) => Uint8Array = encodeKcc20Full;

/* -------------------------------------------------------------------------- */
/* Token (reference KCC20)                                                     */
/* -------------------------------------------------------------------------- */

/** A token sigscript with the offset of its signature slot. */
export interface LeaderSigScript {
  /** The sigscript bytes (with a zero-filled slot when signed). */
  readonly bytes: Uint8Array;
  /** Offset of the 65-byte signature slot inside `bytes`, when the witness carries one. */
  readonly signatureOffset: number | undefined;
}

/**
 * `transfer(next_states, witness)` leader sigscript. `witness` is the complete
 * witness (path byte first). With `signed`, the witness is `00 || ZERO_SIG65`
 * and `signatureOffset` points at the slot.
 */
export function tokenLeaderSigScript(program: Uint8Array, nextStates: readonly TokenState[], witness: Uint8Array): LeaderSigScript {
  const args = encodeTransferArguments(nextStates, witness);
  const bytes = concat(args.bytes, pushMinimal(program));
  let signatureOffset: number | undefined;
  if (witness.length === 1 + SCHNORR_SIG_LENGTH && witness[0] === WITNESS_PATH_NORMAL) {
    // grouped pushes || push opcode (0x42 for 66 bytes) || path byte || sig65
    const grouped = args.groupedFieldPushes.reduce((n, p) => n + p.length, 0);
    signatureOffset = grouped + 1 + 1;
    if (toHex(bytes.subarray(signatureOffset - 2, signatureOffset)) !== '4200') throw new Error('leader witness slot not where expected');
  }
  return { bytes, signatureOffset };
}

/** Leader sigscript for a cell the user signs: witness `00 || sig65` with a zero slot. */
export function tokenLeaderSignedSigScript(program: Uint8Array, nextStates: readonly TokenState[]): LeaderSigScript {
  return tokenLeaderSigScript(program, nextStates, concat(Uint8Array.of(WITNESS_PATH_NORMAL), ZERO_SIG65));
}

/** Leader sigscript for a covenant-owned cell: witness `00`, no signature (authorised by the owning covenant's presence). */
export function tokenLeaderCovenantSigScript(program: Uint8Array, nextStates: readonly TokenState[]): LeaderSigScript {
  return tokenLeaderSigScript(program, nextStates, Uint8Array.of(WITNESS_PATH_NORMAL));
}

/** `transfer_delegator(witness)`: `PushMinimal(witness) || OP_DATA_4 fd3ef14a || PushMinimal(R)`. */
export function tokenDelegatorSigScript(program: Uint8Array, witness: Uint8Array): LeaderSigScript {
  const bytes = concat(pushMinimal(witness), tagPush(KCC0020_DISPATCH.transferDelegator.tagHex), pushMinimal(program));
  return { bytes, signatureOffset: witness.length === SCHNORR_SIG_LENGTH ? 1 : undefined };
}

/** Delegator sigscript for a covenant-owned cell: empty witness. */
export function tokenDelegatorCovenantSigScript(program: Uint8Array): LeaderSigScript {
  return tokenDelegatorSigScript(program, new Uint8Array(0));
}

/** Delegator sigscript the user signs: witness `sig65` with a zero slot. */
export function tokenDelegatorSignedSigScript(program: Uint8Array): LeaderSigScript {
  return tokenDelegatorSigScript(program, ZERO_SIG65);
}

/* -------------------------------------------------------------------------- */
/* Curve                                                                       */
/* -------------------------------------------------------------------------- */

/** Curve `init(tokenPrefix, tokenSuffix)` sigscript; refuses template lengths other than the curve's constants. */
export function curveInitSigScript(curve: CurveTemplate, program: Uint8Array, tokenPrefix: Uint8Array, tokenSuffix: Uint8Array): Uint8Array {
  if (tokenPrefix.length !== curve.params.tokenPrefixLen || tokenSuffix.length !== curve.params.tokenSuffixLen) throw new Error('init: token template lengths do not match the curve constants');
  return withTemplateTag(curve, 'init', encodeInvocation({ contract: 'curve', entry: 'init', tokenPrefix, tokenSuffix }, program));
}

/** Curve `buy(n, user)` sigscript; `n` lots, positive. */
export function curveBuySigScript(curve: CurveTemplate, program: Uint8Array, n: bigint, user: Kcc20Full): Uint8Array {
  if (n <= 0n) throw new Error('buy: n must be positive');
  return withTemplateTag(curve, 'buy', encodeInvocation({ contract: 'curve', entry: 'buy', n, user }, program));
}

/** Curve `sell(n)` sigscript; `n` lots, positive. */
export function curveSellSigScript(curve: CurveTemplate, program: Uint8Array, n: bigint): Uint8Array {
  if (n <= 0n) throw new Error('sell: n must be positive');
  return withTemplateTag(curve, 'sell', encodeInvocation({ contract: 'curve', entry: 'sell', n }, program));
}

/** Curve `sweep()` sigscript. */
export function curveSweepSigScript(curve: CurveTemplate, program: Uint8Array): Uint8Array {
  return withTemplateTag(curve, 'sweep', encodeInvocation({ contract: 'curve', entry: 'sweep' }, program));
}

/** Curve `graduate(poolPrefix, poolSuffix)` sigscript for the given pool template. */
export function curveGraduateSigScript(curve: CurveTemplate, program: Uint8Array, pool: PoolTemplate): Uint8Array {
  return withTemplateTag(curve, 'graduate', encodeInvocation({ contract: 'curve', entry: 'graduate', poolPrefix: pool.prefix, poolSuffix: pool.suffix }, program));
}

/* -------------------------------------------------------------------------- */
/* Pool                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `swapKasForTokens`: `(kasInScaled, minTokensOut, user)` on a pool whose buy carries the on-chain bound (the v1 pool,
 * tag `POOL_BUY_MIN_TAG`), `(kasInScaled, user)` on a pool template without it (whose bound stays a builder
 * pre-check). Which form is the template's own tag's; a bounded template without `minTokensOut` is refused.
 */
export function poolSwapKasForTokensSigScript(pool: PoolTemplate, program: Uint8Array, kasInScaled: bigint, user: Kcc20Full, minTokensOut?: bigint, positions: { reserveK: bigint; restK: bigint } = APP_BUY_POSITIONS): Uint8Array {
  if (kasInScaled <= 0n) throw new Error('swapKasForTokens: kasInScaled must be positive');
  if (pool.tags['swapKasForTokens'] === POOL_BUY_COMPOSABLE_TAG) {
    // Composable pool: the buy names the reserve's position and its successor's, not the user cell (the builder still
    // writes and checks the user cell itself, as the transfer's second output).
    if (minTokensOut === undefined) throw new Error('swapKasForTokens: this pool takes an on-chain minTokensOut');
    return withTemplateTag(pool, 'swapKasForTokens', encodeInvocation({ contract: 'pool', entry: 'swapKasForTokens', kasInScaled, minTokensOut, ...positions }, program));
  }
  const bounded = pool.tags['swapKasForTokens'] === POOL_BUY_MIN_TAG;
  if (bounded && minTokensOut === undefined) throw new Error('swapKasForTokens: this pool takes an on-chain minTokensOut');
  const inv = bounded ? { contract: 'pool' as const, entry: 'swapKasForTokens' as const, kasInScaled, minTokensOut: minTokensOut!, user } : { contract: 'pool' as const, entry: 'swapKasForTokens' as const, kasInScaled, user };
  return withTemplateTag(pool, 'swapKasForTokens', encodeInvocation(inv, program));
}

/** Pool `swapTokensForKas(tokensIn, minOutScaled[, reserveK, mergedK])` sigscript; positions only on a composable pool. */
export function poolSwapTokensForKasSigScript(pool: PoolTemplate, program: Uint8Array, tokensIn: bigint, minOutScaled: bigint, positions: { reserveK: bigint; mergedK: bigint } = APP_SELL_POSITIONS): Uint8Array {
  if (tokensIn <= 0n) throw new Error('swapTokensForKas: tokensIn must be positive');
  if (minOutScaled < 0n) throw new Error('swapTokensForKas: minOutScaled must be non-negative');
  const composable = pool.tags['swapTokensForKas'] === POOL_SELL_COMPOSABLE_TAG;
  return withTemplateTag(pool, 'swapTokensForKas', encodeInvocation({ contract: 'pool', entry: 'swapTokensForKas', tokensIn, minOutScaled, ...(composable ? positions : {}) }, program));
}

/**
 * The positions the app's own swap shapes use on a composable pool (shapes/swap.ts): a buy's reserve is the only token
 * input and its successor the first token output; a sell's reserve is the delegator after the seller's leader and the
 * merged reserve the only token output.
 */
export const APP_BUY_POSITIONS = Object.freeze({ reserveK: 0n, restK: 0n });
/** The sell positions the swap shapes use on a composable pool (see `APP_BUY_POSITIONS`). */
export const APP_SELL_POSITIONS = Object.freeze({ reserveK: 1n, mergedK: 0n });

/** Pool `sweep()` sigscript. */
export function poolSweepSigScript(pool: PoolTemplate, program: Uint8Array): Uint8Array {
  return withTemplateTag(pool, 'sweep', encodeInvocation({ contract: 'pool', entry: 'sweep' }, program));
}

/**
 * Pool `bindLp(tokenPrefix, tokenSuffix)`: the reference token template parts (1 B and 3,885 B, the bytes the curve's
 * `init` receives) so the pool validates the L genesis cell, then the tag and the program.
 * The tag is derived from the declared signature and asserted against the artifact's.
 */
export function poolBindLpSigScript(pool: PoolTemplate, program: Uint8Array, token: TokenTemplate): Uint8Array {
  if (!hasOpenLiquidity(pool.version)) throw new Error(`bindLp: the ${pool.version} pool has no bindLp entry`);
  if (token.prefix.length !== 1 || token.suffix.length !== 3885) throw new Error('bindLp: token template lengths are not 1 / 3885');
  const tag = covenantDispatchTag('bindLp', POOL_V3_ENTRY_SIGNATURES['bindLp']!);
  const sigscript = concat(pushMinimal(token.prefix), pushMinimal(token.suffix), tagPush(tag), pushMinimal(program));
  return withTemplateTag(pool, 'bindLp', sigscript);
}

/**
 * Pool `addLiquidity(int shares, KCC20Full lpUser)` (tag `ec0aa00c`): the share count the depositor names and the
 * exact state of the user's new L cell, which the pool validates byte for byte at L cov-out 1
 * `PushMinimal(shares) || 7 pushes of lpUser || OP_DATA_4 tag || PushMinimal(R)`.
 */
export function poolAddLiquiditySigScript(pool: PoolTemplate, program: Uint8Array, shares: bigint, lpUser: Kcc20Full): Uint8Array {
  return poolLiquiditySigScript(pool, program, 'addLiquidity', shares, lpUser);
}

/**
 * Pool `removeLiquidity(int shares, KCC20Full tokUser)` (tag `85e9489a`): the shares redeemed (the user's L cell is
 * absorbed whole) and the exact state of the user's token leg at T cov-out 1.
 */
export function poolRemoveLiquiditySigScript(pool: PoolTemplate, program: Uint8Array, shares: bigint, tokUser: Kcc20Full): Uint8Array {
  return poolLiquiditySigScript(pool, program, 'removeLiquidity', shares, tokUser);
}

function poolLiquiditySigScript(pool: PoolTemplate, program: Uint8Array, entry: 'addLiquidity' | 'removeLiquidity', shares: bigint, cell: Kcc20Full): Uint8Array {
  if (!hasOpenLiquidity(pool.version)) throw new Error(`${entry}: the ${pool.version} pool has no ${entry} entry`);
  if (shares <= 0n) throw new Error(`${entry}: shares must be positive`);
  const tag = covenantDispatchTag(entry, POOL_V3_ENTRY_SIGNATURES[entry]!);
  return withTemplateTag(pool, entry, concat(pushInt(shares), pushKcc20Full(cell), tagPush(tag), pushMinimal(program)));
}

/** Asserts that the artifact's tag for `entry` is the one the codec encoded (the tag sits 4 bytes before the program push). */
function withTemplateTag(t: CurveTemplate | PoolTemplate, entry: string, sigscript: Uint8Array): Uint8Array {
  const pushes = parseSigScriptPushes(sigscript);
  const tag = toHex(pushes[pushes.length - 2]!.payload);
  if (t.tags[entry] !== tag) throw new Error(`${t.name}.${entry}: artifact tag ${t.tags[entry]} != encoded tag ${tag}`);
  return sigscript;
}

/* -------------------------------------------------------------------------- */
/* Recovery and splicing                                                       */
/* -------------------------------------------------------------------------- */

/** Every push payload of a push-only script, in order; throws on a non-push opcode or a non-minimal push (`@kasseal/codec` `parseSigScriptPushes`). */
export function parsePushes(script: Uint8Array): Uint8Array[] {
  return parseSigScriptPushes(script).map((p) => p.payload);
}

/** Overwrite the 65-byte slot at `offset` with `sig65` (`sig64 || hashtype`). Returns a new array. */
export function spliceSignature(sigscript: Uint8Array, offset: number, sig65: Uint8Array): Uint8Array {
  if (sig65.length !== SCHNORR_SIG_LENGTH) throw new Error(`signature must be ${SCHNORR_SIG_LENGTH} bytes, got ${sig65.length}`);
  if (offset < 0 || offset + SCHNORR_SIG_LENGTH > sigscript.length) throw new Error('signature slot outside the sigscript');
  const out = Uint8Array.from(sigscript);
  out.set(sig65, offset);
  return out;
}

/**
 * Strip the push opcode of a P2PK sigscript (`41 || sig64 || hashtype`, what the SDK's `createInputSignature` and
 * Kaspire return; bytes or hex) to the 65-byte signature. The lint rule admits `createInputSignature` only as the
 * direct argument of this function, so its push-wrapped output never becomes a witness.
 */
export function signatureFromP2pkSigScript(sigscript: Uint8Array | string): Uint8Array {
  const p2pkSigScript = typeof sigscript === 'string' ? fromHex(sigscript) : sigscript;
  if (p2pkSigScript.length !== 66 || p2pkSigScript[0] !== 0x41) throw new Error(`unexpected P2PK sigscript layout: ${toHex(p2pkSigScript.subarray(0, 2))} length ${p2pkSigScript.length}`);
  return p2pkSigScript.subarray(1);
}

/** A P2PK sigscript with a zero signature slot (66 bytes); the slot is at offset 1. */
export const P2PK_PLACEHOLDER_SIGSCRIPT: Uint8Array = concat(Uint8Array.of(0x41), ZERO_SIG65);
