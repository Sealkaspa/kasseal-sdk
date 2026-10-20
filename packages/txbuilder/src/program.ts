/**
 * Programs (redeem scripts `R`) and states of the three lineages.
 *
 *   T  token  unmodified Argent reference KCC20, 4,031 B, state 112 B at offset 34
 *             (33-byte template context `20 || H_T` precedes it); encoded and
 *             decoded by the `kcc0020-112` codec through its registry.
 *   C  curve  the v1 `curve.sil` compiled per preset (bundled artifacts),
 *             state 53 B at offset 1: tokenCovId byte[32] | lotsSold int |
 *             feeAccrued int | phase byte.
 *   P  pool   the v1 `pool.sil` (bundled artifacts), state at offset 1:
 *             tokenCovId | kasScaled | tokenReserve | lpShares | lpCovId byte[32] |
 *             feeAccruedScaled | creatorSpk (139 B), lpCovId the LP-share lineage L
 *             (`0^32` while unbound).
 *
 * One contract set is loaded (`artifacts.ts`): v1, every launch (50/50 fee
 * split; graduation writes the creator into the pool state, whose sweep pays
 * it half; `bindLp` / `addLiquidity` / `removeLiquidity`), with its frozen
 * revisions. Every template carries its `version`.
 *
 * A program is `prefix || EncodeState(state) || suffix` (KCC-1 section 3.7.1:
 * one PushExplicit per field); its template hash `TemplateHash(prefix, suffix)`
 * is recomputed on every build and compared with the artifact's, and every
 * decode re-encodes and requires byte equality (the codec's rule). The
 * artifacts are read as shipped, through the installed artifact source
 * (`artifacts.ts`: the file system in Node, a bundled map in the browser);
 * nothing here compiles anything.
 *
 * Constructor constants come from `curve.ctor.<preset>.json`; the file's
 * sha256 is kept with the template so a proof can name the exact constants.
 */

import {
  LayoutRegistry, KCC20_FULL_TYPE as KCC20_FULL_TYPE_NAME, REFERENCE_KCC0020_TEMPLATE, REFERENCE_KCC0020_TEMPLATE_HASH, bytesEqual, concat, createDefaultRegistry,
  covenantDispatchTag, ENTRY_SIGNATURES, POOL_BUY_COMPOSABLE_SIGNATURE, POOL_BUY_COMPOSABLE_TAG, POOL_BUY_MIN_SIGNATURE, POOL_BUY_MIN_TAG,
  POOL_SELL_COMPOSABLE_SIGNATURE, POOL_SELL_COMPOSABLE_TAG, encodePushExplicit, fromHex, kcc0020Fields, kcc0020_112, makeKcc0020State,
  templateHash, templateHashOfProgram, toHex, type TemplateDescriptor, type TokenState,
  CURVE_STATE_LENGTH, OWNER_SCHEME_COVENANT_ID, OWNER_SCHEME_P2PK_SCHNORR, PHASE_ACTIVE, PHASE_UNINIT, POOL_LP_SHARES,
  POOL_STATE_LENGTH_V3, SPK36_LENGTH, StateCodecError, ZERO32, decodeCurveState, decodePoolState, encodeCurveState, encodePoolState,
  isP2pkSpk36, isPoolBound, poolStateLayoutOf, poolStateLength, poolStateSet, type CurveState, type PoolCellState,
} from '@kasseal/codec';
import {
  DEFAULT_CONTRACT_SET, TOKEN_REFERENCE, artifactSource, builderContractSet, curveArtifactPath, curveCtorPath, poolArtifactPath, poolCtorPath,
  readArtifactJson, type BuilderContractSet, type ContractSet, type PoolTemplateSet,
  hasOpenLiquidity,
} from './artifacts.ts';
import { p2shScript } from './blake2b.ts';
import { required } from './required.ts';
import { sha256Hex } from './sha256.ts';

/** KCC-20 borrow scheme byte: borrowing disabled. */
export const BORROW_SCHEME_DISABLED = 0x00;
/** Sompi per scaled pool KAS unit (0.01 KAS). */
export const POOL_KAS_SCALE = 1_000_000n;
/** The `lpCovId` of a pool nobody has bound yet (from graduation until `bindLp`). */
export const POOL_UNBOUND_LP_COV_ID: Uint8Array = ZERO32;
/** The open-liquidity pool entries beyond the three every pool has, with their declared argument types (the v1 `pool.sil`). */
export const POOL_V3_ENTRY_SIGNATURES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  bindLp: ['byte[]', 'byte[]'],
  addLiquidity: ['int', KCC20_FULL_TYPE_NAME],
  removeLiquidity: ['int', KCC20_FULL_TYPE_NAME],
});

/* -------------------------------------------------------------------------- */
/* Artifacts                                                                   */
/* -------------------------------------------------------------------------- */

