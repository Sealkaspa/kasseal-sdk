/**
 * Token locks v1 (`packages/contracts/lock/v1`: the lock and its factory; the contract README's indexer and builder
 * rules).
 *
 *   Lock         lineage K, a singleton. Owns one cell of a reference KCC-20 lineage T (a token, or a pool's LP-share
 *                lineage) under owner scheme 0x04 and releases it to a fixed beneficiary on a fixed schedule.
 *                `claim()` (anyone, no signature; `now` is the transaction's own lockTime, Unix ms) and
 *                `extend(start, cliff, period, witness)` (the beneficiary; later only, never past `endCap`).
 *   LockFactory  `LockFactory(LOCK_H, creatorSpk)`, a stateless P2SH: `create(...)`, the authorising input of K's
 *                genesis. It recomputes K from its own outpoint and output 0 and checks the state, the deposit, the
 *                lock's T cell and that no other covenant output exists.
 *
 * State (140 B at offset 1, KCC-1): tokenCovId | beneficiary | scheme (0x00 P2PK, 0x03 P2SH) | total | claimed |
 * start | cliff | period | tranches | version | endCap.
 *
 *   vested(now) = now < cliff ? 0 : min(N, floor((now - start) / period))
 *   amountAt(k) = k * (total / N) + floor(k * (total % N) / N)            (amountAt(N) == total)
 *   E           = max(cliff, start + N * period)                           (the time the last tranche is due)
 *   endCap      = E(genesis) + FIVE_YEARS_MS                               (written by the factory, never changed)
 *
 * This module loads the lock and factory artifacts and cross-checks them against their manifest and each other
 * (`loadLockV1`), mirrors the state codec and the schedule arithmetic of the lock contract exactly, and holds the app rules
 * the contract cannot know (the minimum size, the duration limits). The shapes are `shapes/lock.ts`.
 */

import {
  REFERENCE_KCC0020_TEMPLATE_HASH, bytesEqual, concat, covenantDispatchTag, decodeIntState, dispatchTag, encodeIntState, encodePushExplicit, fromHex, kcc0020Fields,
  readPushExplicit, templateHash, toHex, type TokenState,
} from '@kasseal/codec';
import { artifactSource, readArtifactJson } from './artifacts.ts';
import { OWNER_SCHEME_COVENANT_ID, isP2pkSpk36, loadTokenTemplate, type TokenTemplate } from './program.ts';
import { sha256Hex } from './sha256.ts';
import { LOCK_TIME_THRESHOLD, pushCountOf } from './txscript.ts';
import type { Outpoint } from './assemble.ts';

export { LOCK_TIME_THRESHOLD };

/* -------------------------------------------------------------------------- */
/* Constants (the lock and factory contracts; checked against the manifest)   */
/* -------------------------------------------------------------------------- */

/** At most 100 releases. */
export const LOCK_TRANCHES_MAX = 100n;
/** Overflow bound on the locked amount. */
export const LOCK_TOTAL_MAX = 1_000_000_000_000_000_000n;
/** The value of every payout cell, exact (1 KAS; the beneficiary keeps it). */
export const LOCK_PAYOUT_CELL_KAS = 100_000_000n;
/** The most KAS a claim may take from the lock for the network fee (0.2 KAS). */
export const LOCK_FEE_CAP = 20_000_000n;
/** The state's `version`. */
export const LOCK_VERSION = 1n;
/** 5 x 365.25 days in ms: how far past the original end an extend may move the end. */
export const LOCK_FIVE_YEARS_MS = 157_788_000_000n;
/** The part of the deposit left for the final claim's KAS output (1 KAS). */
export const LOCK_FINAL_KAS_MIN = 100_000_000n;
/** The floor of the lock's T cell value (1 KAS). */
export const LOCK_T_CELL_KAS_MIN = 100_000_000n;
/** The most outputs a creation may have (a factory rule). */
export const LOCK_MAX_CREATE_OUTPUTS = 6;
/** The lock output's index in a creation. */
export const LOCK_OUT = 0;

/** Owner schemes a beneficiary may use: a Schnorr key (0x00) or a script hash (0x03). */
export const LOCK_SCHEME_P2PK = 0x00;
export const LOCK_SCHEME_P2SH = 0x03;

/* App and indexer rules: the contract knows no supply and no clock but the claim's lockTime. */

/** A lock holds at least 0.05 % of the token's supply: `total * 10000 >= supply * 5`. */
export const LOCK_MIN_SUPPLY_BPS = 5n;
/** One day in ms. */
export const LOCK_DAY_MS = 86_400_000n;
/** The end E is at least 7 days after the creation. */
export const LOCK_MIN_DURATION_MS = 7n * LOCK_DAY_MS;
/** On a testnet the end E is at least 10 minutes after the creation, so a claim can be seen the same day. */
export const LOCK_MIN_DURATION_MS_TESTNET = 10n * 60_000n;
/**
 * The end E is at most 2 years (2 x 365.25 days) after the creation (a shorter cap while the covenant rules are
 * young). An extend may still move the end up to five years past the original end
 * (`LOCK_FIVE_YEARS_MS`, written into the state by the factory).
 */
