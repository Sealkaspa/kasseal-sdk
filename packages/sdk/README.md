# @kasseal/sdk — vendored rusty-kaspa WASM SDK v2.1.0

This package pins the official Kaspa WASM SDK so nothing in this repository
depends on a path outside the checkout or on an unverified download.

## Provenance

| | |
|---|---|
| Upstream release | https://github.com/kaspanet/rusty-kaspa/releases/tag/v2.1.0 (published 2026-09-22) |
| Asset | `kaspa-wasm32-sdk-v2.1.0.zip` (56,646,535 bytes) |
| Download URL | https://github.com/kaspanet/rusty-kaspa/releases/download/v2.1.0/kaspa-wasm32-sdk-v2.1.0.zip |
| Downloaded | 2026-10-07 via `gh release download v2.1.0 -R kaspanet/rusty-kaspa -p kaspa-wasm32-sdk-v2.1.0.zip` |
| Zip sha256 (computed locally) | `ba674e109ff5dd8bedc4dc2ee8a5ecdf4b600b1178a541d77888ec58310b6124` |
| Upstream checksum | **Not published.** The v2.1.0 release page lists no `.sha256`/`SHA256SUMS` asset and the release notes contain no digest for the WASM zip, so the value above is our own first-sight measurement. Re-download and compare before trusting a fresh checkout. |

The release's own version of the vendored builds reports `version() === "2.1.0"`
(`vendor/*/kaspa/package.json` → `"version": "2.1.0"`).

## What is vendored

Only the two production builds Node and the browser need, without `docs/`,
`examples/`, README copies or the `-dev` (debug-symbol, ~49 MB) builds:

| Path | Purpose | Size |
|---|---|---|
| `vendor/nodejs/kaspa/` | CommonJS build used by `loadSdk()` | ~12.3 MB |
| `vendor/web/kaspa/` | ESM build for browser consumers (`@kasseal/sdk/vendor/web/kaspa/kaspa.js`) | ~12.3 MB |

Each directory keeps `kaspa.js`, `kaspa_bg.wasm`, `kaspa.d.ts`,
`kaspa_bg.wasm.d.ts`, `package.json` and upstream `LICENSE` (ISC).
Total ~24 MB. `*.wasm` is marked binary in the root `.gitattributes`.

## Integrity

`SHA256SUMS` records the zip digest plus one line per vendored file
(`shasum -a 256` format). `loadSdk()` (`src/load.mjs`) re-hashes every
`vendor/` entry with `node:crypto` on first load and throws
`SdkIntegrityError` on any missing or mismatched file **before** the WASM is
required; it also asserts `version()` equals `2.1.0`.

Check by hand:

```sh
cd packages/sdk
shasum -a 256 -c SHA256SUMS --ignore-missing   # zip is not vendored, so ignore-missing
pnpm run verify
```

## Usage

```js
import { loadSdk } from '@kasseal/sdk';
const k = loadSdk();              // verified kaspa namespace
const rpc = new k.RpcClient({ url: 'ws://127.0.0.1:17210', encoding: k.Encoding.Borsh, networkId: 'testnet-10' });
```

## Upgrading

1. Download the new `kaspa-wasm32-sdk-vX.Y.Z.zip` from the matching GitHub release.
2. Replace `vendor/nodejs/kaspa` and `vendor/web/kaspa` with the same six files.
3. Regenerate: `{ shasum -a 256 kaspa-wasm32-sdk-vX.Y.Z.zip; find vendor -type f | LC_ALL=C sort | xargs shasum -a 256; } > SHA256SUMS`
4. Bump `SDK_VERSION` in `src/load.mjs`, the version in `package.json`, this README, and run `pnpm run verify` and the SDK's release checks.
