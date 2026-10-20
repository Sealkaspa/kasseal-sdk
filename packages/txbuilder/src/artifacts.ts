/**
 * Access to the compiled contract artifacts the builder reads (one source
 * tree, a Node entry and a web entry).
 *
 * Artifact paths are relative to the artifact root and use `/`. Every launch
 * uses contract set v1:
 *
 *   contracts/curve/v1/artifacts/curve.<preset>.artifact.json   compiled curve per preset
 *   contracts/curve/v1/curve.ctor.<preset>.json                  its constructor constants
 *   contracts/pool/v1/artifacts/pool.artifact.json               the pool the curve graduates into
 *   contracts/pool/v1/pool.ctor.json                             its constructor constants
 *   codec/fixtures/argent-kcc20-reference-c8a0871.json           the reference KCC20 program
 *
 * A named v1 build is a frozen revision (`V1_FROZEN_REVISIONS`), each under
 * `contracts/{curve,pool}/v1/artifacts/<revision>/`.
 *
 * This module has no I/O of its own. The Node entry installs a file-system
 * source (`artifacts.node.ts`); the web entry installs a source over a map of
 * the same files. Every consumer re-verifies what it reads (template hashes
 * are recomputed in `program.ts`), so the source only has to deliver the
 * bytes.
 *
 * On-demand presets (web): the Standard family's price bands (dozens of curve
 * artifacts of about 39 KB each) need not be in the initial map. The plugin emits one chunk per band (its v1 files), the virtual module's `bands` export maps each
 * band name to a loader, and `registerLazyArtifacts` takes those loaders. A
 * caller loads the one band it needs with `ensurePresetArtifacts(preset)` before
 * it creates a context from it; every map source (`artifactSourceFromFiles`)
 * then serves the band's files too. Reading a band's file before that throws
 * `ArtifactNotLoaded`.
 */
import { CONTRACT_SETS, type ContractSet } from '@kasseal/codec';

/** A read-only view of the artifact files. */
export interface ArtifactSource {
  /** UTF-8 text of one artifact file; throws `ArtifactMissing` when absent. */
  readText(path: string): string;
  /** File names (not paths) directly inside `dir`, sorted. */
  list(dir: string): string[];
}

/** An artifact file is not available from the installed source. */
export class ArtifactMissing extends Error {
  /** The missing path. */
  readonly path: string;
  constructor(path: string) {
    super(`contract artifact ${path} is not available in this build`);
    this.name = 'ArtifactMissing';
    this.path = path;
  }
}

/** No artifact source is installed: load the SDK through its Node or web entry first. */
export class ArtifactSourceNotInstalled extends Error {
  constructor() {
    super('no contract artifact source is installed: import the package through its Node entry, or call initWeb() with the artifacts');
    this.name = 'ArtifactSourceNotInstalled';
  }
}

/** The committed contract sets (`ContractSet`, from `@kasseal/codec`): `v1`, every launch. */
export type { ContractSet };
export { CONTRACT_SETS };
/** The sets the builder loads artifacts for and builds transactions on. */
export type BuilderContractSet = ContractSet;
/** Every set the builder supports. */
export const BUILDER_CONTRACT_SETS: readonly BuilderContractSet[] = Object.freeze(['v1'] as const);
/** The set of a pool template (a contract set). */
export type PoolTemplateSet = BuilderContractSet;

/** The sets whose pool has the open-liquidity entries (`bindLp`, `addLiquidity`, `removeLiquidity`) and the 139-byte state. */
export function hasOpenLiquidity(version: PoolTemplateSet): version is 'v1' {
  return version === 'v1';
}

/** A contract set the codec knows but a component does not support (kept for components that refuse a set). */
export class ContractSetNotSupported extends Error {
  /** The refused set. */
  readonly set: ContractSet;
  constructor(set: ContractSet, what: string) {
    super(`contract set ${set} is not supported by ${what} yet`);
    this.name = 'ContractSetNotSupported';
    this.set = set;
  }
}

/** `version` as a set the builder supports; throws for an unknown set. */
export function builderContractSet(version: ContractSet, what = 'the transaction builder'): BuilderContractSet {
  if (!CONTRACT_SETS.includes(version)) throw new Error(`unknown contract version ${String(version)} (${what})`);
  return version;
}

/** The set every new launch uses unless the caller names another (`BuildCreateParams.contractSet`). */
export const DEFAULT_CONTRACT_SET: BuilderContractSet = 'v1';

