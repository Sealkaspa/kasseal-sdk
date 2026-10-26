/**
 * The browser initialisation shared by the web entries (`./web` and the per-network `./web/<network>`). Each entry
 * hands in the Kaspa web module, the WASM URL next to it and its own artifact chunk loader, so a per-network entry's
 * import graph reaches only its own build's chunks. The state is shared: one Kaspa SDK and one network per page,
 * whichever entry initialises it.
 */
import { sha256Hex } from '../../codec/src/sha256.ts';
import { artifactSourceFromFiles, installArtifactSource, registerLazyArtifacts } from '../../txbuilder/src/artifacts.ts';
import { installSdk, sdkAvailable, type KaspaSdk } from '../../txbuilder/src/sdk.ts';
import { verifyKaspaSdk } from './kat.ts';
import { ArtifactIntegrityError, SdkIntegrityError, artifactManifest, assertArtifactDigest, kaspaSdkDigests } from './integrity.ts';
import { assertNetwork, BUILDS_OF_NETWORK, UnsupportedNetwork, type KassealNetwork } from './networks.ts';
import { decodeCurvePatchChunk, isCurvePatchChunk, isCurveTemplateChunk } from './web-chunks.ts';

/** SHA-256 of the bundled web `kaspa_bg.wasm` (each entry exports it as `WEB_WASM_SHA256`). */
const WEB_WASM_SHA256: string = kaspaSdkDigests['web/kaspa_bg.wasm']!;

/** A WASM binary, or where to fetch it. */
export type WasmSource = Uint8Array | ArrayBuffer | URL | string | Response;

/**
 * A Kaspa WASM SDK (rusty-kaspa 2.1.0, web target) supplied by the caller instead of the bundled one, for an app that
 * already ships its own build. It is used only if it passes the known-answer test against the pinned build.
 */
export interface KaspaSdkOption {
  /**
   * The SDK's JavaScript bindings, as imported (`import * as kaspa from '…/kaspa.js'`): the namespace with its default
   * export, the wasm-bindgen init function.
   */
  readonly module: { readonly default?: unknown };
  /**
   * The SDK's WASM binary, or where to fetch it. `initWeb` passes it to the module's init function. Omit it when your
   * app has already initialised the module (its init is then not called again). A module that is already initialised
   * keeps the WASM it runs and ignores these bytes; the known-answer test checks whatever the module runs.
   */
  readonly wasm?: WasmSource;
  /** SHA-256 (hex) the `wasm` bytes must have; checked before they are instantiated. Requires `wasm`. */
  readonly sha256?: string;
}

/** The options of `initWeb` other than the network. */
export interface InitWebCommonOptions {
  /**
   * The WASM binary, or where to fetch it (default: `webWasmUrl()`). Its bytes are hashed against `WEB_WASM_SHA256`
   * before they are instantiated. Not with `kaspa`.
   */
  readonly wasm?: WasmSource;
  /**
   * Use this Kaspa SDK instead of the bundled one (then `wasm` must be left out; required by the entries that bundle
   * no Kaspa SDK). Before anything is installed it must report version 2.1.0, expose the API the builders use, and
   * reproduce the pinned build's known answers (transactions, txids, sighashes, genesis covenant ids, signatures that
   * verify); otherwise `initWeb` rejects with `SdkCompatibilityError` (or `SdkIntegrityError` for a `sha256`
   * mismatch) and installs nothing.
   */
  readonly kaspa?: KaspaSdkOption;
  /** Curve presets to load up front (default none: load one with `ensurePresetArtifacts(preset)` before using it). */
  readonly preload?: readonly string[] | 'all';
}

/** The Kaspa web SDK an entry bundles. */
export interface BundledKaspa {
  /** The Kaspa web module's default export (its WASM initialiser). */
  readonly initWasm: (options: { module_or_path: Uint8Array }) => Promise<unknown>;
  /** The Kaspa web module's namespace. */
  readonly kaspa: unknown;
  /** The bundled WASM's URL next to the entry. */
  readonly wasmUrl: () => URL;
}