interface SilverscriptArtifact {
  readonly contracts: Record<string, {
    readonly compiled: { readonly bytecode: number[]; readonly state_span: { readonly offset: number; readonly len: number }; readonly template_hash: number[] };
    readonly entries: Record<string, { readonly dispatch_tag: string }>;
  }>;
}

type CtorValue = { readonly kind: 'int'; readonly value: number } | { readonly kind: 'byte'; readonly value: number } | { readonly kind: 'bytes'; readonly value: number[] };

/** A compiled covenant template: the bytes outside the state window and their hash. */
export interface Template {
  readonly name: 'Curve' | 'Pool';
  /** The contract set the artifact belongs to. */
  readonly version: PoolTemplateSet;
  /** Program bytes before the state window. */
  readonly prefix: Uint8Array;
  /** Program bytes after the state window. */
  readonly suffix: Uint8Array;
  /** Byte offset of the state window. */
  readonly stateOffset: number;
  /** Length of the state window, in bytes. */
  readonly stateLength: number;
  /** TemplateHash(prefix, suffix), lowercase hex; equals the artifact's `template_hash`. */
  readonly templateHash: string;
  /** Dispatch tags per entry name (`init`, `buy`, ...), lowercase hex, from the artifact. */
  readonly tags: Readonly<Record<string, string>>;
  /** The whole compiled bytecode (prefix || constructor state || suffix). */
  readonly bytecode: Uint8Array;
  /** Artifact path within the artifact source (`artifacts.ts`). */
  readonly artifactPath: string;
  /** A frozen revision's directory name (`V1_FROZEN_REVISIONS`); absent for the current build of the set. */
  readonly revision?: string;
}

/** The curve's constructor constants (`curve.sil` parameters), as deployed in a preset. */
export interface CurveParams {
  /** Price of lot 0, sompi. */
  readonly p0: bigint;
  /** Price increment per lot, sompi. */
  readonly k: bigint;
  /** Tokens per lot. */
  readonly lot: bigint;
  /** Lots sold on the curve. */
  readonly curveLots: bigint;
  /** Tokens handed to the pool at graduation. */
  readonly gradReserve: bigint;
  /** Curve fee, basis points of the trade cost. */
  readonly feeBps: bigint;
  /**
   * The treasury as `OpTxOutputSpk` returns it: `version(2, big-endian) || P2PK script(34)`, or a 37-byte
   * `version(2) || P2SH script(35)`.
   */
  readonly treasurySpk?: Uint8Array;
  /** The creator's `version(2) || P2PK script(34)`. */
  readonly creatorSpk: Uint8Array;
  /** The reference token template hash, hex. */
  readonly tokenH: string;
  /** Length of the token template prefix, bytes. */
  readonly tokenPrefixLen: number;
  /** Length of the token template suffix, bytes. */
  readonly tokenSuffixLen: number;
  /** The pool template hash graduation must use, hex. */
  readonly poolH: string;
  /** Minimum KAS value of a curve-owned token cell, sompi. */
  readonly tokenCellKas: bigint;
  /** Opening window length in lots (0: no window). */
  readonly openWindowLots: bigint;
  /** Per-buy cap inside the opening window, lots. */
  readonly openWindowMaxLots: bigint;
}

/** A compiled curve template with its preset's constructor constants. */
export interface CurveTemplate extends Template {
  readonly name: 'Curve';
  readonly version: BuilderContractSet;
  /** Preset name, e.g. `standard`. */
  readonly preset: string;
  /** The constructor constants. */
  readonly params: CurveParams;
  /** Constructor file path within the artifact source. */
  readonly ctorPath: string;
  /** SHA-256 of the constructor file's bytes. */
  readonly ctorSha256: string;
}

/** A compiled pool template. */
export interface PoolTemplate extends Template {
  readonly name: 'Pool';
  /** The reference token template hash, hex. */
  readonly tokenH: string;
  /** The treasury script the pool's sweep pays. */
  readonly treasurySpk?: Uint8Array;
}

/** `version(2) || P2SH script(35)`: `0000 aa 20 <32-byte hash> 87`, the 37-byte form of a P2SH script public key. */
export function isP2shSpk37(spk: Uint8Array): boolean {
  return spk.length === 37 && spk[0] === 0 && spk[1] === 0 && spk[2] === 0xaa && spk[3] === 0x20 && spk[36] === 0x87;
}

/** The reference token program parts: 33-byte context prefix window handled by the codec, suffix 3,885 B. */
export interface TokenTemplate {
  readonly templateHash: string;
  /** `6b` (1 B): the KCC-1 prefix of the state window the template hash is cut on. */
  readonly prefix: Uint8Array;
  /** 3,885 B after the 145-byte runtime state. */
  readonly suffix: Uint8Array;
  readonly bytecode: Uint8Array;
}

