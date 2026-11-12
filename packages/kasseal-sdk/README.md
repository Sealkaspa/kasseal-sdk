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
- **Token locks**: decode and verify a lock, compute what it releases and when, build its creation and its claims.
- **Submission helpers** for the races every UTXO venue has: build on the pending tip, retry without trading twice.
- **Wallet adapters** for KasWare, Kastle and Kaspire.
- **API types** for the public Kasseal REST API.

Version 1.0 is the first stable release: its public API follows semantic versioning, as set out in
[STABILITY.md](STABILITY.md).

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

| Network | Network id | API base URL | Contract builds | Status |
|---|---|---|---|---|
| Kaspa mainnet | `mainnet` | `https://app.kasseal.com/v1` | `v1-kasseal-mainnet-3` (new launches), `v1-kasseal-mainnet-2` | Live |
| Kaspa testnet-10 | `testnet-10` | `https://testnet.kasseal.com/v1` | `v1-kasseal-mainnet-3-tn10` (new launches), `v1-kasseal-mainnet-2-tn10` | Live |

A token keeps the build it was launched on, and the SDK trades both: it recognises a token's build from its curve or
pool program. The two builds share one pool program; the newer curve adds the creator window (below). Each testnet
build mirrors its mainnet build: the same contract sources, with Kasseal's testnet wallet as the fee recipient.

### The creator window

On a curve of `v1-kasseal-mainnet-3` that nothing has traded on yet, only a buy funded by the token's creator (the
transaction's first funding input pays from the creator's key) is valid until the curve is 200 DAA (about 20 seconds)
old. Anyone else's first buy must carry that age on its curve input, and the network holds it back until then. Once
anything has traded, buys are unrestricted. The builders do this for you: `buildBuy` sets the curve input's sequence
to `CREATOR_WINDOW_DAA` when the window applies (`curveBuySequence`); a submit inside the window is refused by the
node and can be sent again once the window has passed. `hasCreatorWindow(ctx.curve)` tells whether a curve has it. Template hashes for both are in [docs/contract-artifacts.md](docs/contract-artifacts.md).

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

## Wallets: adding your partner tag

Wallet partners' trades are recognised by a 6-byte partner tag in the transaction's payload: `4B 53 01`, the partner
id (u16, big-endian), the channel (u8). Tagged trades are credited to the partner under its partner agreement with
Kasseal. Partner ids are assigned by Kasseal.

- **Connected trades** (channel 1, extension; channel 2, WalletConnect): the Kasseal website adds the tag. The wallet
  only has to sign the transaction with its payload unchanged; it must never strip or rewrite the payload.
- **In-wallet trades** (channel 3): a swap inside the wallet's own app adds the tag itself. Pass `partner` to
  `buildBuy`, `buildSell`, `buildSwap` or `buildScriptSell` (or `partnerTag` to the synchronous shapes):

```ts
import { encodePartnerTag, decodePartnerTagHex, type PartnerTag } from '@kassealhq/sdk/web';

const partner: PartnerTag = { partner: 1, channel: 3 };                 // your id, channel 3 (in-wallet)
const built = await builder.buildSwap({ ...swap, partner });           // `swap`: the quickstart's parameters
decodePartnerTagHex(JSON.parse(built.txJson).payload);                  // { partner: 1, channel: 3 }
encodePartnerTag(partner);                                              // the 6 bytes, for your own builds
```

The full guide, with every builder, the hand-built payload and the checks, is
[docs/partner-tag.md](docs/partner-tag.md).

## Token locks

A token lock holds KCC-20 tokens (or LP shares) for a fixed beneficiary and releases them on a fixed schedule. It is
two covenants: the **lock** (lineage K, one per lock) and a stateless **lock factory** that creates it. One lock build
serves mainnet and testnet-10 alike; it is bundled with the SDK and checked against its pinned SHA-256 like the trade
builds.

- **State** (140 bytes at offset 1): the token's covenant id, the beneficiary (a Schnorr key, scheme `0x00`, or a
  script hash, scheme `0x03`), `total`, `claimed` (releases paid), `start`, `cliff`, `period` (Unix ms), `tranches`
  N (1 to 100), `version` and `endCap`.
- **Schedule.** Release k is due at `max(cliff, start + k × period)`. Tokens released by the first k releases:
  `floor(k × total / N)`, so the remainder is spread one token at a time. The last release is due at
  `lockEndOf(state)`.
- **Deposit.** The lock holds exactly `N × 1.2 KAS + 1 KAS` (`lockDeposit(N)`): each release pays 1 KAS with the
  tokens to the beneficiary and up to 0.2 KAS of network fee; the final release pays what is left to the beneficiary.
  The lock's token cell carries 1 KAS more.

**Read and verify.** `await loadLockSet()` gives the build (it loads the lock chunk on demand in the web entries).
`lockProgramKind(set, program)` recognises a lock or factory program by its template hash, the state left out.
`lockCellOf(set, cell)` re-derives a served lock cell from its own redeem script (template, well-formed state, K);
`lockClaimableAt`, `lockNextUnlock`, `lockSchedule`, `lockVestedAt`, `lockRemaining` and `lockEndOf` compute the
schedule exactly as the contract does. A covenant id is a Kasseal lock only if its genesis was authorised by a
factory program through its `create` entry; the lock program alone does not prove that
([explorers.md](docs/explorers.md)).

