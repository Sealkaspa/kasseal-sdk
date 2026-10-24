# Changelog

All notable changes to `@kassealhq/sdk`. The versioning rules are in [STABILITY.md](STABILITY.md).

## 0.2.0

**Entry points**

- New per-network browser entries, `@kassealhq/sdk/web/mainnet` and `@kassealhq/sdk/web/testnet-10`. Each has the
  same exports as `@kassealhq/sdk/web`, plus `WEB_NETWORK` and `WEB_BUILD`, and its import graph reaches only its own
  network's contract artifact chunks. A bundler or extension packager that ships every file reachable by import now
  ships one build (about 3.9 MB reachable from the entry, Kaspa `kaspa.js` included, WASM not) instead of both
  (about 6.8 MB). Their `initWeb` takes the network as optional and refuses any other one (`UNSUPPORTED_NETWORK`).
- `@kassealhq/sdk/web` is unchanged: same exports, same behaviour, still able to load either network. All web entries
  share one state, so a page still runs one Kaspa SDK and one network.
- No change to the contract builds, their artifacts, the builders or the Node and root entries.

**Smaller browser artifacts**

- Each curve preset chunk of `@kassealhq/sdk/web` is now a patch against one curve template
  per build, 0.3 to 1.8 KB instead of about 42 KB (web artifact chunks of both builds: 5.8 MB to 0.42 MB). The SDK
  rebuilds the exact artifact files from template and patch and checks them against the same pinned SHA-256 digests
  as before. The contract builds, their files under `dist/artifacts/`, the manifest, the Node entry and the API are
  unchanged. See [docs/contract-artifacts.md](docs/contract-artifacts.md#how-the-browser-build-stores-the-curve-programs).

**Your own Kaspa SDK**

- `initWeb` takes an optional `kaspa: { module, wasm?, sha256? }`: your own rusty-kaspa v2.1.0 web build (its bindings
  module and WASM) instead of the bundled one, for apps such as wallets that already ship it. It is installed only
  after it reports 2.1.0, exposes the API the builders use and passes a known-answer test against the pinned build
  (transactions with a genesis group and covenant bindings, txids, serialisation, sighashes, signatures with a public
  test key, finalize); `sha256`, when given, is checked against your WASM bytes first. A refusal is the new
  `SdkCompatibilityError` (`SDK_INCOMPATIBLE`) and installs nothing. Without the option `initWeb` is unchanged.
- New exports: `SdkCompatibilityError`; types `KaspaSdkOption` and `WasmSource` (web entries).
- New lite browser entries for apps that ship their own Kaspa SDK, `@kassealhq/sdk/web-lite/mainnet` and
  `@kassealhq/sdk/web-lite/testnet-10`: the API of the per-network entry without the bundled Kaspa SDK (no
  `webWasmUrl`, `WEB_WASM_SHA256`, `WEB_JS_SHA256`). Their import graph reaches neither `kaspa.js` nor
  `kaspa_bg.wasm`: about 0.65 MB in all, instead of about 1.2 MB of JavaScript plus the 11.5 MB WASM. Their `initWeb`
  requires the `kaspa` option.

## 0.1.1

Kasseal is live on Kaspa mainnet.

- `API_BASE_URLS` now lists mainnet, `https://app.kasseal.com/v1`. Testnet-10 moved to
  `https://testnet.kasseal.com/v1`; the old testnet address now serves mainnet, so update a testnet integration that
  hard-coded it.
- The examples and docs use the new addresses. No change to the contract builds, the builders or the API types.

## 0.1.0

The first public release.

**Contract builds**

- Bundles two frozen builds, with SHA-256 checks on every artifact at load: `v1-kasseal-mainnet-2` (mainnet) and its
  testnet-10 build `v1-kasseal-mainnet-2-tn10`. Pool swaps of both are composable. See
  [docs/contract-artifacts.md](docs/contract-artifacts.md).
- Bundles the Kaspa WASM SDK (rusty-kaspa v2.1.0), checked against pinned SHA-256 values before it loads.

**Entry points**

- `@kassealhq/sdk`: pure logic with no side effects on import.
- `@kassealhq/sdk/node` and `@kassealhq/sdk/web`: everything, with the WASM and the artifacts.

**Features**

- Quote math for the bonding curve, the pool, liquidity and slippage, matching the contracts exactly.
- Builders for curve buys and sells, pool swaps (including swap-and-deposit, script-owned sells and two-cell
  sells), adding and removing liquidity, fee payouts, and splitting and merging token cells.
- Safe defaults: a buy or deposit requires a `bound` launch proof; trades can be held to the curve and pool the proof
  names; swap-and-deposit and script sells accept only key-locked scripts unless `allowAnyScript` is set, and never a
  pool or token program; all-in and net-out bounds include deposits and network fees; the fee rate from the API is
  bounded.
- Launch-proof verification (nine steps, `verifyLaunchProofJson`), and the graduation check against the public Kaspa
  API (`graduationOnChain`).
- Submission helpers: transaction status, a retry policy that never trades twice (its time budget pauses while a
  wallet window is open), fee-bump replacement.
- Wallet adapters for KasWare, Kastle and Kaspire. KasWare and Kaspire can ask the wallet to switch network
  (`switchNetwork`), and Kaspire reconnects on page load without opening its unlock window.
- Typed errors with stable codes.
- API types for the public Kasseal REST API, and `createApiSources`, the builder's UTXO sources over that API.
