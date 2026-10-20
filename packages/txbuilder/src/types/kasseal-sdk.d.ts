/**
 * Type surface of `@kasseal/sdk` (`packages/sdk/src/load.mjs`, plain JavaScript).
 * `loadSdk()` verifies the vendored rusty-kaspa v2.1.0 WASM build against
 * SHA256SUMS and returns the `kaspa` namespace; its types are the vendored
 * `kaspa.d.ts` next to the build.
 */
declare module '@kasseal/sdk' {
  export type KaspaSdk = typeof import('@kasseal/sdk/vendor/nodejs/kaspa/kaspa.js');
  export function loadSdk(options?: { root?: string }): KaspaSdk;
  export function verifyVendor(root?: string): string[];
  export const SDK_VERSION: string;
  export function parseSums(text: string): Map<string, string>;
  export function sha256File(file: string): string;
}
