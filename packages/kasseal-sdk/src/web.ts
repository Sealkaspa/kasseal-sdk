/**
 * Browser entry: everything of the package root, plus `initWeb`, which instantiates the pinned Kaspa WASM SDK (web
 * build) after checking the WASM bytes against their pinned SHA-256, and installs the bundled contract artifacts of
 * one network. Artifacts are code-split per curve preset; each chunk's files are checked against the compiled-in
 * manifest before use. Nothing reachable from this module imports a Node built-in.
 */
import initWasm, * as kaspaWeb from '../../sdk/vendor/web/kaspa/kaspa.js';
import { sha256Hex } from '../../codec/src/sha256.ts';
import { artifactSourceFromFiles, installArtifactSource, registerLazyArtifacts } from '../../txbuilder/src/artifacts.ts';
import { installSdk, sdkAvailable, type KaspaSdk } from '../../txbuilder/src/sdk.ts';
import { ArtifactIntegrityError, SdkIntegrityError, artifactManifest, assertArtifactDigest, kaspaSdkDigests } from './integrity.ts';
import { assertNetwork, BUILD_OF_NETWORK, type KassealNetwork } from './networks.ts';

export * from './index.ts';

/** SHA-256 of the bundled web `kaspa_bg.wasm`. */
export const WEB_WASM_SHA256: string = kaspaSdkDigests['web/kaspa_bg.wasm']!;
/** SHA-256 of the bundled web `kaspa.js`. */
export const WEB_JS_SHA256: string = kaspaSdkDigests['web/kaspa.js']!;

/** Where the bundled web `kaspa_bg.wasm` is served from (a URL next to this module that bundlers can rewrite). */
export function webWasmUrl(): URL {
  return new URL('./kaspa/web/kaspa_bg.wasm', import.meta.url);
}

export interface InitWebOptions {
  /** The network whose contract build is installed; required. */
  readonly network: KassealNetwork;
  /**
   * The WASM binary, or where to fetch it (default: `webWasmUrl()`). Its bytes are hashed against `WEB_WASM_SHA256`
   * before they are instantiated.
   */
  readonly wasm?: Uint8Array | ArrayBuffer | URL | string | Response;
  /** Curve presets to load up front (default none: load one with `ensurePresetArtifacts(preset)` before using it). */
  readonly preload?: readonly string[] | 'all';
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

async function wasmBytes(source: NonNullable<InitWebOptions['wasm']>): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  const response = typeof source === 'string' || source instanceof URL ? await fetch(source) : source;
  if (!response.ok) throw new SdkIntegrityError('web/kaspa_bg.wasm', `HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

type ArtifactChunk = Readonly<Record<string, string>>;

/** The artifact chunk of a build: `base` (pool and token reference) or a curve preset. */
async function loadChunk(build: string, name: string): Promise<ArtifactChunk> {
  const mod = (await import(`./generated/web/${build}--${name}.js`)) as { default: ArtifactChunk };
  const files = mod.default;
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
 * Instantiate the Kaspa SDK and install the contract artifacts of `network`. Idempotent for the same network; a
 * second network in the same page is refused.
 */
export function initWeb(options: InitWebOptions): Promise<void> {
  assertNetwork(options.network);
  if (ready !== undefined) {
    if (readyNetwork !== options.network) return Promise.reject(new Error(`initWeb already ran for ${readyNetwork}`));
    return ready;
  }
  readyNetwork = options.network;
  ready = (async () => {
    if (sdkAvailable()) throw new Error('a Kaspa SDK is already installed in this context');
    const bytes = await wasmBytes(options.wasm ?? webWasmUrl());
    const actual = await sha256Of(bytes);
    if (actual !== WEB_WASM_SHA256) throw new SdkIntegrityError('web/kaspa_bg.wasm', `sha256 ${actual} does not match the pinned ${WEB_WASM_SHA256}`);
    await initWasm({ module_or_path: bytes });
    installSdk(kaspaWeb as unknown as KaspaSdk);
    const build = BUILD_OF_NETWORK[options.network];
    const presets = presetsOfBuild(build);
    const loaders: Record<string, () => Promise<ArtifactChunk>> = {};
    for (const p of presets) loaders[p] = () => loadChunk(build, p);
    registerLazyArtifacts(loaders);
    const base = await loadChunk(build, 'base');
    const wanted = options.preload === 'all' ? presets : options.preload ?? [];
    const pre: Record<string, string> = { ...base };
    for (const p of wanted) {
      if (!presets.includes(p)) throw new ArtifactIntegrityError(p, `is not a preset of ${build}`);
      Object.assign(pre, await loadChunk(build, p));
    }
    installArtifactSource(artifactSourceFromFiles(pre));
  })();
  ready.catch(() => { ready = undefined; readyNetwork = undefined; });
  return ready;
}