export const LOCK_MAX_DURATION_MS = 63_115_200_000n;

/** The state span of the lock program, and of the factory program (`creatorSpk`, a 36-byte push). */
export const LOCK_STATE_LENGTH = 140;
export const LOCK_FACTORY_STATE_LENGTH = 37;

const INT64_MAX = (1n << 63n) - 1n;

/** A beneficiary scheme the lock accepts: P2PK (0x00) or P2SH (0x03). */
function isLockScheme(scheme: number): boolean {
  return scheme === LOCK_SCHEME_P2PK || scheme === LOCK_SCHEME_P2SH;
}

/* -------------------------------------------------------------------------- */
/* Artifacts                                                                   */
/* -------------------------------------------------------------------------- */

/** Where the lock build lives under the artifact root. */
export const LOCK_V1_ARTIFACT_DIR = 'contracts/lock/v1/artifacts';

/**
 * Every artifact file of the lock build (the web bundle needs these): `loadLockV1` hashes each file the manifest lists,
 * the build report included, so a bundle without one of them cannot load the build.
 */
export function lockV1ArtifactPaths(): string[] {
  return ['manifest.json', 'lock.artifact.json', 'lock.ctor.json', 'factory.artifact.json', 'factory.ctor.json', 'build-report.txt'].map((f) => `${LOCK_V1_ARTIFACT_DIR}/${f}`);
}

interface LockManifest {
  readonly set: string;
  readonly version: string;
  readonly inputs: { readonly tokenTemplateHash: string };
  readonly constants: Readonly<Record<string, number>>;
  readonly lock: { readonly templateHash: string; readonly bytecodeBytes: number; readonly stateSpan: { readonly offset: number; readonly length: number }; readonly prefix: string; readonly suffix: { readonly bytes: number; readonly sha256: string }; readonly entries: Readonly<Record<string, string>> };
  readonly factory: { readonly templateHash: string; readonly bytecodeBytes: number; readonly stateSpan: { readonly offset: number; readonly length: number }; readonly lockH: string };
  readonly sha256: Readonly<Record<string, string>>;
}

interface SilArtifact {
  readonly contracts: Record<string, {
    readonly compiled: { readonly bytecode: number[]; readonly state_span: { readonly offset: number; readonly len: number }; readonly template_hash: number[] };
    readonly entries: Record<string, { readonly dispatch_tag: string }>;
  }>;
}

/** One compiled template: prefix and suffix around the state span, its hash and its entry tags. */
export interface LockTemplate {
  readonly prefix: Uint8Array;
  readonly suffix: Uint8Array;
  readonly stateOffset: number;
  readonly stateLength: number;
  readonly templateHash: string;
  readonly bytecode: Uint8Array;
}

/** The lock build, cross-checked on load (`loadLockV1`). */
export interface LockV1Set {
  readonly set: 'kasseal-token-lock';
  readonly version: '1';
  /** The lock template (LOCK_H) and its entry tags. */
  readonly lock: LockTemplate & { readonly claimTag: string; readonly extendTag: string };
  /** The factory template (FACTORY_H, `creatorSpk` excluded) and its `create` tag. */
  readonly factory: LockTemplate & { readonly createTag: string };
  /** The reference token template every lock's T cell runs. */
  readonly token: TokenTemplate;
}

/** The factory's `create` signature, as compiled (its dispatch tag is derived from it). */
export const LOCK_FACTORY_CREATE_SIGNATURE = 'create(byte[32],byte[32],byte,int,int,int,int,int,int,int,byte[],byte[])';
/** The lock's `extend` argument types (a `#[covenant...]` declaration). */
export const LOCK_EXTEND_ARGUMENTS: readonly string[] = Object.freeze(['int', 'int', 'int', 'byte[]']);

let loaded: LockV1Set | undefined;

function templateOf(path: string, name: string): LockTemplate & { tags: Record<string, string> } {
  const a = readArtifactJson<SilArtifact>(path);
  const c = a.contracts[name];
  if (!c) throw new Error(`${path}: no contract ${name}`);
  const bytecode = Uint8Array.from(c.compiled.bytecode);
  const { offset, len } = c.compiled.state_span;
  const prefix = bytecode.subarray(0, offset);
  const suffix = bytecode.subarray(offset + len);
  const hash = templateHash(prefix, suffix);
  if (hash !== toHex(Uint8Array.from(c.compiled.template_hash))) throw new Error(`${path}: recomputed template hash ${hash} != the artifact's`);
  const tags: Record<string, string> = {};
  for (const [entry, e] of Object.entries(c.entries)) tags[entry.replace('__covenant_entrypoint_auth_', '')] = e.dispatch_tag.toLowerCase();
  return { prefix, suffix, stateOffset: offset, stateLength: len, templateHash: hash, bytecode, tags };
}