function templateFromArtifact(name: 'Curve' | 'Pool', path: string, version: PoolTemplateSet): Template {
  const artifact = readArtifactJson<SilverscriptArtifact>(path);
  const contract = artifact.contracts[name];
  if (!contract) throw new Error(`${path}: no contract ${name}`);
  const bytecode = Uint8Array.from(contract.compiled.bytecode);
  const { offset, len } = contract.compiled.state_span;
  const prefix = bytecode.subarray(0, offset);
  const suffix = bytecode.subarray(offset + len);
  const hash = templateHash(prefix, suffix);
  const declared = toHex(Uint8Array.from(contract.compiled.template_hash));
  if (hash !== declared) throw new Error(`${path}: recomputed template hash ${hash} != artifact ${declared}`);
  const tags: Record<string, string> = {};
  for (const [entry, e] of Object.entries(contract.entries)) tags[entry.replace('__covenant_entrypoint_auth_', '')] = e.dispatch_tag.toLowerCase();
  return { name, version, prefix, suffix, stateOffset: offset, stateLength: len, templateHash: hash, tags, bytecode, artifactPath: path };
}

function ctorInt(v: CtorValue, i: number): bigint {
  if (v.kind !== 'int') throw new Error(`ctor[${i}] is ${v.kind}, expected int`);
  return BigInt(v.value);
}
function ctorBytes(v: CtorValue, i: number, len: number): Uint8Array {
  if (v.kind !== 'bytes' || v.value.length !== len) throw new Error(`ctor[${i}] is not byte[${len}]`);
  return Uint8Array.from(v.value);
}

/**
 * Load a committed curve preset: artifact + constructor constants. The set is
 * the given pool's (default: v1); `poolH` is asserted against that pool.
 *
 * Constructor layout: 19 values with `treasurySpk` at 10 and `creatorSpk` at 11.
 */
export function loadCurveTemplate(preset: string, pool: PoolTemplate = loadPoolTemplate()): CurveTemplate {
  const version: BuilderContractSet = pool.version;
  // A frozen revision's curve sits beside its pool's revision (the poolH check below ties the two).
  const revision = pool.revision;
  const ctorPath = curveCtorPath(preset, version, revision);
  const base = { ...templateFromArtifact('Curve', curveArtifactPath(preset, version, revision), version), ...(revision === undefined ? {} : { revision }) };
  const ctorText = artifactSource().readText(ctorPath);
  const c = JSON.parse(ctorText) as CtorValue[];
  const expected = 19;
  if (c.length !== expected) throw new Error(`${ctorPath}: expected ${expected} constructor values, got ${c.length}`);
  const params: CurveParams = {
    p0: ctorInt(c[4]!, 4), k: ctorInt(c[5]!, 5), lot: ctorInt(c[6]!, 6), curveLots: ctorInt(c[7]!, 7), gradReserve: ctorInt(c[8]!, 8), feeBps: ctorInt(c[9]!, 9),
    treasurySpk: treasuryCtorBytes(c[10]!, 10, version), creatorSpk: ctorBytes(c[11]!, 11, SPK36_LENGTH), tokenH: toHex(ctorBytes(c[12]!, 12, 32)),
    tokenPrefixLen: Number(ctorInt(c[13]!, 13)), tokenSuffixLen: Number(ctorInt(c[14]!, 14)), poolH: toHex(ctorBytes(c[15]!, 15, 32)),
    tokenCellKas: ctorInt(c[16]!, 16), openWindowLots: ctorInt(c[17]!, 17), openWindowMaxLots: ctorInt(c[18]!, 18),
  };
  if (params.tokenH !== REFERENCE_KCC0020_TEMPLATE_HASH) throw new Error(`preset ${preset}: tokenH ${params.tokenH} is not the reference template`);
  if (params.poolH !== pool.templateHash) throw new Error(`preset ${preset}: poolH ${params.poolH} != pool artifact ${pool.templateHash}`);
  if (params.tokenPrefixLen !== 1 || params.tokenSuffixLen !== 3885) throw new Error(`preset ${preset}: token template lengths ${params.tokenPrefixLen}/${params.tokenSuffixLen}`);
  if (!isP2pkSpk36(params.creatorSpk)) throw new Error(`preset ${preset}: creatorSpk is not a version-0 P2PK script`);
  if (!isTreasurySpkOf(version, params.treasurySpk!)) {
    throw new Error(`preset ${preset}: treasurySpk is not a version-0 P2PK script or the P2SH of a fee splitter`);
  } else if (pool.treasurySpk !== undefined && !bytesEqual(params.treasurySpk!, pool.treasurySpk)) {
    // The curve pays at graduation the treasury the pool's sweep pays afterwards (both template constants).
    throw new Error(`preset ${preset}: treasurySpk is not the v1 pool's treasury script`);
  }
  // The constructor's initial state must be the uninitialised curve, which is what the genesis cell carries.
  const initial = decodeCurveState(base.bytecode.subarray(base.stateOffset, base.stateOffset + base.stateLength));
  if (!bytesEqual(initial.tokenCovId, ZERO32) || initial.lotsSold !== 0n || initial.feeAccrued !== 0n || initial.phase !== PHASE_UNINIT) {
    throw new Error(`preset ${preset}: constructor state is not the uninitialised curve`);
  }
  for (const entry of ['init', 'buy', 'sell', 'sweep', 'graduate']) if (!base.tags[entry]) throw new Error(`preset ${preset}: artifact lacks entry ${entry}`);
  return { ...base, version, name: 'Curve', preset, params, ctorPath, ctorSha256: sha256Hex(ctorText) };
}

