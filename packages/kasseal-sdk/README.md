# @kassealhq/sdk

The TypeScript SDK for **Kasseal**, the KCC-20 token launchpad on Kaspa L1.

Every Kasseal token starts on a **bonding curve**. When the curve sells out, the token **graduates** into a
**constant-product pool**. Anyone can add liquidity to the pool, and the pool's swaps are **composable**: a swap can
share its transaction with other contracts, such as a router or another venue's pool. All of it runs as Kaspa
covenants on L1. There is no bridge, no operator key and no off-chain order book.

The SDK gives you:

- **Quotes** that compute exactly what the contracts compute: curve buys and sells, pool swaps, liquidity, slippage.
- **Transaction builders** for curve buys and sells, pool swaps (including composable swap-and-deposit and
  script-owned sells), adding and removing liquidity, and fee payouts.
- **Launch-proof verification**, so you can prove a token, its curve and its pool are genuine before you trade.
- **Submission helpers** for the races every UTXO venue has: build on the pending tip, retry without trading twice.
- **Wallet adapters** for KasWare, Kastle and Kaspire.
- **API types** for the public Kasseal REST API.

Version 0.1.0 is a 0.x release: see [STABILITY.md](STABILITY.md) before you depend on it.

## Install

```sh
npm install @kassealhq/sdk
```

ESM only. Node 22 or later, or any modern browser through a bundler. No runtime npm dependencies.

## Entry points

| Import | Use it for | Side effects on import |
|---|---|---|
| `@kassealhq/sdk` | Pure logic: quotes, slippage, state codecs, launch-proof format, API types | None |
| `@kassealhq/sdk/node` | Everything, in Node: builders, signing, launch-proof verification | Loads the pinned Kaspa WASM SDK and the contract artifacts, each checked against its SHA-256 first |
| `@kassealhq/sdk/web` | Everything, in the browser | None until you call `initWeb`, which checks the WASM and the artifacts the same way |
| `@kassealhq/sdk/web/mainnet` | The same as `/web`, for mainnet only: bundles only the mainnet contract build | As `/web` |
| `@kassealhq/sdk/web/testnet-10` | The same as `/web`, for testnet-10 only: bundles only the testnet-10 contract build | As `/web` |

The SDK bundles rusty-kaspa's WASM SDK v2.1.0 and the compiled Kasseal contracts. Both are checked against pinned
SHA-256 hashes when they load. On any difference the SDK refuses to start (it fails closed).

Pass the network id (`'testnet-10'` or `'mainnet'`) explicitly to every call that takes one: the builder, the
launch-proof check, the wallet adapters. The SDK has no default API URL: you always say which API you read.

## Rules every integrator must follow

These rules protect your users' funds. The SDK enforces most of them by default; do not turn the checks off.

1. **Verify the launch proof before you trade.** Fetch `GET /tokens/{id}/launch-proof` and verify it yourself
   (`verifyLaunchProofJson`). Trade only when the verdict is `bound`. Pass the curve id and pool id the proof names
   to the builder (`expectedCurveId`, `expectedPoolId`): the builder then refuses any other curve or pool. Once a
   token has graduated, also confirm the graduation transaction against the public Kaspa API (`graduationOnChain`). See
   [docs/launch-proof.md](docs/launch-proof.md).
2. **Identify tokens and pools by covenant id, never by ticker or address.** Tickers are not unique. Anyone can
   create a lookalike pool from the same program under another id, and a pool's address changes with every trade.
   The covenant id is the only identity.
3. **Sign only your own inputs.** A built transaction lists the inputs you sign in `inputsToSign`, all with
   `SIGHASH_ALL`. Never sign a curve or pool input, and never sign a transaction you did not build and check. Your
   `SIGHASH_ALL` signature covers the exact curve or pool cell you spend and every output, including the one that
   pays you.