/** The constants this module mirrors, by manifest name. */
const MIRRORED: Readonly<Record<string, bigint>> = Object.freeze({
  LOCK_TIME_THRESHOLD, TRANCHES_MAX: LOCK_TRANCHES_MAX, TOTAL_MAX: LOCK_TOTAL_MAX, PAYOUT_CELL_KAS: LOCK_PAYOUT_CELL_KAS, FEE_CAP: LOCK_FEE_CAP,
  LOCK_VERSION, FIVE_YEARS_MS: LOCK_FIVE_YEARS_MS, FINAL_KAS_MIN: LOCK_FINAL_KAS_MIN, T_CELL_KAS_MIN: LOCK_T_CELL_KAS_MIN,
  LOCK_OUT: BigInt(LOCK_OUT), MAX_CREATE_OUTPUTS: BigInt(LOCK_MAX_CREATE_OUTPUTS), TOKEN_PREFIX_LEN: 1n, TOKEN_SUFFIX_LEN: 3885n,
});

/**
 * Load and cross-check the lock build (cached):
 *  - every artifact file's SHA-256 is the manifest's;
 *  - both template hashes are recomputed from the artifacts and equal the manifest's (LOCK_H, FACTORY_H); the state
 *    spans are (1, 140) and (1, 37); the lock's prefix and suffix are the manifest's;
 *  - the factory was compiled with `lockH` = LOCK_H (the manifest says so, and the compiled factory pushes LOCK_H
 *    exactly once), and both programs carry the reference token template hash (`TOKEN_H`), which is this builder's;
 *  - the manifest's constants are the ones this module mirrors;
 *  - the entry tags are the ones derived from the entries' signatures (`claim()`, `extend(int,int,int,byte[])`,
 *    `create(...)`);
 *  - the constructor states decode and re-encode byte for byte (the lock's is well formed).
 */
export function loadLockV1(): LockV1Set {
  if (loaded !== undefined) return loaded;
  const where = 'lock v1';
  const m = readArtifactJson<LockManifest>(`${LOCK_V1_ARTIFACT_DIR}/manifest.json`);
  if (m.set !== 'kasseal-token-lock' || m.version !== '1') throw new Error(`${where}: manifest names set ${m.set} version ${m.version}`);
  for (const [file, digest] of Object.entries(m.sha256)) {
    if (!file.startsWith('artifacts/') || file.includes('..')) throw new Error(`${where}: manifest names ${file}`);
    const text = artifactSource().readText(`${LOCK_V1_ARTIFACT_DIR}/${file.slice('artifacts/'.length)}`);
    if (sha256Hex(new TextEncoder().encode(text)) !== digest) throw new Error(`${where}: ${file} does not hash to the manifest's ${digest}`);
  }
  for (const [name, value] of Object.entries(MIRRORED)) {
    if (m.constants[name] === undefined || BigInt(m.constants[name]!) !== value) throw new Error(`${where}: manifest constant ${name} = ${String(m.constants[name])}, the builder mirrors ${value}`);
  }
  const token = loadTokenTemplate();
  if (m.inputs.tokenTemplateHash !== token.templateHash || token.templateHash !== REFERENCE_KCC0020_TEMPLATE_HASH) throw new Error(`${where}: TOKEN_H ${m.inputs.tokenTemplateHash} is not the reference token template`);

  const lock = templateOf(`${LOCK_V1_ARTIFACT_DIR}/lock.artifact.json`, 'Lock');
  if (lock.templateHash !== m.lock.templateHash) throw new Error(`${where}: lock template ${lock.templateHash} != manifest ${m.lock.templateHash}`);
  if (lock.stateOffset !== 1 || lock.stateLength !== LOCK_STATE_LENGTH || m.lock.stateSpan.offset !== 1 || m.lock.stateSpan.length !== LOCK_STATE_LENGTH) throw new Error(`${where}: the lock state span is not (1, ${LOCK_STATE_LENGTH})`);
  if (lock.bytecode.length !== m.lock.bytecodeBytes || toHex(lock.prefix) !== m.lock.prefix || lock.suffix.length !== m.lock.suffix.bytes || sha256Hex(lock.suffix) !== m.lock.suffix.sha256) {
    throw new Error(`${where}: the lock's prefix or suffix is not the manifest's`);
  }
  const claimTag = lock.tags['claim'];
  const extendTag = lock.tags['extend'];
  if (claimTag !== covenantDispatchTag('claim', []) || extendTag !== covenantDispatchTag('extend', LOCK_EXTEND_ARGUMENTS)) throw new Error(`${where}: the lock's entry tags are not the ones derived from claim() and extend(int,int,int,byte[])`);
  decodeLockState(lock.bytecode.subarray(1, 1 + LOCK_STATE_LENGTH));

  const factory = templateOf(`${LOCK_V1_ARTIFACT_DIR}/factory.artifact.json`, 'LockFactory');
  if (factory.templateHash !== m.factory.templateHash) throw new Error(`${where}: factory template ${factory.templateHash} != manifest ${m.factory.templateHash}`);
  if (factory.stateOffset !== 1 || factory.stateLength !== LOCK_FACTORY_STATE_LENGTH) throw new Error(`${where}: the factory state span is not (1, ${LOCK_FACTORY_STATE_LENGTH})`);
  if (factory.bytecode.length !== m.factory.bytecodeBytes) throw new Error(`${where}: the factory is not ${m.factory.bytecodeBytes} B`);
  if (m.factory.lockH !== lock.templateHash) throw new Error(`${where}: the factory was built for lock ${m.factory.lockH}, the lock is ${lock.templateHash}`);
  const lockHPushes = pushCountOf(factory.suffix, fromHex(lock.templateHash));
  if (lockHPushes !== 1) throw new Error(`${where}: the compiled factory pushes LOCK_H ${lockHPushes} times, expected once`);
  for (const [name, t] of [['lock', lock], ['factory', factory]] as const) {
    if (pushCountOf(t.suffix, fromHex(token.templateHash)) < 1) throw new Error(`${where}: the ${name} does not carry TOKEN_H`);
  }
  const createTag = factory.tags['create'];
  if (createTag !== toHex(dispatchTag(LOCK_FACTORY_CREATE_SIGNATURE))) throw new Error(`${where}: the factory's create tag is not the one derived from ${LOCK_FACTORY_CREATE_SIGNATURE}`);
  const spk = factorySpkOf(factory.bytecode);
  if (!bytesEqual(concat(factory.prefix, encodePushExplicit(spk), factory.suffix), factory.bytecode)) throw new Error(`${where}: the factory's constructor state does not re-encode`);

  loaded = {
    set: 'kasseal-token-lock', version: '1',
    lock: { prefix: lock.prefix, suffix: lock.suffix, stateOffset: 1, stateLength: LOCK_STATE_LENGTH, templateHash: lock.templateHash, bytecode: lock.bytecode, claimTag, extendTag },
    factory: { prefix: factory.prefix, suffix: factory.suffix, stateOffset: 1, stateLength: LOCK_FACTORY_STATE_LENGTH, templateHash: factory.templateHash, bytecode: factory.bytecode, createTag },
    token,
  };
  return loaded;
}