/** Load a committed curve preset of an explicit set (v1). */
export function loadCurveTemplateOf(version: ContractSet, preset: string): CurveTemplate {
  return loadCurveTemplate(preset, loadPoolTemplate(version));
}

/**
 * Load a committed pool artifact and its constructor's payout script (a frozen revision's when `revision` is given).
 * Constructor layout: 7 initial state values (`initLpCovId` byte[32] at index 4, the 7th the placeholder creatorSpk),
 * tokenTemplateHash, treasurySpk (9).
 */
export function loadPoolTemplate(set: PoolTemplateSet = DEFAULT_CONTRACT_SET, revision?: string): PoolTemplate {
  const version: PoolTemplateSet = builderContractSet(set);
  const t = poolTemplateFrom(version, poolArtifactPath(version, revision), poolCtorPath(version, revision));
  return revision === undefined ? t : { ...t, revision };
}

function poolTemplateFrom(version: PoolTemplateSet, artifactPath: string, ctorPath: string): PoolTemplate {
  const base = templateFromArtifact('Pool', artifactPath, version);
  const c = readArtifactJson<CtorValue[]>(ctorPath);
  const expected = 9;
  if (c.length !== expected) throw new Error(`${ctorPath}: expected ${expected} constructor values, got ${c.length}`);
  const tokenIdx = expected - 2;
  const tokenH = toHex(ctorBytes(c[tokenIdx]!, tokenIdx, 32));
  if (tokenH !== REFERENCE_KCC0020_TEMPLATE_HASH) throw new Error(`${ctorPath}: tokenTemplateHash ${tokenH} is not the reference template`);
  if (base.stateLength !== poolStateLength(version)) throw new Error(`${ctorPath}: state span length ${base.stateLength}, expected ${poolStateLength(version)}`);
  const lp = hasOpenLiquidity(version);
  const entries = lp ? ['swapKasForTokens', 'swapTokensForKas', 'sweep', ...Object.keys(POOL_V3_ENTRY_SIGNATURES)] : ['swapKasForTokens', 'swapTokensForKas', 'sweep'];
  for (const entry of entries) if (!base.tags[entry]) throw new Error(`pool artifact lacks entry ${entry}`);
  if (lp) {
    // The constructor's initial state is a 139-byte state nobody has bound: lpCovId 0^32, lpShares at the floor.
    const initial = decodePoolState(base.bytecode.subarray(base.stateOffset, base.stateOffset + base.stateLength));
    if (poolStateSet(initial) !== 'v3' || !bytesEqual(initial.lpCovId!, POOL_UNBOUND_LP_COV_ID) || initial.lpShares !== POOL_LP_SHARES) {
      throw new Error(`${ctorPath}: constructor state is not an unbound 139-byte pool at the graduation share count`);
    }
  }
  const treasurySpk = treasuryCtorBytes(c[expected - 1]!, expected - 1, version);
  if (!isTreasurySpkOf(version, treasurySpk)) throw new Error(`${ctorPath}: treasurySpk is not a version-0 P2PK script or the P2SH of a fee splitter`);
  return { ...base, name: 'Pool', tokenH, treasurySpk };
}

/**
 * The treasury constructor value of a set: a 36-byte P2PK script, or for v1 also a 37-byte P2SH script.
 */
function treasuryCtorBytes(v: CtorValue, index: number, version: PoolTemplateSet): Uint8Array {
  if (version === 'v1' && v.kind === 'bytes' && v.value.length === 37) return ctorBytes(v, index, 37);
  return ctorBytes(v, index, SPK36_LENGTH);
}

/** Whether a treasury script is valid for a set: version-0 P2PK; for v1 also version-0 P2SH. */
export function isTreasurySpkOf(version: PoolTemplateSet, spk: Uint8Array): boolean {
  return isP2pkSpk36(spk) || (version === 'v1' && isP2shSpk37(spk));
}