4. **Know what the contracts enforce on price.** On chain:
   - A **pool buy** is refused unless it delivers at least `minTokensOut` tokens. A **pool sell** is refused unless
     it pays at least `minOutScaled` and at least 0.1 KAS. The SDK writes your minimum there, or the exact quote if
     you give none.
   - A **curve buy or sell** has no minimum argument. The curve charges the exact price of the exact number of lots
     at the state your transaction spends. A curve sell must pay at least 0.1 KAS.
   - These minimums sit in the part of the transaction no signature covers, so whoever relays it could rewrite
     them. That cannot change your trade: your signature fixes the state you trade against and the amount you
     receive. If the state changed first, your transaction is refused and nothing is charged.
   - `maxAllIn` (buys) and `minNetOut` (sells) are checked by the SDK before you sign. They include the cell
     deposit and the network fee, which no contract checks.
5. **Build on the latest state, pending trades included.** Every trade spends the one live curve or pool cell, so
   trades race. The API serves the pending tip (`tip`) when trades are in flight; build on it. If a pending trade
   you built on is dropped, yours is refused with it and nothing is charged. Rebuild on the new state.
6. **Retry without trading twice.** If you do not know whether a submission went through, ask
   `GET /tx/{txid}` first. If you rebuild, spend the same wallet coins (`fundingOptions.required`) or, for a sell,
   the same token cell. The two attempts then conflict, so at most one can go through. Never rebuild on fresh
   coins after an unclear answer.

## Quickstart: quote and buy on a pool (testnet-10)

```ts
import { createApiSources, createTxBuilder, poolLegForKas, sdk, signBuiltWithKey, xOnlyKeyOfAddress, SOMPI_PER_KAS } from '@kassealhq/sdk/node';
import { API_BASE, NETWORK, submit, waitForOutcome } from './lib/api.ts';     // examples/lib/api.ts
import { checkLaunchProof } from './lib/proof.ts';                            // examples/lib/proof.ts

const key = new (sdk().PrivateKey)(process.env.KEY!);          // a testnet-10 key, from the environment
const address = key.toAddress(NETWORK).toString();
const xOnly = xOnlyKeyOfAddress(address);

// 1. Prove the token, its curve and its pool. Trade only on `bound`, only with the pool the proof names.
const proof = await checkLaunchProof(tokenId, NETWORK);
if (proof.status !== 'bound' || proof.poolId === undefined) throw new Error(`not tradable: ${proof.status}`);

// 2. Build on the latest pool state. 100 KAS, in whole 0.01 KAS units.
const sources = createApiSources({ baseUrl: API_BASE, network: NETWORK, tokenId, ownKey: Buffer.from(xOnly).toString('hex') });
const builder = createTxBuilder({ sources, networkId: NETWORK });
const built = await builder.buildSwap({
  poolId: proof.poolId, expectedPoolId: proof.poolId, tokenId,
  trader: address, traderXOnlyPubkey: xOnly,
  side: 'kas->tok', amountIn: poolLegForKas(100n * SOMPI_PER_KAS),
  maxAllIn: 106n * SOMPI_PER_KAS,                              // leg + 5 KAS cell deposit + network fee, at most
  proofVerdict: 'bound',
});

// 3. Sign your own inputs, submit, follow.
const signed = signBuiltWithKey(built, key);
await submit(signed.txJson);
console.log(signed.txid, (await waitForOutcome(signed.txid))?.kind);
```

The complete program, with the safe retry, is [examples/pool-buy.ts](examples/pool-buy.ts). Read-only quotes are in
[examples/quote.ts](examples/quote.ts).

## Networks

| Network | Network id | API base URL | Contract build | Status |
|---|---|---|---|---|
| Kaspa mainnet | `mainnet` | `https://app.kasseal.com/v1` | `v1-kasseal-mainnet-2` | Live |
| Kaspa testnet-10 | `testnet-10` | `https://testnet.kasseal.com/v1` | `v1-kasseal-mainnet-2-tn10` | Live |

The testnet build mirrors the mainnet build: the same contract sources, with Kasseal's testnet wallet as the fee
recipient. Template hashes for both are in [docs/contract-artifacts.md](docs/contract-artifacts.md).

## What a trade costs