**Create.** Two transactions, built together before either is signed (a txid does not depend on signatures):

1. `buildLockPrep` funds the creator's factory cell (0.2 KAS) from the creator's KAS, with change back to the creator.
2. `buildLockCreate` spends that factory cell, 1 to 3 of the creator's token cells and the prep's change into the
   lock, the lock's token cell, the creator's rest (if any) and change. Send it once the prep is accepted.

The creator must be a Schnorr P2PK address: the factory binds the creation to an input paying exactly the creator's
script. The prep signs plain KAS inputs (`signBuiltWithKey` works); the create also signs the creator's token cells,
which are P2SH slots: sign them through a wallet adapter, or with your own signer as described in
[trading-bots.md](docs/trading-bots.md#7-signing-submitting-and-following-a-transaction).

```ts
import { buildLockCreate, buildLockPrep, loadLockSet, lockMinDurationMsOf, signBuiltWithKey } from '@kassealhq/sdk/node';

const set = await loadLockSet();
const prep = buildLockPrep({ set, creator, funding: kasUtxos });              // kasUtxos: the creator's FundingUtxo[]
const change = { outpoint: { txid: prep.tx.txid, index: 1 }, amount: prep.built.outputs[1]!.value, spk: prep.built.outputs[1]!.spk, daaScore: 0n, address: creator };
const lock = buildLockCreate({
  set, creator, factory: { ...prep.factory, daaScore: 0n }, tokenCells,     // the creator's key-owned cells of the token
  beneficiary: { kind: 'p2pk', xOnly: beneficiaryKey },
  total: 1_000_000n, start: now, cliff: now, period: 30n * 86_400_000n, tranches: 4n, // four monthly releases
  funding: [change], supply, now, minDurationMs: lockMinDurationMsOf('mainnet'),
});
// lock.lockId is K. Sign and send prep.tx, then lock.tx once the prep is accepted.
```

**Claim.** Anyone may claim; only the beneficiary is paid, and a claim has no signature. `buildLockClaim` pays every
release vested at `now`, the claim's lock time in Unix ms. The network accepts a timestamp lock time only once the
chain's past median time is above it (about two minutes behind the newest block), and rejects a claim with a later
one: pass at most the past median time minus 1 (Kasseal's app uses the API's `nowMs` less 2 minutes). Nothing due
throws `LockClaimNotDue` with `nextAt`. The final claim also pays the lock's remaining KAS to the beneficiary.

```ts
import { buildLockClaim, fromHex, lockCellOf, tokenStateFromJson } from '@kassealhq/sdk/node';

const { nowMs, locks: [l] } = await (await fetch(`${API_BASE}/locks/${lockId}/cells`)).json();
const c = l.lockCell;
const lock = lockCellOf(set, { outpoint: c.outpoint, value: BigInt(c.amount), covenantId: c.covenantId, program: fromHex(c.redeemScript), daaScore: 0n });
const t = l.tokenCell;
const tCell = { kind: 'token', outpoint: t.outpoint, value: BigInt(t.amount), covenantId: t.covenantId, program: fromHex(t.redeemScript), state: tokenStateFromJson(t.state), daaScore: 0n } as const;
const claim = buildLockClaim({ set, lock, tCell, now: BigInt(nowMs) - 120_000n });
// claim.tx is complete: submit claim.tx.txJson as is.
```

Every builder re-checks its own transaction from its bytes before returning it (`checkLockCreateTx`,
`checkLockClaimTx`, also exported for transactions you did not build) and refuses with `LockRefused` (`rule` says
which). The beneficiary's `extend` (moving the schedule later) is not in this release.

**Contract rules and Kasseal's rules.** The contracts pin the state, the deposit, the lock's token cell and the
creation's layout; they know neither the token's supply nor the time of the creation. The builders add Kasseal's
rules, the ones its app offers and its indexer counts a lock as locked by:

| Rule | Contract | Builder (`buildLockCreate`, `checkLockCreateTx`) |
|---|---|---|
| Releases | 1 to 100 | the same |
| Amount | 1 to 10^18 tokens, at least one per release | at least 0.05 % of `supply`, at most `supply` |
| Shortest lock | none | the last release at least `minDurationMs` after `now`: 7 days by default (`LOCK_MIN_DURATION_MS`); `lockMinDurationMsOf('testnet-10')` is 10 minutes (`LOCK_MIN_DURATION_MS_TESTNET`) |
| Longest lock | the end at most `endCap` (end + 5 years) | the last release at most 2 years after `now` (`LOCK_MAX_DURATION_MS`) |
| Back-dated schedule | allowed | refused: the first release by the schedule (`start + period`) must be after `now` |
| Beneficiary | any 32 bytes, scheme `0x00` or `0x03` | a valid x-only key, or a script that needs a signature (`keyLockedRedeem`; `allowAnyScript` to override) |

The 7-day minimum is Kasseal's mainnet rule. For now Kasseal's app also offers 10-minute locks on mainnet, and its
indexer counts them as locked; pass `minDurationMs: LOCK_MIN_DURATION_MS_TESTNET` to build one. That is a policy
setting that may return to 7 days, not a contract rule.

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

- Contract artifacts: only the builds above and the token-lock build are bundled. `dist/artifacts/manifest.json` lists each build's
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
| [Partner tag](docs/partner-tag.md) | Wallets: adding your partner tag to the trades you build or sign |
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