/** The reference KCC20 program from the codec's vendored artifact (argent-lang/kcc20-reference@c8a0871). */
export function loadTokenTemplate(): TokenTemplate {
  const fixture = readArtifactJson<{ contracts: { KCC20: { bytecode_hex: string; template_hash: string; state_span: { offset: number; len: number } } } }>(TOKEN_REFERENCE);
  const c = fixture.contracts.KCC20;
  const bytecode = fromHex(c.bytecode_hex);
  if (bytecode.length !== 4031) throw new Error(`reference bytecode is ${bytecode.length} B, expected 4031`);
  if (c.state_span.offset !== 1 || c.state_span.len !== 145) throw new Error('reference state span is not (1, 145)');
  const hash = templateHashOfProgram(bytecode, 1, 145);
  if (hash !== REFERENCE_KCC0020_TEMPLATE_HASH || c.template_hash !== hash) throw new Error(`reference template hash ${hash} != ${REFERENCE_KCC0020_TEMPLATE_HASH}`);
  return { templateHash: hash, prefix: bytecode.subarray(0, 1), suffix: bytecode.subarray(146), bytecode };
}

/* -------------------------------------------------------------------------- */
/* Curve and pool state                                                        */
/* -------------------------------------------------------------------------- */

// One codec for the curve and pool states, shared with the API server and the
// launch-proof verifier (the codec's cell-state module).
export {
  CURVE_STATE_LENGTH, OWNER_SCHEME_COVENANT_ID, OWNER_SCHEME_P2PK_SCHNORR, PHASE_ACTIVE, PHASE_UNINIT, POOL_LP_SHARES,
  POOL_STATE_LENGTH_V3, SPK36_LENGTH, StateCodecError, ZERO32, decodeCurveState, decodePoolState, encodeCurveState, encodePoolState,
  isP2pkSpk36, isPoolBound, poolStateLayoutOf, poolStateLength, poolStateSet,
};
export type { CurveState, PoolCellState };

/* -------------------------------------------------------------------------- */
/* Programs                                                                    */
/* -------------------------------------------------------------------------- */

export type { TokenState };

/** `R_T = 6b || 20 H_T || EncodeState_112(state) || suffix`; the registry re-identifies it on every build. */
export function tokenProgram(token: TokenTemplate, state: TokenState, registry: LayoutRegistry = defaultRegistry()): Uint8Array {
  const R = concat(token.prefix, encodePushExplicit(fromHex(token.templateHash)), kcc0020_112.encode(state), token.suffix);
  if (R.length !== 4031) throw new Error(`token program is ${R.length} B`);
  const d = registry.identifyTemplate(R);
  if (d.templateHash !== token.templateHash) throw new Error(`token program identifies as ${d.templateHash}`);
  return R;
}

/** The curve program `R` for `state`; throws if it does not hash to the template. */
export function curveProgram(curve: CurveTemplate, state: CurveState): Uint8Array {
  const R = concat(curve.prefix, encodeCurveState(state), curve.suffix);
  const h = templateHashOfProgram(R, curve.stateOffset, curve.stateLength);
  if (h !== curve.templateHash) throw new Error(`curve program hashes to ${h}, expected ${curve.templateHash}`);
  return R;
}

/** The pool program `R` for `state`; throws if the state's layout or the hash does not match the template. */
export function poolProgram(pool: PoolTemplate, state: PoolCellState): Uint8Array {
  // A state is checked against its template's layout.
  if (poolStateSet(state) !== poolStateLayoutOf(pool.version)) throw new Error(`a ${poolStateSet(state)} pool state does not fit the ${pool.version} pool template`);
  const R = concat(pool.prefix, encodePoolState(state), pool.suffix);
  const h = templateHashOfProgram(R, pool.stateOffset, pool.stateLength);
  if (h !== pool.templateHash) throw new Error(`pool program hashes to ${h}, expected ${pool.templateHash}`);
  return R;
}

/** Curve-owned (or pool-owned) token cell state: scheme covenant-id/v1, borrowing disabled. */
export function covenantOwnedToken(amount: bigint, ownerCovenantId: string, extensionCommitment: Uint8Array = ZERO32): TokenState {
  return makeKcc0020State({ amount, owner: fromHex(ownerCovenantId), ownerScheme: OWNER_SCHEME_COVENANT_ID, borrowScheme: BORROW_SCHEME_DISABLED, extensionCommitment });
}

/**
 * A token cell owned by a script (scheme 0x03): authorized by any input spending P2SH(that script), whose own program
 * decides (composable pools: for example a router's cell; the `v1-kasseal-mainnet-2` pool's buy may deliver into one).
 */
export function scriptOwnedToken(amount: bigint, scriptHash: Uint8Array, extensionCommitment: Uint8Array = ZERO32): TokenState {
  if (scriptHash.length !== 32) throw new Error('a script owner is the 32-byte hash of the script');
  return makeKcc0020State({ amount, owner: scriptHash, ownerScheme: 0x03, borrowScheme: BORROW_SCHEME_DISABLED, extensionCommitment });
}

