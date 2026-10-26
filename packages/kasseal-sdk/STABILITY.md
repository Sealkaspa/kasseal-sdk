# Stability and versioning

`@kassealhq/sdk` follows [semantic versioning](https://semver.org). While the version is **0.x**, the rules are:

| Release | May contain |
|---|---|
| Patch (`0.1.0` → `0.1.1`) | Bug fixes, security fixes and documentation. No change to any stable API below, and no change to the bytes of any transaction a builder produces for the same inputs, unless the old bytes were wrong |
| Minor (`0.1.x` → `0.2.0`) | New features, and breaking changes to the API. Every breaking change is listed in the [CHANGELOG](CHANGELOG.md) with what to do |

Pin a minor version (`~0.1.0`) if you want only fixes. Version 1.0.0 will freeze the public API under the usual
semver rules.

**Safety fixes come first.** If a release fixes a way your users could lose funds, we may tighten a check in a patch
release, so that a call which used to succeed now throws. A stricter check is never loosened in a patch. Versions
with a safety issue are marked deprecated on npm, with the reason.

## What is stable in 0.x

Changes to these happen only in a minor release, listed in the CHANGELOG:

- **Quote math**: the results of the curve, pool, liquidity and slippage functions. They mirror the contracts
  exactly; a contract build never changes, so for a given build the numbers never change either.
- **Error codes**: the `code` string of every error class in [docs/errors.md](docs/errors.md). A code is never reused
  for a different meaning.
- **The launch-proof verdicts**: `bound`, `unverified`, `invalid`, `malformed`, and what each means.
- **The bundled contract builds**: `v1-kasseal-mainnet-3`, `v1-kasseal-mainnet-2` and their testnet-10 builds
  `v1-kasseal-mainnet-3-tn10`, `v1-kasseal-mainnet-2-tn10`, their artifacts and their hashes. A new contract build is added in a minor release; a bundled build is never modified.
- **Entry points**: `@kassealhq/sdk`, `@kassealhq/sdk/node`, `@kassealhq/sdk/web`, `@kassealhq/sdk/web/mainnet`,
  `@kassealhq/sdk/web/testnet-10`, `@kassealhq/sdk/web-lite/mainnet`, `@kassealhq/sdk/web-lite/testnet-10`.

## What may change in a minor release

- Builder parameters and result shapes (with a CHANGELOG entry and a migration note).
- Wallet adapter details, as the wallets themselves change.
- The pinned Kaspa WASM SDK version.
- Helpers marked experimental in their documentation.

## What the SDK does not control

- **The contracts on chain.** A launched token keeps its contract build for life. New launches may move to a new
  build; the SDK will support both, and the CHANGELOG will say so before it happens.
- **The Kasseal API.** Its `/v1` routes are additive: new fields are not breaking, and a breaking change ships as
  `/v2`.
- **Kaspa itself.** Network upgrades can change fees or mass rules; such changes ship in a release as soon as they are
  known.
