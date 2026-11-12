# Changelog

All notable changes to `@kassealhq/sdk`. The versioning rules are in [STABILITY.md](STABILITY.md).

## 1.0.0

The first stable release: the public API is frozen under semantic versioning, as set out in
[STABILITY.md](STABILITY.md).

**Upgrading from 0.3.x**

- Nothing breaks. Every 0.3.0 export is still exported with the same name, every 0.3.0 call keeps its parameters,
  and a build without the new options produces the same transaction, byte for byte, as 0.3.0.
- The string unions that describe a built transaction (`OutputRole`, `InputCellKind`, `SignatureKind`) have new
  members. Code that switches over them exhaustively should keep a default branch.

**Wallet partner tag**

- Trade builds take an optional wallet partner tag: `partner: { partner, channel }` on `buildBuy`, `buildSell`,
  `buildSwap` and `buildScriptSell`, and `partnerTag` on the synchronous shapes `buildBuy`, `buildSell`,
  `buildSwapKasForTokens` and `buildSwapTokensForKas`. A wallet that embeds Kasseal trades in its own app passes its
  partner id and channel 3 (`embedded`). See [docs/partner-tag.md](docs/partner-tag.md).
- With a tag, the transaction's payload is the 6-byte tag (`4B 53 01`, partner id u16 big-endian, channel u8) and the
  network fee covers its 6 bytes. Without one, the payload stays empty and every build is byte for byte as before.
- New exports: `PARTNER_IDS`, `PARTNER_CHANNELS`, `encodePartnerTag`, `decodePartnerTag`, `decodePartnerTagHex`,
  `isPartnerId`, `isPartnerChannel`, `tradePayload`, the format constants (`PARTNER_TAG_BYTES`, `PARTNER_TAG_VERSION`,
  `PARTNER_TAG_MAGIC_0`, `PARTNER_TAG_MAGIC_1`) and the types `PartnerTag`, `PartnerId`, `PartnerChannel`, `PartnerKey`,
  `PartnerChannelKey`, `PartnerOptions`.
- Partners at release: KasWare (1), Kaspire (2), Kastle (3, reserved) and BraidSwap (1000, the first app partner;
  its tag is `4B 53 01 03 E8 03`).
- New guide for wallets, [docs/partner-tag.md](docs/partner-tag.md), and example `examples/partner-tag.ts`.
- No change to the contract builds, their artifacts or any other builder.

**Token locks**

- The token-lock build is bundled: the lock program (`LOCK_H` `9f4eb229…0ac9`) and its factory (`FACTORY_H`
  `481065e0…8f6b`), one build for mainnet and testnet-10, each file checked against its pinned SHA-256 at load
  (`artifactManifest.lock`, `lockArtifactPaths`). The web entries load it as one chunk on first use.
- Read and verify: `loadLockSet`, `lockProgramKind` (template-hash recognition, state left out), `decodeLockState`,
  `encodeLockState`, `lockStateOfProgram`, `lockCellOf`, `lockTokenCellProblem`, `lockStateProblem`, and the
  schedule: `lockVestedAt`, `lockClaimableAt`, `lockNextUnlock`, `lockSchedule`, `lockAmountAt`, `lockDueAt`,
  `lockRemaining`, `lockEndOf`, `lockEndCapOf`, `lockDeposit`.
- Create: `buildLockPrep` (the creator's factory cell) and `buildLockCreate` (the lock, its token cell, the creator's
  rest), with `lockFactoryAddressOf` and `lockFactoryCellsOf` for factory cells an earlier prep left unspent. Claim:
  `buildLockClaim` (anyone, no signature). Checks of a serialised create or claim: `checkLockCreateTx`,
  `checkLockClaimTx`. The transactions are byte for byte the ones Kasseal's app builds.
- Kasseal's lock rules (`assertLockAppRules`; at least 0.05 % of the supply, 7 days to 2 years, at most 100
  releases, no back-dated schedule) apply in the builders; `lockMinDurationMsOf(network)` gives 7 days on mainnet and
  10 minutes on testnet-10 for `minDurationMs`. The README separates them from what the contracts enforce.
- New error codes: `LOCK_REFUSED` (`LockRefused`), `LOCK_CLAIM_NOT_DUE` (`LockClaimNotDue`), `LOCK_RULE`
  (`LockRuleViolation`).
- The type declarations no longer name output roles and input kinds of contracts the package does not ship.

**Many heads in one request**

- `fetchCurveHeads({ baseUrl, cells?, pool?, attempts?, fetch? }, ids)` reads the curve heads of many tokens through
  `GET /v1/tokens/heads`, `CURVE_HEADS_MAX` (50) per request, in the order asked. A graduated token carries its pool's
  state (`pool`, on by default) and a token that cannot be served its own `error`. A 429 or 503 is waited out as in
  `createApiSources`. For routers, aggregators and portfolios that price many tokens: one request in place of one per
  token. New exports: `fetchCurveHeads`, `CURVE_HEADS_MAX`, and the types `CurveHeadsOptions` and `CurveHeadsItem`.

## 0.3.0

**The creator window (new contract builds)**

- New launch builds `v1-kasseal-mainnet-3` (mainnet) and `v1-kasseal-mainnet-3-tn10` (testnet-10). Their curve's `buy`
  has the creator window: on a curve nothing has traded on, only a buy funded by the token's creator is valid until
  the curve is 200 DAA (about 20 seconds) old. The creator's own first buy is therefore always first; after the first
  trade, buys are unrestricted. The pool program is the same file as in the earlier builds, byte for byte.
- Both builds of each network are bundled: tokens launched before keep trading on `v1-kasseal-mainnet-2` and
  `v1-kasseal-mainnet-2-tn10`. The builders recognise a token's build from its curve or pool program, as before.
- `buildBuy` sets the curve input's sequence to `CREATOR_WINDOW_DAA` (200) when the window applies to the buyer
  (`curveBuySequence`; the creator, read from the first funding input, needs none). A buy submitted inside the window
  is refused by the node and can be sent again once the window has passed.

**API**

- `BUILD_OF_NETWORK` now names each network's launch build (`v1-kasseal-mainnet-3`, `v1-kasseal-mainnet-3-tn10`).
  New `BUILDS_OF_NETWORK` lists every build of a network, launch build first; `SUPPORTED_BUILDS` lists all four.
- `createContext(preset, network, 'v1', build)` accepts either build of the network; the default is the launch build.
  `createTxBuilder` accepts contexts of either.
- New exports: `CREATOR_WINDOW_DAA`, `hasCreatorWindow`, `curveBuySequence`, `fundedByCreator`,
  `V1_CREATOR_WINDOW_REVISION`, `V1_CREATOR_WINDOW_TWIN_REVISION`.
- The per-network browser entries load both builds of their network and add `WEB_BUILDS`; `WEB_BUILD` is the launch
  build.

**What to do**

- Code that compared `BUILD_OF_NETWORK` or `WEB_BUILD` with a token's build: use `BUILDS_OF_NETWORK` / `WEB_BUILDS`.
- Code that builds its own curve buys without `buildBuy`: set the curve input's sequence as `curveBuySequence` returns.

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