/** The `creatorSpk` push in a factory program's state span (1, 37). */
function factorySpkOf(program: Uint8Array): Uint8Array {
  const state = program.subarray(1, 1 + LOCK_FACTORY_STATE_LENGTH);
  const p = readPushExplicit(state, 0);
  if (p.next !== state.length || p.payload.length !== 36) throw new Error('the factory state is not one 36-byte push');
  return Uint8Array.from(p.payload);
}

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

/** The lock's state (the contract's State), field for field. Times are Unix milliseconds. */
export interface LockState {
  /** T: the locked lineage (a token, or a pool's LP-share lineage). */
  readonly tokenCovId: Uint8Array;
  /** A Schnorr x-only key (scheme 0x00) or a script hash (scheme 0x03). */
  readonly beneficiary: Uint8Array;
  readonly scheme: number;
  /** Tokens locked at creation. */
  readonly total: bigint;
  /** Tranches paid so far. */
  readonly claimed: bigint;
  readonly start: bigint;
  readonly cliff: bigint;
  readonly period: bigint;
  /** N, 1..=100. */
  readonly tranches: bigint;
  readonly version: bigint;
  /** The latest end any extend may reach, fixed at creation. */
  readonly endCap: bigint;
}

const INT_FIELDS = ['total', 'claimed', 'start', 'cliff', 'period', 'tranches', 'version', 'endCap'] as const;

/** KCC-1 EncodeState of a lock state (140 B): one PushExplicit per field, declaration order. */
export function encodeLockState(s: LockState): Uint8Array {
  if (s.tokenCovId.length !== 32 || s.beneficiary.length !== 32) throw new Error('lock state: tokenCovId and beneficiary are 32 bytes');
  if (!Number.isInteger(s.scheme) || s.scheme < 0 || s.scheme > 0xff) throw new Error('lock state: scheme is one byte');
  for (const k of INT_FIELDS) if (typeof s[k] !== 'bigint') throw new Error(`lock state: ${k} must be a bigint`);
  const out = concat(
    encodePushExplicit(s.tokenCovId), encodePushExplicit(s.beneficiary), encodePushExplicit(Uint8Array.of(s.scheme)),
    ...INT_FIELDS.map((k) => encodePushExplicit(encodeIntState(s[k]))),
  );
  if (out.length !== LOCK_STATE_LENGTH) throw new Error(`lock state encodes to ${out.length} B, expected ${LOCK_STATE_LENGTH}`);
  return out;
}