/** Artifact directory of the current v1 curve constructor files. */
export const CURVE_V1_DIR = 'contracts/curve/v1';
/** Artifact directory of the compiled v1 curves (and of the frozen revisions' subdirectories). */
export const CURVE_V1_ARTIFACT_DIR = 'contracts/curve/v1/artifacts';
/** Artifact path of the current v1 pool. */
export const POOL_V1_ARTIFACT = 'contracts/pool/v1/artifacts/pool.artifact.json';
/** Artifact path of the current v1 pool's constructor constants. */
export const POOL_V1_CTOR = 'contracts/pool/v1/pool.ctor.json';
/** Artifact path of the reference KCC-20 token program (argent-lang/kcc20-reference@c8a0871). */
export const TOKEN_REFERENCE = 'codec/fixtures/argent-kcc20-reference-c8a0871.json';

/**
 * Frozen v1 revisions: the curve presets and the pool of a named v1 build, each under
 * `contracts/curve/v1/artifacts/<revision>/` (`curve.ctor.<preset>.json`, `curve.<preset>.artifact.json`)
 * and `contracts/pool/v1/artifacts/<revision>/` (`pool.artifact.json`, `pool.ctor.json`). The builder trades, adds and
 * withdraws liquidity on them and graduates their curves into their own pool. A network recognises only its own
 * revisions (`v1RevisionsOn`).
 *
 * The current builds are `v1-kasseal-mainnet-2` (`V1_COMPOSABLE_REVISION`, mainnet) and its testnet-10 build
 * `v1-kasseal-mainnet-2-tn10` (`V1_COMPOSABLE_TWIN_REVISION`). Their pool's swaps take positions instead of a user
 * cell (`isComposablePool`). The other entries are earlier builds, listed so cells of those builds still decode when
 * their artifacts are available.
 */
export const V1_FROZEN_REVISIONS: readonly string[] = Object.freeze(['v1-2026-10-18-final', 'v1-kasseal-mainnet-tn10', 'v1-kasseal-mainnet', 'v1-kasseal-mainnet-2-tn10', 'v1-kasseal-mainnet-2']);

/**
 * An earlier mainnet build, frozen and never launched on; mainnet launches use `V1_COMPOSABLE_REVISION`. Testnets never
 * recognise it.
 */
export const V1_MAINNET_REVISION = 'v1-kasseal-mainnet';
/** The testnet-10 build of `V1_MAINNET_REVISION` (same sources, the testnet company P2PK as treasury). */
export const V1_MAINNET_TWIN_REVISION = 'v1-kasseal-mainnet-tn10';
/** The mainnet build every mainnet launch uses: the v1 contracts with composable pool swaps. */
export const V1_COMPOSABLE_REVISION = 'v1-kasseal-mainnet-2';
/** The testnet-10 build of `V1_COMPOSABLE_REVISION` (the same sources, the testnet company P2PK as the treasury). */
export const V1_COMPOSABLE_TWIN_REVISION = 'v1-kasseal-mainnet-2-tn10';
/** The revisions compiled for mainnet (their manifests say `"network": "mainnet"`); every other revision is a testnet build. */
export const V1_MAINNET_REVISIONS: readonly string[] = Object.freeze([V1_MAINNET_REVISION, V1_COMPOSABLE_REVISION]);
const MAINNET = 'mainnet';

/** The non-current v1 revisions a network recognises: the mainnet revisions on mainnet, every other one elsewhere. */
export function v1RevisionsOn(networkId: string): readonly string[] {
  const mainnet = networkId === MAINNET;
  return V1_FROZEN_REVISIONS.filter((r) => V1_MAINNET_REVISIONS.includes(r) === mainnet);
}

const TESTNET_10 = 'testnet-10';

/**
 * The revision a new launch uses on a network unless the caller names one: `v1-kasseal-mainnet-2` on mainnet,
 * `v1-kasseal-mainnet-2-tn10` on testnet-10, the current build (undefined) elsewhere. Tokens launched on an earlier
 * build keep it for life.
 */
export function launchRevisionOf(networkId: string): string | undefined {
  if (networkId === MAINNET) return V1_COMPOSABLE_REVISION;
  return networkId === TESTNET_10 ? V1_COMPOSABLE_TWIN_REVISION : undefined;
}

function assertRevision(version: ContractSet, revision: string): string {
  if (version !== 'v1' || !V1_FROZEN_REVISIONS.includes(revision)) throw new Error(`unknown frozen ${version} revision ${revision}`);
  return revision;
}