/** What a web entry provides to `initWebWith`. */
export interface WebEntry {
  /** The bundled Kaspa web SDK; absent in the entries for apps that bring their own (`kaspa` option required). */
  readonly bundled?: BundledKaspa;
  /** Import the module of a build's artifact chunk (`base` or a curve preset). */
  readonly importChunk: (build: string, name: string) => Promise<unknown>;
}

interface SubtleDigest {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}

async function sha256Of(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleDigest } }).crypto?.subtle;
  if (subtle === undefined) return sha256Hex(bytes);
  const d = new Uint8Array(await subtle.digest('SHA-256', bytes));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

async function wasmBytes(source: WasmSource, file = 'web/kaspa_bg.wasm'): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  const response = typeof source === 'string' || source instanceof URL ? await fetch(source) : source;
  if (!response.ok) throw new SdkIntegrityError(file, `HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

const CALLER_WASM = 'kaspa_bg.wasm (caller-supplied)';

/** Arguments of the `kaspa` option, refused before anything is fetched. */
function checkKaspaOption(entry: WebEntry, options: InitWebCommonOptions): void {
  const o = options.kaspa;
  if (o === undefined) {
    if (entry.bundled === undefined) throw new TypeError('initWeb: this entry bundles no Kaspa SDK: pass your own as kaspa: { module, wasm }');
    return;
  }
  if (options.wasm !== undefined) throw new TypeError('initWeb: pass the WASM of a caller-supplied SDK as kaspa.wasm, not wasm');
  if (o === null || typeof o !== 'object' || o.module === null || typeof o.module !== 'object') throw new TypeError('initWeb: kaspa.module must be the imported bindings namespace');
  if (o.wasm !== undefined && typeof o.module.default !== 'function') throw new TypeError('initWeb: kaspa.module has no default init function to instantiate kaspa.wasm with');
  if (o.sha256 !== undefined) {
    if (o.wasm === undefined) throw new TypeError('initWeb: kaspa.sha256 needs kaspa.wasm');
    if (typeof o.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(o.sha256)) throw new TypeError('initWeb: kaspa.sha256 must be 64 hex characters');
  }
}

/** Instantiate (when `wasm` is given) and check a caller-supplied SDK; returns it once it passed every check. */
async function callerSdk(o: KaspaSdkOption): Promise<KaspaSdk> {
  if (o.wasm !== undefined) {
    const bytes = await wasmBytes(o.wasm, CALLER_WASM);
    if (o.sha256 !== undefined) {
      const expected = o.sha256.toLowerCase();
      const actual = await sha256Of(bytes);
      if (actual !== expected) throw new SdkIntegrityError(CALLER_WASM, `sha256 ${actual} does not match the given ${expected}`);
    }
    await (o.module.default as (init: { module_or_path: Uint8Array }) => Promise<unknown>)({ module_or_path: bytes });
  }
  return verifyKaspaSdk(o.module);
}

type ArtifactChunk = Readonly<Record<string, string>>;

async function importChunk(entry: WebEntry, build: string, name: string): Promise<unknown> {
  const mod = (await entry.importChunk(build, name)) as { default: unknown };
  return mod.default;
}

/**
 * The artifact chunk of a build: `base` (pool and token reference) or a curve preset. A preset chunk is a patch
 * against the build's curve template; its files are rebuilt as text first. Every text is then checked against its
 * pinned SHA-256.
 */
async function loadChunk(entry: WebEntry, build: string, name: string): Promise<ArtifactChunk> {
  const chunk = await importChunk(entry, build, name);
  let files: ArtifactChunk;
  if (isCurvePatchChunk(chunk)) {
    const template = await importChunk(entry, build, 'curve-template');
    if (!isCurveTemplateChunk(template)) throw new ArtifactIntegrityError(`${build}--curve-template`, 'is not a curve template');
    try {
      files = decodeCurvePatchChunk(template, chunk);
    } catch (e) {
      throw new ArtifactIntegrityError(`${build}--${name}`, `could not be decoded (${e instanceof Error ? e.message : String(e)})`);
    }
  } else {
    files = chunk as ArtifactChunk;
  }
  const encoder = new TextEncoder();
  for (const [path, text] of Object.entries(files)) {
    if (typeof text !== 'string') throw new ArtifactIntegrityError(path, 'is not text');
    assertArtifactDigest(path, await sha256Of(encoder.encode(text)));
  }
  return files;
}

function presetsOfBuild(build: string): string[] {
  const info = artifactManifest.builds[build];
  if (info === undefined) throw new ArtifactIntegrityError(build, 'is not a bundled build');
  return Object.keys(info.presets).sort();
}

let ready: Promise<void> | undefined;
let readyNetwork: KassealNetwork | undefined;

/**
 * Instantiate the Kaspa SDK (the bundled one, or the caller's through `kaspa` once it passes the known-answer test) and
 * install the contract artifacts of `network`, through `entry`. Idempotent for the same
 * network; a second network in the same page is refused.
 */
export function initWebWith(entry: WebEntry, network: KassealNetwork, options: InitWebCommonOptions): Promise<void> {
  assertNetwork(network);
  checkKaspaOption(entry, options);
  if (ready !== undefined) {
    if (readyNetwork !== network) return Promise.reject(new Error(`initWeb already ran for ${readyNetwork}`));
    return ready;
  }
  readyNetwork = network;
  ready = (async () => {
    if (sdkAvailable()) throw new Error('a Kaspa SDK is already installed in this context');
    if (options.kaspa !== undefined) {
      installSdk(await callerSdk(options.kaspa));
    } else {
      const bundled = entry.bundled!;
      const bytes = await wasmBytes(options.wasm ?? bundled.wasmUrl());
      const actual = await sha256Of(bytes);
      if (actual !== WEB_WASM_SHA256) throw new SdkIntegrityError('web/kaspa_bg.wasm', `sha256 ${actual} does not match the pinned ${WEB_WASM_SHA256}`);
      await bundled.initWasm({ module_or_path: bytes });
      installSdk(bundled.kaspa as KaspaSdk);
    }
    // Every build of the network (a token keeps the build it launched on): one on-demand loader per preset name gives
    // that preset's files of each build that has it.
    const builds = BUILDS_OF_NETWORK[network];
    const presetsOf = new Map(builds.map((b) => [b, presetsOfBuild(b)] as const));
    const presets = [...new Set(builds.flatMap((b) => presetsOf.get(b)!))].sort();
    const loadPreset = async (p: string): Promise<ArtifactChunk> => {
      const out: Record<string, string> = {};
      for (const b of builds) if (presetsOf.get(b)!.includes(p)) Object.assign(out, await loadChunk(entry, b, p));
      return out;
    };
    const loaders: Record<string, () => Promise<ArtifactChunk>> = {};
    for (const p of presets) loaders[p] = () => loadPreset(p);
    registerLazyArtifacts(loaders);
    const pre: Record<string, string> = {};
    for (const b of builds) Object.assign(pre, await loadChunk(entry, b, 'base'));
    const wanted = options.preload === 'all' ? presets : options.preload ?? [];
    for (const p of wanted) {
      if (!presets.includes(p)) throw new ArtifactIntegrityError(p, `is not a preset of ${builds.join(' or ')}`);
      Object.assign(pre, await loadPreset(p));
    }
    installArtifactSource(artifactSourceFromFiles(pre));
  })();
  ready.catch(() => { ready = undefined; readyNetwork = undefined; });
  return ready;
}

/**
 * `initWeb` of a per-network entry: `options.network` may be left out, and any network other than the entry's is
 * refused (`UnsupportedNetwork`).
 */
export function initWebFor(entry: WebEntry, network: KassealNetwork, options: InitWebCommonOptions & { readonly network?: unknown } = {}): Promise<void> {
  const asked = options.network;
  if (asked !== undefined && asked !== network) {
    assertNetwork(asked);
    const e = new UnsupportedNetwork(asked);
    e.message = `network ${JSON.stringify(asked)} is not served by the ${network} web entry: import '@kassealhq/sdk/web/${asked}' (or '@kassealhq/sdk/web')`;
    throw e;
  }
  return initWebWith(entry, network, options);
}

/** Refuse a chunk of any build but `entryBuilds` (a per-network entry bundles only its network's). */
export function assertEntryBuild(build: string, entryBuilds: readonly string[]): void {
  if (!entryBuilds.includes(build)) throw new ArtifactIntegrityError(build, `is not bundled with the ${entryBuilds.join(' + ')} web entry`);
}