/** The 32-byte hash a P2SH script commits to (`OP_BLAKE2B OP_DATA_32 <hash> OP_EQUAL`): the owner of its script-owned cells. */
export function scriptHashOf(redeem: Uint8Array): Uint8Array {
  return p2shScript(redeem).subarray(2, 34);
}

/** User token cell state: p2pk-schnorr/v1 owner (32-byte x-only key), borrowing disabled unless given. */
export function userToken(amount: bigint, xOnlyPubkey: Uint8Array, { borrowScheme = BORROW_SCHEME_DISABLED, borrowGuard, extensionCommitment = ZERO32 }: { borrowScheme?: number; borrowGuard?: Uint8Array; extensionCommitment?: Uint8Array } = {}): TokenState {
  if (xOnlyPubkey.length !== 32) throw new Error('user token owner must be a 32-byte x-only public key');
  return makeKcc0020State({ amount, owner: xOnlyPubkey, ownerScheme: OWNER_SCHEME_P2PK_SCHNORR, borrowScheme, ...(borrowGuard ? { borrowGuard } : {}), extensionCommitment });
}

/**
 * The frozen v1 revisions whose pools bind L to themselves as the current build does (`lpBoundToPool`), including
 * `v1-kasseal-mainnet-2` and its testnet-10 build. Earlier entries are retained so cells of those builds still decode.
 */
export const V1_LP_BOUND_FROZEN_REVISIONS: readonly string[] = Object.freeze(['v1-2026-10-18-final', 'v1-kasseal-mainnet-tn10', 'v1-kasseal-mainnet', 'v1-kasseal-mainnet-2-tn10', 'v1-kasseal-mainnet-2']);

/**
 * Whether a context's pool binds its LP-share lineage L to itself: the current v1 build and
 * `V1_LP_BOUND_FROZEN_REVISIONS` write the pool id as L's extension commitment at `bindLp` and require it on every
 * deposit and withdrawal; an earlier frozen revision writes 0^32.
 */
export function lpBoundToPool(pool: Pick<PoolTemplate, 'version' | 'revision'>): boolean {
  return pool.version === 'v1' && (pool.revision === undefined || V1_LP_BOUND_FROZEN_REVISIONS.includes(pool.revision));
}

/** The extension commitment every cell of L carries on a pool of this template: P when `lpBoundToPool`, else 0^32. */
export function lpExtensionOf(pool: Pick<PoolTemplate, 'version' | 'revision'>, poolId: string): Uint8Array {
  return lpBoundToPool(pool) ? fromHex(poolId) : new Uint8Array(32);
}

/** Whether a token state is owned by covenant `covenantId` (scheme covenant-id/v1). */
export function isCovenantOwnedBy(state: TokenState, covenantId: string): boolean {
  return state.owner.schemeByte === OWNER_SCHEME_COVENANT_ID && toHex(state.owner.identifier) === covenantId;
}

/* -------------------------------------------------------------------------- */
/* Registry and decoding                                                       */
/* -------------------------------------------------------------------------- */

/** The three cell kinds. */
export type CellKind = 'token' | 'curve' | 'pool';

/** A cell decoded from its program: kind, state, template hash and raw state bytes (hex). */
export type DecodedCell =
  | { readonly kind: 'token'; readonly state: TokenState; readonly templateHash: string; readonly stateHex: string }
  | { readonly kind: 'curve'; readonly state: CurveState; readonly templateHash: string; readonly stateHex: string }
  | { readonly kind: 'pool'; readonly state: PoolCellState; readonly templateHash: string; readonly stateHex: string };

let registryCache: LayoutRegistry | undefined;

/** The codec's default registry (reference token decodable). */
export function defaultRegistry(): LayoutRegistry {
  registryCache ??= createDefaultRegistry();
  return registryCache;
}

/** Registry descriptor for a curve or pool template (recognised by hash; decoded by this module, not by a codec). */
export function templateDescriptor(t: Template): TemplateDescriptor {
  return {
    templateHash: t.templateHash,
    layoutId: t.name === 'Curve' ? 'kasseal-curve-53' : `kasseal-pool-${t.stateLength}`,
    stateOffset: t.stateOffset,
    stateLength: t.stateLength,
    prefixHex: toHex(t.prefix),
    schemes: new Map(),
    recognisedOnly: `${t.name} state is decoded by @kasseal/txbuilder program.ts (${t.name === 'Curve' ? 'decodeCurveState' : 'decodePoolState'})`,
    provenance: `${t.artifactPath} compiled.state_span (${t.stateOffset}, ${t.stateLength}); template hash recomputed on load`,
  };
}

/**
 * Decoder over the three lineages: identifies a program by its recomputed
 * template hash (token through the codec's registry, curve and pool through
 * their artifact hashes), decodes the state and asserts the byte round trip.
 */
export class CellDecoder {
  readonly registry: LayoutRegistry;
  readonly curve: CurveTemplate;
  readonly pool: PoolTemplate;
  readonly token: TokenTemplate;