| Action | Protocol fee | KAS tied up (returned later) | Network fee |
|---|---|---|---|
| Curve buy | 1 % of the KAS cost | 5 KAS deposit on the new token cell, returned when you sell it | About 0.025 KAS at the minimum fee rate |
| Curve sell | 1 % of the KAS paid out | The sold cell's deposit comes back | Similar; a sell must pay at least 0.1 KAS net |
| Pool buy | 0.30 % of the KAS leg | 5 KAS deposit on the new token cell | A fraction of a KAS |
| Pool sell | 0.30 % of the KAS paid out | The sold cell's deposit comes back | A fraction of a KAS; at least 0.1 KAS is paid out |
| Add liquidity | None | 5 KAS on the new LP-share cell (at least 2.5 KAS), returned on withdrawal | A fraction of a KAS |
| Remove liquidity | None | The LP cell's deposit comes back | A fraction of a KAS; at least 0.1 KAS is paid out |
| Fee payout (sweep) | None | None | Paid by whoever submits it; anyone can |

- **Deposits.** On Kaspa every UTXO must carry some KAS. Each token cell you receive carries a 5 KAS deposit by
  default. It is still your KAS and comes back when the cell is spent.
- **Network fees** depend on the transaction's mass and the network's fee rate. The SDK computes the fee exactly
  before you sign. It refuses a fee rate from the API above 20 times the network minimum, and it caps the total fee
  of any transaction it builds. A composed transaction that trades on two pools at once measured about 0.088 KAS on
  testnet-10.
- **Units.** Token amounts are whole tokens (0 decimals). Curve trades are in whole lots (1,000 tokens on most
  tokens, 10,000 on tokens launched at high KAS prices). Pool KAS legs are whole multiples of 0.01 KAS.

## Browser

```js
import { initWeb, ensurePresetArtifacts, createTxBuilder } from '@kassealhq/sdk/web';

await initWeb({ network: 'testnet-10' });           // fetches and checks kaspa_bg.wasm next to the module
await ensurePresetArtifacts('standard-k180');       // a curve preset's artifacts, before building on its curve
```

