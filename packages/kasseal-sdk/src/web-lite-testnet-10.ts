/**
 * Browser entry for testnet-10 only, for apps that ship their own Kaspa WASM SDK (wallets): the API of
 * `./web/testnet-10` without the bundled Kaspa SDK. Its import graph reaches neither `kaspa.js` nor `kaspa_bg.wasm`, only
 * the testnet-10 contract builds' artifact chunks. `initWeb` requires `kaspa: { module, wasm?, sha256? }`, which must
 * pass the known-answer test (`kat.ts`) before it is installed. Keep in step with `web-lite-mainnet.ts`.
 */
import { assertEntryBuild, initWebFor, type KaspaSdkOption, type WebEntry } from './web-core.ts';

export * from './index.ts';
export type { KaspaSdkOption, WasmSource } from './web-core.ts';

/** The network this entry serves. */
export const WEB_NETWORK = 'testnet-10';
/** The contract build new launches use on this network. */
export const WEB_BUILD = 'v1-kasseal-mainnet-3-tn10';
/** The contract builds this entry bundles (a token keeps the build it launched on). */
export const WEB_BUILDS: readonly string[] = Object.freeze(['v1-kasseal-mainnet-3-tn10', 'v1-kasseal-mainnet-2-tn10']);

export interface InitWebOptions {
  /** Optional; when given it must be `'testnet-10'`. */
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
  importChunk: async (build, name) => {
    assertEntryBuild(build, WEB_BUILDS);
    // Each build spelled out, so the bundled import graph holds only this network's chunks.
    return build === 'v1-kasseal-mainnet-3-tn10' ? import(`./generated/web/v1-kasseal-mainnet-3-tn10--${name}.js`) : import(`./generated/web/v1-kasseal-mainnet-2-tn10--${name}.js`);
  },
};

/**
 * Check and install your Kaspa SDK, then the testnet-10 contract artifacts. Idempotent; initialising another network
 * in the same page (through any web entry) is refused.
 */
export function initWeb(options: InitWebOptions): Promise<void> {
  return initWebFor(entry, WEB_NETWORK, options);
}