/** Decode a 140-byte lock state; refuses anything that does not re-encode byte for byte. */
export function decodeLockState(bytes: Uint8Array): LockState {
  if (bytes.length !== LOCK_STATE_LENGTH) throw new Error(`lock state is ${bytes.length} B, expected ${LOCK_STATE_LENGTH}`);
  let at = 0;
  const next = (len: number, what: string): Uint8Array => {
    const p = readPushExplicit(bytes, at);
    if (p.payload.length !== len) throw new Error(`lock state ${what} is ${p.payload.length} B, expected ${len}`);
    at = p.next;
    return Uint8Array.from(p.payload);
  };
  const tokenCovId = next(32, 'tokenCovId');
  const beneficiary = next(32, 'beneficiary');
  const scheme = next(1, 'scheme')[0]!;
  const ints = INT_FIELDS.map((k) => decodeIntState(next(8, k)));
  if (at !== bytes.length) throw new Error('lock state has trailing bytes');
  const [total, claimed, start, cliff, period, tranches, version, endCap] = ints as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  const s: LockState = { tokenCovId, beneficiary, scheme, total, claimed, start, cliff, period, tranches, version, endCap };
  if (!bytesEqual(encodeLockState(s), bytes)) throw new Error('lock state does not re-encode byte for byte');
  return s;
}

/** E = max(cliff, start + N * period): the time the last tranche is due. */
export function lockEndOf(s: Pick<LockState, 'start' | 'cliff' | 'period' | 'tranches'>): bigint {
  const e = s.start + s.tranches * s.period;
  return s.cliff > e ? s.cliff : e;
}

/** The end cap the factory writes: E + FIVE_YEARS_MS. */
export function lockEndCapOf(s: Pick<LockState, 'start' | 'cliff' | 'period' | 'tranches'>): bigint {
  return lockEndOf(s) + LOCK_FIVE_YEARS_MS;
}

/**
 * Why a state is not well formed for the lock K (the contract's requireWellFormed, with the script's checked int64
 * arithmetic: an end past the int64 range fails), or undefined. `k` (hex) is optional: without it the T != K rule is
 * not checked.
 */
export function lockStateProblem(s: LockState, k?: string): string | undefined {
  if (s.tokenCovId.length !== 32 || s.tokenCovId.every((b) => b === 0)) return 'tokenCovId is zero';
  if (k !== undefined && toHex(s.tokenCovId) === k.toLowerCase()) return 'tokenCovId is the lock itself';
  if (s.beneficiary.length !== 32) return 'beneficiary is not 32 bytes';
  if (!isLockScheme(s.scheme)) return `scheme 0x${s.scheme.toString(16)} is neither P2PK (0x00) nor P2SH (0x03)`;
  if (s.tranches < 1n || s.tranches > LOCK_TRANCHES_MAX) return `tranches ${s.tranches} outside 1..${LOCK_TRANCHES_MAX}`;
  if (s.period <= 0n) return 'period is not positive';
  if (s.start < LOCK_TIME_THRESHOLD) return `start ${s.start} is not a timestamp (below ${LOCK_TIME_THRESHOLD})`;
  if (s.cliff < s.start) return 'cliff is before start';
  if (s.claimed < 0n || s.claimed >= s.tranches) return `claimed ${s.claimed} outside 0..${s.tranches - 1n}`;
  if (s.total < s.tranches) return `total ${s.total} is below the tranche count`;
  if (s.total > LOCK_TOTAL_MAX) return `total ${s.total} above ${LOCK_TOTAL_MAX}`;
  if (s.version !== LOCK_VERSION) return `version ${s.version} is not ${LOCK_VERSION}`;
  for (const k2 of INT_FIELDS) if (s[k2] > INT64_MAX || s[k2] < -INT64_MAX) return `${k2} is outside the int64 range`;
  const e = lockEndOf(s);
  if (s.tranches * s.period > INT64_MAX || s.start + s.tranches * s.period > INT64_MAX) return 'the end leaves the int64 range';
  if (e > s.endCap) return `the end ${e} is past endCap ${s.endCap}`;
  return undefined;
}

/** Throws unless the state is well formed (`lockStateProblem`). */
export function assertLockState(s: LockState, k?: string): void {
  const p = lockStateProblem(s, k);
  if (p !== undefined) throw new Error(`lock state: ${p}`);
}

/** Tokens released by the first k tranches: `k * q + floor(k * r / N)` (the contract's amountAt). */
export function lockAmountAt(s: Pick<LockState, 'total' | 'tranches'>, k: bigint): bigint {
  if (k < 0n || k > s.tranches) throw new Error(`amountAt(${k}) outside 0..${s.tranches}`);
  const q = s.total / s.tranches;
  const r = s.total % s.tranches;
  return k * q + (k * r) / s.tranches;
}