  constructor(curve: CurveTemplate, pool: PoolTemplate, token: TokenTemplate = loadTokenTemplate()) {
    this.curve = curve;
    this.pool = pool;
    this.token = token;
    this.registry = createDefaultRegistry().registerTemplate(templateDescriptor(curve)).registerTemplate(templateDescriptor(pool));
  }

  decode(program: Uint8Array): DecodedCell {
    const d = this.registry.identifyTemplate(program);
    if (d.templateHash === REFERENCE_KCC0020_TEMPLATE.templateHash) {
      const state = this.registry.assertRoundTrip(program, d.templateHash);
      return { kind: 'token', state, templateHash: d.templateHash, stateHex: toHex(kcc0020_112.encode(state)) };
    }
    const bytes = program.subarray(d.stateOffset, d.stateOffset + d.stateLength);
    if (d.templateHash === this.curve.templateHash) return { kind: 'curve', state: decodeCurveState(bytes), templateHash: d.templateHash, stateHex: toHex(bytes) };
    if (d.templateHash === this.pool.templateHash) return { kind: 'pool', state: decodePoolState(bytes), templateHash: d.templateHash, stateHex: toHex(bytes) };
    throw new Error(`program identifies as unknown template ${d.templateHash}`);
  }

  /** The P2SH script public key a program commits to. */
  spk(program: Uint8Array): Uint8Array {
    return p2shScript(program);
  }
}

/**
 * A served or recorded state in plain-JSON form is malformed: a field is missing, of the wrong type, not a decimal
 * integer or not lowercase hex. The `*FromJson` parsers throw it instead of an untyped
 * `SyntaxError` / `TypeError` from deep inside a build.
 */
export class StateJsonError extends Error {
  /** The offending field. */
  readonly field: string;
  constructor(kind: string, field: string, problem: string) {
    super(`${kind} state JSON: ${field} ${problem}`);
    this.name = 'StateJsonError';
    this.field = field;
  }
}

function jsonRecord(j: unknown, kind: string): Record<string, unknown> {
  if (typeof j !== 'object' || j === null || Array.isArray(j)) throw new StateJsonError(kind, '(root)', 'is not an object');
  return j as Record<string, unknown>;
}