function assertVersion(version: ContractSet): void {
  builderContractSet(version, 'the builder\'s artifact source');
}

/** The directory whose curve constructor files are the presets of a set (a frozen revision's when given). */
export function curvePresetDir(version: ContractSet = DEFAULT_CONTRACT_SET, revision?: string): string {
  assertVersion(version);
  if (revision !== undefined) return `${CURVE_V1_ARTIFACT_DIR}/${assertRevision(version, revision)}`;
  return CURVE_V1_DIR;
}

/** Artifact path of a curve preset's compiled program (a frozen revision's when given). */
export function curveArtifactPath(preset: string, version: ContractSet = DEFAULT_CONTRACT_SET, revision?: string): string {
  assertVersion(version);
  if (revision !== undefined) return `${curvePresetDir(version, revision)}/curve.${preset}.artifact.json`;
  return `${CURVE_V1_ARTIFACT_DIR}/curve.${preset}.artifact.json`;
}

/** Artifact path of a curve preset's constructor constants (a frozen revision's when given). */
export function curveCtorPath(preset: string, version: ContractSet = DEFAULT_CONTRACT_SET, revision?: string): string {
  return `${curvePresetDir(version, revision)}/curve.ctor.${preset}.json`;
}

/** The pool artifact of a set (a frozen revision's when given). */
export function poolArtifactPath(version: PoolTemplateSet = DEFAULT_CONTRACT_SET, revision?: string): string {
  assertVersion(version);
  if (revision !== undefined) return `contracts/pool/v1/artifacts/${assertRevision(version, revision)}/pool.artifact.json`;
  return POOL_V1_ARTIFACT;
}

/** Artifact path of the pool's constructor constants (a frozen revision's when given). */
export function poolCtorPath(version: PoolTemplateSet = DEFAULT_CONTRACT_SET, revision?: string): string {
  assertVersion(version);
  if (revision !== undefined) return `contracts/pool/v1/artifacts/${assertRevision(version, revision)}/pool.ctor.json`;
  return POOL_V1_CTOR;
}

const PRESET_CTOR = /^curve\.ctor\.([A-Za-z0-9_-]+)\.json$/;

/** Preset names of the constructor files in a listing of `contracts/curve` (`curve.ctor.<preset>.json`). */
export function presetsOf(fileNames: readonly string[]): string[] {
  return fileNames.flatMap((f) => {
    const m = PRESET_CTOR.exec(f);
    return m ? [m[1]!] : [];
  }).sort();
}

/** The preset names in a listing of a set's preset directory (`curvePresetDir`). */
export function presetsOfSet(version: ContractSet, fileNames: readonly string[]): string[] {
  assertVersion(version);
  return presetsOf(fileNames);
}

/**
 * Every artifact path the builder can read for the given v1 curve presets: the presets and the pool of the current
 * build and of every frozen v1 revision (or of `revisions`, a subset: a web build for one network carries only that
 * network's, `v1RevisionsOn`), and the reference token.
 */
export function artifactPathsFor(presets: readonly string[], revisions: readonly string[] = V1_FROZEN_REVISIONS): string[] {
  return [
    ...presets.flatMap((p) => [curveArtifactPath(p, 'v1'), curveCtorPath(p, 'v1')]),
    POOL_V1_ARTIFACT, POOL_V1_CTOR,
    // The frozen v1 revisions: the same preset names, each with its own pool.
    ...revisions.map((r) => assertRevision('v1', r)).flatMap((r) => [
      ...presets.flatMap((p) => [curveArtifactPath(p, 'v1', r), curveCtorPath(p, 'v1', r)]),
      poolArtifactPath('v1', r), poolCtorPath('v1', r),
    ]),
    TOKEN_REFERENCE,
  ];
}

function normalise(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (p.split('/').some((s) => s === '..' || s === '')) throw new Error(`artifact path ${path} is not a plain relative path`);
  return p;
}

/** Loaders of the artifacts loaded on demand (the web build's Standard bands): preset name to `{ path: text }`. */
export type LazyArtifactLoaders = Readonly<Record<string, () => Promise<Readonly<Record<string, string>>>>>;

