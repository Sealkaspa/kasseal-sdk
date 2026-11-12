# Stability and versioning

`@kassealhq/sdk` follows [semantic versioning](https://semver.org). From version 1.0.0 the public API described
below is frozen under the usual rules:

| Release | May contain |
|---|---|
| Patch (`1.0.0` → `1.0.1`) | Bug fixes, security fixes and documentation. No change to the public API, and no change to the bytes of any transaction a builder produces for the same inputs, unless the old bytes were wrong |
| Minor (`1.0.x` → `1.1.0`) | New features that add to the API without breaking it: new exports, new optional parameters and result fields, new contract builds, newly assigned partner ids. Existing calls keep working and, for the same inputs, keep producing the same bytes |
| Major (`1.x` → `2.0.0`) | Breaking changes to the API. Every breaking change is listed in the [CHANGELOG](CHANGELOG.md) with what to do |

Depend on `^1.0.0` to receive fixes and additive features, or pin a minor version (`~1.0.0`) if you want only fixes.

**Safety fixes come first.** If a release fixes a way your users could lose funds, we may tighten a check in a patch
release, so that a call which used to succeed now throws. A stricter check is never loosened in a patch. Versions
with a safety issue are marked deprecated on npm, with the reason.

## What is stable in 1.x

These change only in a major release, listed in the CHANGELOG; additions to them come in minor releases:

- **Quote math**: the results of the curve, pool, liquidity and slippage functions. They mirror the contracts
  exactly; a contract build never changes, so for a given build the numbers never change either.
- **Error codes**: the `code` string of every error class in [docs/errors.md](docs/errors.md). A code is never reused
  for a different meaning. New codes may be added in a minor release.
- **The launch-proof verdicts**: `bound`, `unverified`, `invalid`, `malformed`, and what each means.
- **The bundled contract builds**: `v1-kasseal-mainnet-3`, `v1-kasseal-mainnet-2` and their testnet-10 builds
  `v1-kasseal-mainnet-3-tn10`, `v1-kasseal-mainnet-2-tn10`, the token-lock build (lock and factory, one build for both
  networks), their artifacts and their hashes. A new contract build is added in a minor release; a bundled build is
  never modified or removed in 1.x.
- **The wallet partner tag**: format version 1, 6 bytes (`4B 53 01`, partner id u16 big-endian, channel u8; see
  [docs/partner-tag.md](docs/partner-tag.md)), the channels 1, 2 and 3, and every assigned partner id. An id or a
  channel is never reused for a different meaning. A new format would get a new version byte and would not replace
  version 1 in 1.x.
- **Token lock builders**: `buildLockPrep`, `buildLockCreate`, `buildLockClaim`, the checks `checkLockCreateTx` and
  `checkLockClaimTx`, the schedule maths and the lock state codec give the same results and the same bytes for the same
  inputs. Kasseal's own lock rules (`assertLockAppRules`) may only be loosened in a minor release, never tightened
  outside the safety policy above.
- **Entry points**: `@kassealhq/sdk`, `@kassealhq/sdk/node`, `@kassealhq/sdk/web`, `@kassealhq/sdk/web/mainnet`,
  `@kassealhq/sdk/web/testnet-10`, `@kassealhq/sdk/web-lite/mainnet`, `@kassealhq/sdk/web-lite/testnet-10`.
- **The exported builders, quotes, codecs and wallet adapters**: their names, parameters and result shapes.

## What may change in a minor release

- New optional parameters and result fields, and new members of the string unions that describe transactions
  (output roles, input kinds, signature kinds). Code that switches over such a union should keep a default branch.
- Wallet adapter details that follow the wallets themselves, as long as the adapter interface stays the same.
- The pinned Kaspa WASM SDK version, when a compatible upstream release is needed.
- Helpers marked experimental in their documentation.

## What the SDK does not control

- **The contracts on chain.** A launched token keeps its contract build for life. New launches may move to a new
  build; the SDK will support both, and the CHANGELOG will say so before it happens.
- **The Kasseal API.** Its `/v1` routes are additive: new fields are not breaking, and a breaking change ships as
  `/v2`.
- **Kaspa itself.** Network upgrades can change fees or mass rules; such changes ship in a release as soon as they are
  known.
