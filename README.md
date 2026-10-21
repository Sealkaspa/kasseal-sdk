# Kasseal SDK

[![npm](https://img.shields.io/npm/v/@kassealhq/sdk)](https://www.npmjs.com/package/@kassealhq/sdk)
[![sdk-release](https://github.com/Sealkaspa/kasseal-sdk/actions/workflows/sdk-release.yml/badge.svg?branch=main)](https://github.com/Sealkaspa/kasseal-sdk/actions/workflows/sdk-release.yml)
[![license: MIT](https://img.shields.io/npm/l/@kassealhq/sdk)](LICENSE)

Source of [`@kassealhq/sdk`](https://www.npmjs.com/package/@kassealhq/sdk), the TypeScript SDK for **Kasseal**, the
KCC-20 token launchpad on Kaspa L1: quotes, transaction builders for curve trades, pool swaps and liquidity, fee
payouts, launch-proof verification, submission helpers and wallet adapters.

To use the SDK, install it from npm and read the package documentation. Every release is published from this
repository's workflow with npm provenance, which links the package to the exact commit and build:

```sh
npm install @kassealhq/sdk
```

- [Package README](packages/kasseal-sdk/README.md): entry points, rules every integrator must follow, quickstart
- [Documentation](packages/kasseal-sdk/docs/): concepts, API, errors, launch proof, wallets, trading bots, routers
- [Examples](packages/kasseal-sdk/examples/)
- [Changelog](packages/kasseal-sdk/CHANGELOG.md), [stability policy](packages/kasseal-sdk/STABILITY.md),
  [security policy](packages/kasseal-sdk/SECURITY.md)

## Repository layout

The package is bundled from a few workspace packages, kept at their own paths so their imports resolve unchanged:

| Path | Contents |
|---|---|
| `packages/kasseal-sdk` | The published package: entry points (`src/`), build and release scripts, tests, docs, examples |
| `packages/txbuilder/src` | Transaction builder: programs, sigscripts, mass and fees, shapes, selection, submission, wallets |
| `packages/codec/src` | Cell states, programs, the KCC-20 token, KCC-23 declarations, hashes |
| `packages/curve-math/src` | Exact bigint arithmetic for the curve, graduation and the pool |
| `packages/api-types/src` | Types of the public Kasseal API |
| `packages/sdk` | The pinned rusty-kaspa v2.1.0 WASM SDK (Node and web builds) with its SHA-256 sums |
| `packages/contracts` | The compiled contract artifacts of the two bundled builds, `v1-kasseal-mainnet-2` and `v1-kasseal-mainnet-2-tn10` |
| `packages/codec/fixtures` | The compiled KCC-20 reference token program |

Only the workspace packages' sources that the published package is built from are here.

## Build and check

Node 22.18 or later and pnpm 9.

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run release:check
```

`release:check` builds `packages/kasseal-sdk/dist`, packs the tarball npm would publish and checks it: the file list,
licences, the artifact manifest (every SHA-256 and template hash recomputed), the Kaspa SDK digests, the exports and
declarations from a consumer project, a leak scan of the tarball and of this repository, byte parity of built
transactions between the packed package and the builder loaded from source, and the package tests.

Releases are published from CI (`.github/workflows/sdk-release.yml`) with npm provenance, on a tag `sdk-v<version>`
that matches the package version.

## Licence

MIT, see [LICENSE](LICENSE). Third-party components and their licences: [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