/** Tranches vested at `now`: 0 before the cliff, then whole periods since start, at most N (the contract's vestedAt). */
export function lockVestedAt(s: Pick<LockState, 'start' | 'cliff' | 'period' | 'tranches'>, now: bigint): bigint {
  if (now < s.cliff) return 0n;
  const v = (now - s.start) / s.period;
  return v > s.tranches ? s.tranches : v;
}

/** The first time tranche k (1..N) is due: `max(cliff, start + k * period)`. */
export function lockDueAt(s: Pick<LockState, 'start' | 'cliff' | 'period' | 'tranches'>, k: bigint): bigint {
  if (k < 1n || k > s.tranches) throw new Error(`tranche ${k} outside 1..${s.tranches}`);
  const t = s.start + k * s.period;
  return t > s.cliff ? t : s.cliff;
}

/** Tokens the lock's T cell holds in this state: `total - amountAt(claimed)`. */
export function lockRemaining(s: LockState): bigint {
  return s.total - lockAmountAt(s, s.claimed);
}

/** What a claim at `now` pays: the tranches vested, the tokens and whether it is the final claim; 0 tranches when nothing is due. */
export function lockClaimableAt(s: LockState, now: bigint): { readonly vested: bigint; readonly tranches: bigint; readonly amount: bigint; readonly final: boolean } {
  const vested = lockVestedAt(s, now);
  if (vested <= s.claimed) return { vested: s.claimed, tranches: 0n, amount: 0n, final: false };
  return { vested, tranches: vested - s.claimed, amount: lockAmountAt(s, vested) - lockAmountAt(s, s.claimed), final: vested === s.tranches };
}

/**
 * The next release of a live lock: the time the next unpaid tranche is due and what a claim at that time pays (a cliff
 * releases every tranche vested by then at once). Undefined when nothing is left (a live state always has claimed < N).
 */
export function lockNextUnlock(s: LockState): { readonly at: bigint; readonly vested: bigint; readonly amount: bigint; readonly final: boolean } | undefined {
  if (s.claimed >= s.tranches) return undefined;
  const at = lockDueAt(s, s.claimed + 1n);
  const c = lockClaimableAt(s, at);
  return { at, vested: c.vested, amount: c.amount, final: c.final };
}

/** Every release still to come, by due time (tranches due at the same time, before or at the cliff, are one release). */
export function lockSchedule(s: LockState): { readonly at: bigint; readonly vested: bigint; readonly amount: bigint }[] {
  const out: { at: bigint; vested: bigint; amount: bigint }[] = [];
  let paid = s.claimed;
  for (let k = s.claimed + 1n; k <= s.tranches; k++) {
    const at = lockDueAt(s, k);
    // vested(at) >= k: every tranche due by `at` is one release.
    const vested = lockVestedAt(s, at);
    out.push({ at, vested, amount: lockAmountAt(s, vested) - lockAmountAt(s, paid) });
    paid = vested;
    k = vested;
  }
  return out;
}

/** The KAS the factory requires in the lock output: `N * (PAYOUT_CELL_KAS + FEE_CAP) + FINAL_KAS_MIN`. */
export function lockDeposit(tranches: bigint): bigint {
  if (tranches < 1n || tranches > LOCK_TRANCHES_MAX) throw new Error(`tranches ${tranches} outside 1..${LOCK_TRANCHES_MAX}`);
  return tranches * (LOCK_PAYOUT_CELL_KAS + LOCK_FEE_CAP) + LOCK_FINAL_KAS_MIN;
}

/** The terms of a new lock (everything but `claimed`, `version` and `endCap`, which creation fixes). */
export interface LockTerms {
  readonly tokenCovId: Uint8Array;
  readonly beneficiary: Uint8Array;
  readonly scheme: number;
  readonly total: bigint;
  readonly start: bigint;
  readonly cliff: bigint;
  readonly period: bigint;
  readonly tranches: bigint;
}

/** The genesis state the factory writes for these terms: claimed 0, the current version, endCap = E + 5 years. */
export function lockGenesisState(t: LockTerms): LockState {
  return { ...t, claimed: 0n, version: LOCK_VERSION, endCap: lockEndCapOf(t) };
}

/** A lock creation breaks an app rule (size, duration, releases, scheme, schedule); the contract would accept it, the app does not. */
export class LockRuleViolation extends Error {
  readonly rule: 'size' | 'duration' | 'releases' | 'scheme' | 'schedule';
  constructor(rule: LockRuleViolation['rule'], detail: string) {
    super(`lock ${rule}: ${detail}`);
    this.name = 'LockRuleViolation';
    this.rule = rule;
  }
}

