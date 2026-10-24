/**
 * Browser entry for testnet-10 only: the same API as `./web`, but its import graph reaches only the artifact chunks
 * of the testnet-10 contract build (v1-kasseal-mainnet-2-tn10), so a bundler or extension packager ships no other
 * network's chunks. `initWeb` takes no network, or refuses any other one. Keep in step with `web-mainnet.ts`.
 */
import initWasm, * as kaspaWeb from '../../sdk/vendor/web/kaspa/kaspa.js';
import { assertEntryBuild, initWebFor, type KaspaSdkOption, type WasmSource, type WebEntry } from './web-core.ts';
import { kaspaSdkDigests } from './integrity.ts';

export * from './index.ts';
export type { KaspaSdkOption, WasmSource } from './web-core.ts';

/** SHA-256 of the bundled web `kaspa_bg.wasm`. */
export const WEB_WASM_SHA256: string = kaspaSdkDigests['web/kaspa_bg.wasm']!;
/** SHA-256 of the bundled web `kaspa.js`. */
export const WEB_JS_SHA256: string = kaspaSdkDigests['web/kaspa.js']!;

/** The network this entry serves. */
export const WEB_NETWORK = 'testnet-10';
/** The contract build this entry bundles. */
export const WEB_BUILD = 'v1-kasseal-mainnet-2-tn10';

/** Where the bundled web `kaspa_bg.wasm` is served from (a URL next to this module that bundlers can rewrite). */
export function webWasmUrl(): URL {
  return new URL('./kaspa/web/kaspa_bg.wasm', import.meta.url);
}

export interface InitWebOptions {
  /** Optional; when given it must be `'testnet-10'`. */
  readonly network?: typeof WEB_NETWORK;
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
  // The build is spelled out so the bundled import graph holds only this build's chunks.
  importChunk: async (build, name) => {
    assertEntryBuild(build, WEB_BUILD);
    return import(`./generated/web/v1-kasseal-mainnet-2-tn10--${name}.js`);
  },
};

/**
 * Instantiate the Kaspa SDK and install the testnet-10 contract artifacts. Idempotent; initialising another network
 * in the same page (through any web entry) is refused.
 */
export function initWeb(options: InitWebOptions = {}): Promise<void> {
  return initWebFor(entry, WEB_NETWORK, options);
}
