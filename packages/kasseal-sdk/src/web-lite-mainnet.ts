/**
 * Browser entry for mainnet only, for apps that ship their own Kaspa WASM SDK (wallets): the API of
 * `./web/mainnet` without the bundled Kaspa SDK. Its import graph reaches neither `kaspa.js` nor `kaspa_bg.wasm`, only
 * the mainnet contract build's artifact chunks. `initWeb` requires `kaspa: { module, wasm?, sha256? }`, which must
 * pass the known-answer test (`kat.ts`) before it is installed. Keep in step with `web-lite-testnet-10.ts`.
 */
import { assertEntryBuild, initWebFor, type KaspaSdkOption, type WebEntry } from './web-core.ts';

export * from './index.ts';
export type { KaspaSdkOption, WasmSource } from './web-core.ts';

/** The network this entry serves. */
export const WEB_NETWORK = 'mainnet';
/** The contract build this entry bundles. */
export const WEB_BUILD = 'v1-kasseal-mainnet-2';

export interface InitWebOptions {
  /** Optional; when given it must be `'mainnet'`. */
  readonly network?: typeof WEB_NETWORK;
  /**
   * Your Kaspa SDK (required: this entry bundles none). Before anything is installed it must report version 2.1.0,
   * expose the API the builders use, and reproduce the pinned build's known answers (transactions, txids, sighashes,
   * genesis covenant ids, signatures that verify); otherwise `initWeb` rejects with `SdkCompatibilityError` (or
   * `SdkIntegrityError` for a `sha256` mismatch) and installs nothing.
   */
  readonly kaspa: KaspaSdkOption;
  /** Curve presets to load up front (default none: load one with `ensurePresetArtifacts(preset)` before using it). */
  readonly preload?: readonly string[] | 'all';
}

const entry: WebEntry = {
  // The build is spelled out so the bundled import graph holds only this build's chunks.
  importChunk: async (build, name) => {
    assertEntryBuild(build, WEB_BUILD);
    return import(`./generated/web/v1-kasseal-mainnet-2--${name}.js`);
  },
};

/**
 * Check and install your Kaspa SDK, then the mainnet contract artifacts. Idempotent; initialising another network
 * in the same page (through any web entry) is refused.
 */
export function initWeb(options: InitWebOptions): Promise<void> {
  return initWebFor(entry, WEB_NETWORK, options);
}