/** "7 days", "10 minutes", or the ms when neither is whole. */
function durationText(ms: bigint): string {
  if (ms % LOCK_DAY_MS === 0n) return `${ms / LOCK_DAY_MS} day${ms === LOCK_DAY_MS ? '' : 's'}`;
  if (ms % 60_000n === 0n) return `${ms / 60_000n} minute${ms === 60_000n ? '' : 's'}`;
  return `${ms} ms`;
}

/**
 * The app and indexer rules of a new lock (README "Not enforced on chain"): at least 0.05 % of
 * `supply`; the end E at least 7 days and at most 2 years after `now` (the creation time; the indexer checks against
 * the creation's block time); nothing due at `now` (the first release after it); at most 100 releases; a P2PK or P2SH
 * beneficiary. Throws `LockRuleViolation`.
 * `minDurationMs` replaces the 7-day minimum (a testnet passes `LOCK_MIN_DURATION_MS_TESTNET`).
 */
export function assertLockAppRules(t: LockTerms, ctx: { readonly supply: bigint; readonly now: bigint; readonly minDurationMs?: bigint }): void {
  if (!isLockScheme(t.scheme)) throw new LockRuleViolation('scheme', `beneficiary scheme 0x${t.scheme.toString(16)} is neither P2PK nor P2SH`);
  if (t.tranches < 1n || t.tranches > LOCK_TRANCHES_MAX) throw new LockRuleViolation('releases', `${t.tranches} releases, 1 to ${LOCK_TRANCHES_MAX} allowed`);
  if (ctx.supply <= 0n) throw new LockRuleViolation('size', 'the supply must be positive');
  if (t.total * 10_000n < ctx.supply * LOCK_MIN_SUPPLY_BPS) throw new LockRuleViolation('size', `${t.total} is below 0.05 % of the supply ${ctx.supply}`);
  if (t.total > ctx.supply) throw new LockRuleViolation('size', `${t.total} is above the supply ${ctx.supply}`);
  const minimum = ctx.minDurationMs ?? LOCK_MIN_DURATION_MS;
  if (minimum <= 0n || minimum > LOCK_MAX_DURATION_MS) throw new LockRuleViolation('duration', `the minimum duration ${minimum} ms is outside 1..${LOCK_MAX_DURATION_MS} ms`);
  const duration = lockEndOf(t) - ctx.now;
  if (duration < minimum) throw new LockRuleViolation('duration', `the lock ends ${duration} ms after now, at least ${durationText(minimum)} (${minimum} ms) required`);
  if (duration > LOCK_MAX_DURATION_MS) throw new LockRuleViolation('duration', `the lock ends ${duration} ms after now, at most 2 years (${LOCK_MAX_DURATION_MS} ms) allowed`);
  // No back-dated schedule: the contract has no clock at creation, so a start far in the
  // past vests most of the lock at once (or at a cliff moments later) while it still reads as locked. The first
  // release by the schedule, start + period, must be after now: a start at most one period back (a custom first
  // release), and only releases that build up after the creation, cliff or not.
  if (t.start + t.period <= ctx.now) throw new LockRuleViolation('schedule', `the first release by the schedule is due at ${t.start + t.period}, not after now ${ctx.now}: tokens would be claimable at creation`);
}

/* -------------------------------------------------------------------------- */
/* Programs                                                                    */
/* -------------------------------------------------------------------------- */

/** True when the bytes around a program's state span `(offset, length)` hash to `hash` (its template). */
function spansHashTo(program: Uint8Array, offset: number, length: number, hash: string): boolean {
  return templateHash(program.subarray(0, offset), program.subarray(offset + length)) === hash;
}

/** The lock program with a state: `prefix || EncodeState || suffix`, its template hash re-checked. */
export function lockProgram(set: LockV1Set, s: LockState): Uint8Array {
  const R = concat(set.lock.prefix, encodeLockState(s), set.lock.suffix);
  if (!spansHashTo(R, set.lock.stateOffset, set.lock.stateLength, set.lock.templateHash)) throw new Error('lock program does not hash to LOCK_H');
  return R;
}

/** The state of a lock program; refuses a program that is not the lock template. */
export function lockStateOfProgram(set: LockV1Set, program: Uint8Array): LockState {
  const { stateOffset: o, stateLength: l } = set.lock;
  if (program.length !== set.lock.bytecode.length) throw new Error('program length is not the lock template\'s');
  if (!spansHashTo(program, o, l, set.lock.templateHash)) throw new Error('program is not the lock template (LOCK_H)');
  return decodeLockState(program.subarray(o, o + l));
}

/**
 * `LockFactory(LOCK_H, creatorSpk)` for a creator's `version(2) || P2PK script(34)`: the factory template with that
 * state. Refuses anything but a version-0 Schnorr P2PK script (the factory binds the creation to an input paying it).
 */