/** A file of an on-demand preset was read before `ensurePresetArtifacts(preset)` loaded it. */
export class ArtifactNotLoaded extends ArtifactMissing {
  /** The preset to load first. */
  readonly preset: string;
  constructor(path: string, preset: string) {
    super(path);
    this.message = `contract artifact ${path} belongs to preset ${preset}, which this build loads on demand: await ensurePresetArtifacts('${preset}') first`;
    this.name = 'ArtifactNotLoaded';
    this.preset = preset;
  }
}

const lazyLoaders = new Map<string, () => Promise<Readonly<Record<string, string>>>>();
const lazyFiles = new Map<string, string>();
const lazyLoads = new Map<string, Promise<void>>();
const lazyLoaded = new Set<string>();

/** Register the on-demand presets of this build (idempotent; a later loader for the same preset replaces the earlier one). */
export function registerLazyArtifacts(loaders: LazyArtifactLoaders): void {
  for (const [preset, load] of Object.entries(loaders)) {
    if (typeof load !== 'function') throw new Error(`lazy artifact loader for ${preset} is not a function`);
    lazyLoaders.set(preset, load);
  }
}

/**
 * Forget every on-demand preset loaded so far (the loaders stay registered), as a page reload does. Tests use it to
 * check that a path loads the band it needs instead of relying on an earlier screen having loaded it.
 */
export function forgetLazyArtifacts(): void {
  lazyFiles.clear();
  lazyLoads.clear();
  lazyLoaded.clear();
}

/** The presets this build loads on demand, sorted. */
export function lazyArtifactPresets(): string[] {
  return [...lazyLoaders.keys()].sort();
}

/** Whether `preset` is loaded on demand and its load has not completed yet. */
export function presetArtifactsPending(preset: string): boolean {
  return lazyLoaders.has(preset) && !lazyLoaded.has(preset);
}

/**
 * Load the artifacts of an on-demand preset (a Standard band in the web build) into every map source. Resolves at
 * once for a preset that is not on demand (bundled up front, or unknown: creating its context then fails as before).
 * Concurrent and repeated calls share one load; a failed load may be retried.
 */
export function ensurePresetArtifacts(preset: string): Promise<void> {
  const load = lazyLoaders.get(preset);
  if (load === undefined) return Promise.resolve();
  let p = lazyLoads.get(preset);
  if (p === undefined) {
    p = load().then((files) => {
      for (const [path, text] of Object.entries(files)) {
        if (typeof text !== 'string') throw new Error(`artifact ${path} is not text`);
        lazyFiles.set(normalise(path), text);
      }
      lazyLoaded.add(preset);
    });
    p.catch(() => lazyLoads.delete(preset));
    lazyLoads.set(preset, p);
  }
  return p;
}

const CURVE_FILE = /(?:^|\/)curve\.(?:ctor\.)?([A-Za-z0-9_-]+?)(?:\.artifact|\.ctor)?\.json$/;

/** A source over an in-memory map `{ path: text }` (the web build's bundled artifacts), plus the on-demand presets loaded so far. */
export function artifactSourceFromFiles(files: Readonly<Record<string, string>>): ArtifactSource {
  const map = new Map<string, string>();
  for (const [path, text] of Object.entries(files)) {
    if (typeof text !== 'string') throw new Error(`artifact ${path} is not text`);
    map.set(normalise(path), text);
  }
  return {
    readText(path: string): string {
      const key = normalise(path);
      const text = map.get(key) ?? lazyFiles.get(key);
      if (text !== undefined) return text;
      const preset = CURVE_FILE.exec(key)?.[1];
      if (preset !== undefined && presetArtifactsPending(preset)) throw new ArtifactNotLoaded(path, preset);
      throw new ArtifactMissing(path);
    },
    list(dir: string): string[] {
      const prefix = `${normalise(dir)}/`;
      const names = new Set<string>();
      for (const key of [...map.keys(), ...lazyFiles.keys()]) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (!rest.includes('/')) names.add(rest);
      }
      return [...names].sort();
    },
  };
}

let installed: ArtifactSource | undefined;

/** Install the artifact source of this build (the entries do this; tests may install a map). Returns the previous one. */
export function installArtifactSource(source: ArtifactSource): ArtifactSource | undefined {
  const previous = installed;
  installed = source;
  return previous;
}

/** The installed artifact source; throws `ArtifactSourceNotInstalled` when none is. */
export function artifactSource(): ArtifactSource {
  if (installed === undefined) throw new ArtifactSourceNotInstalled();
  return installed;
}

/** Parsed JSON of one artifact file. */
export function readArtifactJson<T>(path: string): T {
  return JSON.parse(artifactSource().readText(path)) as T;
}