`initWeb` fetches the WASM from `webWasmUrl()` (a URL next to `web.js`) unless you pass `wasm` yourself (bytes, a
URL or a `Response`); the bytes are hashed against the pinned digest before they are instantiated. Contract
artifacts are code-split per curve preset (a preset chunk is under 2 KB: a patch against one shared curve template per
build, rebuilt to the exact files and checked against their pinned SHA-256); pass `preload: 'all'` to load every
preset up front. If your bundler
pre-bundles dependencies (for example Vite's `optimizeDeps`), exclude this package so the WASM URL stays next to
the module, or pass `wasm` explicitly.

`@kassealhq/sdk/web` can load either network, so its import graph names the artifact chunks of both contract builds
(about 2.9 MB each). A browser extension or any packager that ships every file reachable by import ends up with
both. If your app serves one network, import its own entry instead: it has the same exports as `/web` plus
`WEB_NETWORK` and `WEB_BUILD`, and its import graph reaches only that network's chunks.

```js
import { initWeb, ensurePresetArtifacts } from '@kassealhq/sdk/web/mainnet';   // or '@kassealhq/sdk/web/testnet-10'

await initWeb();                                     // network optional; any other network is refused (UNSUPPORTED_NETWORK)
await ensurePresetArtifacts('standard');
```

All web entries share one state: a page runs one Kaspa SDK and one network, whichever entry starts it.

**Your own Kaspa SDK build.** An app that already ships rusty-kaspa v2.1.0 (web target) can pass its own build instead
of the bundled one:

```js
import * as kaspa from './vendor/kaspa/kaspa.js';  // your bindings module (its default export is the WASM init)

await initWeb({
  network: 'mainnet',
  kaspa: {
    module: kaspa,
    wasm: new URL('./vendor/kaspa/kaspa_bg.wasm', import.meta.url), // or bytes / a Response; omit if already initialised
    sha256: '…',                                                     // optional: your WASM's own digest
  },
});
```

Before it is installed, your build must report version 2.1.0, expose every function the builders call, and pass a
known-answer test: a fixed set of transactions (a P2PK transfer with payload and change; a covenant spend with a bound
continuation, a two-output genesis group and a lock time; P2PK and P2SH scripts and addresses on both networks) is
built, serialised, signed with a public test key and finalized through the SDK's own code paths, and every txid,
serialised transaction, sighash and covenant id must equal, byte for byte, what the pinned build produced. Signatures
are randomised by the Kaspa SDK, so they are checked by verifying them against the SDK's own sighash and the key.
Any difference rejects with `SdkCompatibilityError` (`SDK_INCOMPATIBLE`, with `stage` and every `failures` line) and
nothing is installed; a `sha256` that does not match your bytes rejects with `SdkIntegrityError`. Leave out the
top-level `wasm` when you pass `kaspa`. Without `kaspa`, `initWeb` behaves exactly as before.

To leave the bundled Kaspa SDK out of your package altogether, import the lite entry of your network: the same API
without the bundled SDK, so neither `kaspa.js` nor the 11.5 MB `kaspa_bg.wasm` is reachable from it.

```js
import * as kaspa from './vendor/kaspa/kaspa.js';
import { initWeb } from '@kassealhq/sdk/web-lite/mainnet';     // or '@kassealhq/sdk/web-lite/testnet-10'

await initWeb({ kaspa: { module: kaspa, wasm: new URL('./vendor/kaspa/kaspa_bg.wasm', import.meta.url) } });
```

## Integrity

- Contract artifacts: only the two builds above are bundled. `dist/artifacts/manifest.json` lists each build's
  template hashes and the SHA-256 of every file; the same manifest is compiled into the code, and every file is
  checked before use. A missing, altered or unlisted file is refused (`ArtifactIntegrityError`).
- Kaspa WASM SDK: rusty-kaspa v2.1.0, unmodified. The Node build is hashed before it is loaded; the web WASM is
  hashed before it is instantiated (`SdkIntegrityError`). A Kaspa SDK you pass to `initWeb` yourself (`kaspa` option)
  is not held to the pinned hash: it is checked against your own `sha256` if you give one, and must pass the
  known-answer test against the pinned build before it is used (`SdkCompatibilityError`).

## Errors

Every error class the package exports carries a stable string `errorCode` (and `code`, except the wallet errors,
whose `code` is the wallet's numeric code). Use `errorCode(err)` or `isKassealError(err, 'SLIPPAGE_OUT_OF_RANGE')`
instead of matching messages. `ERROR_CODES` lists them all; [docs/errors.md](docs/errors.md) describes each one.

## Documentation

| Page | For |
|---|---|
| [Concepts](docs/concepts.md) | The curve, graduation, the pool, LP shares, locked liquidity, fees |
| [Trading bots](docs/trading-bots.md) | Reading state, building, racing, retrying, rate limits |
| [DEXs and routers](docs/dex-and-routers.md) | Composable swaps: what the pool checks, what it refuses, what you must guard |
| [Wallets](docs/wallets.md) | Showing Kasseal tokens and signing with KasWare, Kastle and Kaspire |
| [Explorers](docs/explorers.md) | Labelling Kasseal covenants and transactions, decoding state |
| [Launch proof](docs/launch-proof.md) | What the proof verifies and how to run it |
| [API](docs/api.md) | REST routes, the stream, rate limits, errors |
| [Errors](docs/errors.md) | Every typed error and its stable code |
| [Contract artifacts](docs/contract-artifacts.md) | The two builds, their template hashes, verifying the bundled files |
| [Examples](examples/README.md) | Runnable programs against testnet-10 |

Also: [STABILITY.md](STABILITY.md) (versioning), [SECURITY.md](SECURITY.md) (reporting a vulnerability),
[CHANGELOG.md](CHANGELOG.md).

## Licence

MIT. The bundled Kaspa WASM SDK (rusty-kaspa v2.1.0) is ISC licensed; its licence ships with it.