export function lockFactoryProgram(set: LockV1Set, creatorSpk36: Uint8Array): Uint8Array {
  if (!isP2pkSpk36(creatorSpk36)) throw new Error('creatorSpk is not a version-0 Schnorr P2PK script (36 B)');
  const R = concat(set.factory.prefix, encodePushExplicit(creatorSpk36), set.factory.suffix);
  if (!spansHashTo(R, 1, LOCK_FACTORY_STATE_LENGTH, set.factory.templateHash)) throw new Error('factory program does not hash to FACTORY_H');
  return R;
}

/** The creator script a factory program carries; refuses a program that is not the factory template. */
export function lockFactoryCreatorOf(set: LockV1Set, program: Uint8Array): Uint8Array {
  if (program.length !== set.factory.bytecode.length) throw new Error('program length is not the factory template\'s');
  if (!spansHashTo(program, 1, LOCK_FACTORY_STATE_LENGTH, set.factory.templateHash)) throw new Error('program is not the factory template (FACTORY_H)');
  const spk = factorySpkOf(program);
  if (!isP2pkSpk36(spk)) throw new Error('the factory\'s creatorSpk is not a version-0 Schnorr P2PK script');
  return spk;
}

/** The beneficiary's own script (the final claim's KAS output): P2PK `20 <key> ac` or P2SH `aa 20 <hash> 87`. */
export function lockPayeeScript(s: Pick<LockState, 'beneficiary' | 'scheme'>): Uint8Array {
  if (s.beneficiary.length !== 32) throw new Error('beneficiary is not 32 bytes');
  if (s.scheme === LOCK_SCHEME_P2PK) return concat(Uint8Array.of(0x20), s.beneficiary, Uint8Array.of(0xac));
  if (s.scheme === LOCK_SCHEME_P2SH) return concat(Uint8Array.of(0xaa, 0x20), s.beneficiary, Uint8Array.of(0x87));
  throw new Error(`beneficiary scheme 0x${s.scheme.toString(16)} is neither P2PK nor P2SH`);
}

/* -------------------------------------------------------------------------- */
/* Cells                                                                       */
/* -------------------------------------------------------------------------- */

/** A live lock cell (lineage K). `daaScore` is the DAA score of the block that accepted it. */
export interface LockCell {
  readonly kind: 'lock';
  readonly outpoint: Outpoint;
  readonly value: bigint;
  /** K, lowercase hex. */
  readonly covenantId: string;
  readonly program: Uint8Array;
  readonly state: LockState;
  readonly daaScore: bigint;
}

/**
 * A lock cell from a served UTXO, re-derived from its program: the lock template, a well-formed state for K, the served
 * state (when given) equal to the program's.
 */
export function lockCellOf(set: LockV1Set, u: { outpoint: Outpoint; value: bigint; covenantId: string; program: Uint8Array; daaScore: bigint; state?: LockState }): LockCell {
  const k = u.covenantId.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(k)) throw new Error('the lock cell carries no covenant id');
  const state = lockStateOfProgram(set, u.program);
  assertLockState(state, k);
  if (u.state !== undefined && !bytesEqual(encodeLockState(u.state), encodeLockState(state))) throw new Error('the served lock state differs from the state decoded from its program');
  return { kind: 'lock', outpoint: { txid: u.outpoint.txid.toLowerCase(), index: u.outpoint.index }, value: u.value, covenantId: k, program: u.program, state, daaScore: u.daaScore };
}

/**
 * Why a token cell is not the lock's own T cell, or undefined (the contract's pinTokenCell): lineage T, created by the same
 * transaction as the lock cell (the decoy rule), owned by K under 0x04, borrowing disabled, no guard, holding exactly
 * `total - amountAt(claimed)`.
 */
export function lockTokenCellProblem(lock: LockCell, cell: { readonly outpoint: Outpoint; readonly covenantId: string; readonly state: TokenState }): string | undefined {
  if (cell.covenantId.toLowerCase() !== toHex(lock.state.tokenCovId)) return `the cell is of lineage ${cell.covenantId}, the lock holds ${toHex(lock.state.tokenCovId)}`;
  if (cell.outpoint.txid.toLowerCase() !== lock.outpoint.txid) return 'the cell was not created by the lock cell\'s transaction (a decoy)';
  const f = kcc0020Fields(cell.state);
  if (f.ownerScheme !== OWNER_SCHEME_COVENANT_ID || toHex(f.owner) !== lock.covenantId) return 'the cell is not owned by the lock (0x04, K)';
  if (f.borrowScheme !== 0 || f.borrowGuard.some((b) => b !== 0)) return 'the cell has a borrow scheme or guard set';
  if (f.amount !== lockRemaining(lock.state)) return `the cell holds ${f.amount}, the lock state leaves ${lockRemaining(lock.state)}`;
  return undefined;
}