/** A decimal integer field (a string of digits, or a safe integer number). */
function jsonBig(o: Record<string, unknown>, key: string, kind: string): bigint {
  const v = o[key];
  if (typeof v === 'string' && /^-?[0-9]+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  throw new StateJsonError(kind, key, v === undefined ? 'is missing' : 'is not a decimal integer');
}

/** A small integer field (scheme bytes, phase, lock byte). */
function jsonByte(o: Record<string, unknown>, key: string, kind: string): number {
  const v = o[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^[0-9]+$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > 0xff) throw new StateJsonError(kind, key, v === undefined ? 'is missing' : 'is not a byte');
  return n;
}

/** A lowercase hex field, optionally of an exact byte length. */
function jsonHex(o: Record<string, unknown>, key: string, kind: string, bytes?: number): Uint8Array {
  const v = o[key];
  if (typeof v !== 'string' || !/^([0-9a-f]{2})*$/.test(v)) throw new StateJsonError(kind, key, v === undefined ? 'is missing' : 'is not lowercase hex');
  if (bytes !== undefined && v.length !== bytes * 2) throw new StateJsonError(kind, key, `is not ${bytes} bytes`);
  return fromHex(v);
}

/** Plain-JSON form of a token state (hex fields, decimal amount) for ledgers and proofs. */
export function tokenStateToJson(s: TokenState): Record<string, string | number> {
  const f = kcc0020Fields(s);
  return { amount: f.amount.toString(), owner: toHex(f.owner), ownerScheme: f.ownerScheme, borrowScheme: f.borrowScheme, borrowGuard: toHex(f.borrowGuard), extensionCommitment: toHex(f.extensionCommitment) };
}

/** Parse a token state from its plain-JSON form; a malformed field throws `StateJsonError`. */
export function tokenStateFromJson(json: unknown): TokenState {
  const k = 'token';
  const j = jsonRecord(json, k);
  return makeKcc0020State({
    amount: jsonBig(j, 'amount', k), owner: jsonHex(j, 'owner', k), ownerScheme: jsonByte(j, 'ownerScheme', k), borrowScheme: jsonByte(j, 'borrowScheme', k),
    borrowGuard: jsonHex(j, 'borrowGuard', k), extensionCommitment: jsonHex(j, 'extensionCommitment', k),
  });
}

/** Plain-JSON form of a curve state (bigints as decimal strings, bytes as hex). */
export function curveStateToJson(s: CurveState): Record<string, string | number> {
  return { tokenCovId: toHex(s.tokenCovId), lotsSold: s.lotsSold.toString(), feeAccrued: s.feeAccrued.toString(), phase: s.phase };
}

/** Parse a curve state from its plain-JSON form; a malformed field throws `StateJsonError`. */
export function curveStateFromJson(json: unknown): CurveState {
  const k = 'curve';
  const j = jsonRecord(json, k);
  return { tokenCovId: jsonHex(j, 'tokenCovId', k, 32), lotsSold: jsonBig(j, 'lotsSold', k), feeAccrued: jsonBig(j, 'feeAccrued', k), phase: jsonByte(j, 'phase', k) };
}

/** Plain-JSON form of a pool state (the 139-byte layout: `lpCovId` and `creatorSpk`). */
export function poolStateToJson(s: PoolCellState): Record<string, string | number> {
  const base = { tokenCovId: toHex(s.tokenCovId), kasScaled: s.kasScaled.toString(), tokenReserve: s.tokenReserve.toString(), lpShares: s.lpShares.toString() };
  return {
    ...base, lpCovId: toHex(required(s.lpCovId, 'pool state: lpCovId of a 139-byte state')), feeAccruedScaled: s.feeAccruedScaled.toString(),
    creatorSpk: toHex(required(s.creatorSpk, 'pool state: creatorSpk of a 139-byte state')),
  };
}

/** Parse a pool state (the 139-byte layout) from its plain-JSON form; a malformed field throws `StateJsonError`. */
export function poolStateFromJson(json: unknown): PoolCellState {
  const k = 'pool';
  const j = jsonRecord(json, k);
  const base = {
    tokenCovId: jsonHex(j, 'tokenCovId', k, 32), kasScaled: jsonBig(j, 'kasScaled', k), tokenReserve: jsonBig(j, 'tokenReserve', k),
    lpShares: jsonBig(j, 'lpShares', k), feeAccruedScaled: jsonBig(j, 'feeAccruedScaled', k),
  };
  return { ...base, lpCovId: jsonHex(j, 'lpCovId', k, 32), creatorSpk: jsonHex(j, 'creatorSpk', k, SPK36_LENGTH) };
}

export { ENTRY_SIGNATURES, KCC20_FULL_TYPE, covenantDispatchTag } from '@kasseal/codec';

/** Declared argument types of every entry a template of the given set may have (the codec's tables plus the v1 pool's liquidity entries). */
export function entrySignaturesOf(t: Template): Readonly<Record<string, readonly string[]>> {
  if (t.name !== 'Pool' || !hasOpenLiquidity(t.version)) return ENTRY_SIGNATURES[t.name];
  // The v1 pool declares the bounded buy (the tag tells it from the unbounded form); `v1-kasseal-mainnet-2` the
  // composable swaps (positions instead of a user cell).
  if (isComposablePool(t)) return { ...ENTRY_SIGNATURES.Pool, ...POOL_V3_ENTRY_SIGNATURES, swapKasForTokens: POOL_BUY_COMPOSABLE_SIGNATURE, swapTokensForKas: POOL_SELL_COMPOSABLE_SIGNATURE };
  const bounded = t.version === 'v1' && t.tags['swapKasForTokens'] === POOL_BUY_MIN_TAG;
  return { ...ENTRY_SIGNATURES.Pool, ...POOL_V3_ENTRY_SIGNATURES, ...(bounded ? { swapKasForTokens: POOL_BUY_MIN_SIGNATURE } : {}) };
}

/**
 * Whether a pool template's swaps are the composable ones of `v1-kasseal-mainnet-2`: its buy and sell carry the composable dispatch tags. Both or neither; a template with one is refused.
 */
export function isComposablePool(t: Pick<Template, 'name' | 'version' | 'tags'>): boolean {
  if (t.name !== 'Pool' || t.version !== 'v1') return false;
  const buy = t.tags['swapKasForTokens'] === POOL_BUY_COMPOSABLE_TAG;
  const sell = t.tags['swapTokensForKas'] === POOL_SELL_COMPOSABLE_TAG;
  if (buy !== sell) throw new Error(`pool template mixes a ${buy ? 'composable' : 'exact-count'} buy with a ${sell ? 'composable' : 'exact-count'} sell`);
  return buy;
}

/**
 * Throws if any artifact entry has no declared signature, if any declared signature of the set is missing from the
 * artifact, or if an artifact tag differs from the tag derived from its declared signature.
 */
export function assertEntryTags(t: Template): void {
  const declared = entrySignaturesOf(t);
  for (const entry of Object.keys(t.tags)) if (declared[entry] === undefined) throw new Error(`${t.name}.${entry}: artifact entry has no declared signature`);
  for (const [decl, types] of Object.entries(declared)) {
    const derived = covenantDispatchTag(decl, types);
    if (t.tags[decl] !== derived) throw new Error(`${t.name}.${decl}: artifact tag ${t.tags[decl]} != derived ${derived}`);
  }
}
