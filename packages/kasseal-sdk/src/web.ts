/**
 * Browser entry: everything of the package root, plus `initWeb`, which instantiates the pinned Kaspa WASM SDK (web
 * build) after checking the WASM bytes against their pinned SHA-256 (or, with the `kaspa` option, checks a Kaspa SDK
 * the caller supplies against the pinned build's known answers, see `kat.ts`), and installs the bundled contract artifacts of
 * one network. Artifacts are code-split per curve preset (a patch against the build's curve template, see
 * web-chunks.ts); each chunk's files are rebuilt as text and checked against the compiled-in manifest before use. Nothing reachable from this module imports a Node built-in. This entry can load either
 * network's chunks; `./web/mainnet` and `./web/testnet-10` reach only their own network's.
 */
import initWasm, * as kaspaWeb from '../../sdk/vendor/web/kaspa/kaspa.js';
import type { KassealNetwork } from './networks.ts';
import { initWebWith, type KaspaSdkOption, type WasmSource, type WebEntry } from './web-core.ts';
import { kaspaSdkDigests } from './integrity.ts';

export * from './index.ts';
export type { KaspaSdkOption, WasmSource } from './web-core.ts';

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
  readonly wasm?: WasmSource;
  /**
   * Use this Kaspa SDK instead of the bundled one (then `wasm` must be left out). Before anything is installed it
   * must report version 2.1.0, expose the API the builders use, and reproduce the pinned build's known answers
   * (transactions, txids, sighashes, genesis covenant ids, signatures that verify); otherwise `initWeb` rejects with
   * `SdkCompatibilityError` (or `SdkIntegrityError` for a `sha256` mismatch) and installs nothing.
   */
  readonly kaspa?: KaspaSdkOption;
  /** Curve presets to load up front (default none: load one with `ensurePresetArtifacts(preset)` before using it). */
  readonly preload?: readonly string[] | 'all';
}

const entry: WebEntry = {
  bundled: { initWasm, kaspa: kaspaWeb, wasmUrl: webWasmUrl },
  importChunk: (build, name) => import(`./generated/web/${build}--${name}.js`),
};

/**
 * Instantiate the Kaspa SDK and install the contract artifacts of `network`. Idempotent for the same network; a
 * second network in the same page is refused.
 */
export function initWeb(options: InitWebOptions): Promise<void> {
  return initWebWith(entry, options.network, options);
}
