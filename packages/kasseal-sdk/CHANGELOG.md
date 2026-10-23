# Changelog

All notable changes to `@kassealhq/sdk`. The versioning rules are in [STABILITY.md](STABILITY.md).

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
