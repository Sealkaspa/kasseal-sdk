# Trading bots

For bots and other programs that trade Kasseal tokens on the curve or the pool. Read [concepts.md](concepts.md) first
for the vocabulary, and the rules in the [README](../README.md#rules-every-integrator-must-follow).

## 1. Before you trade a token

1. Fetch `GET /tokens/{T}/launch-proof` and verify it yourself (`verifyLaunchProofJson`, see
   [launch-proof.md](launch-proof.md)). **Refuse the token unless the verdict is `bound`.** `unverified` means a
   transaction was missing and nothing is proven; `invalid` means a step failed.
2. Take the curve id `C`, the constants `params` and, once graduated, the pool id `graduation.P` from the verified
   proof. Pass them to the builder as `expectedCurveId` / `expectedPoolId`, with `tokenId: T`. The builder then
   refuses any curve or pool the API serves that is not the proven one (`CurveNotOfProof`, `PoolNotOfProof`,
   `LineageMismatch`).
3. Recognise the build. Check `params.poolH` and `params.treasurySpk` against
   [contract-artifacts.md](contract-artifacts.md); refuse a `poolH` you do not know. Do not match the curve's template
   hash: the creator's key is a constant of the curve program, so every creator's curve has its own hash. The SDK
   does this match for you when it verifies the proof.
4. Pass the verdict to the builder (`proofVerdict: 'bound'`). Buys, pool buys and deposits are refused without it
   (`ProofNotBound`). Sells and withdrawals are never gated: a holder can always leave.

## 2. Units

- **Decimals are 0.** Token amounts are whole tokens, on chain and in the API.
- On every cell the API serves, the top-level `amount` is the UTXO's **KAS value in sompi**. `state.amount` is the
  token count.
- **Curve trades are in lots.** `params.lot` is 1,000 tokens on most tokens (10,000 on tokens launched at high KAS
  prices). `buy(n)` and `sell(n)` count lots.
- **Pool KAS amounts are in units of 0.01 KAS** (`kasScaled`, `feeAccruedScaled`; 1 unit = 1,000,000 sompi). A pool
  KAS leg is a whole number of units: `poolLegForKas(sompi)` rounds down.

## 3. Quoting

All quote functions are pure, in the package root, and compute exactly what the contracts compute.

| Need | Function |
|---|---|
| Curve buy or sell of `n` lots at `lotsSold` | `buyQuote(params, lotsSold, n)`, `sellQuote(params, lotsSold, n)` |
| Most lots a KAS budget buys | `lotsForKas(curve, lotsSold, budget)`, `buyForKas(...)` |
| Smallest sell the curve accepts | `minSellLots(curve, lotsSold)` |
| Pool buy or sell | `swapKasForTokens(state, kasInScaled, 'uncapped', 'nearest')`, `swapTokensForKas(state, tokensIn, 'uncapped', 'nearest')` |
| Liquidity | `lpDeposit(shares, state, 'uncapped')`, `lpWithdraw(shares, state, 'uncapped')`, `sharesForKas`, `minDepositShares`, `maxDepositShares` (pass `'uncapped'`: every current pool uses it) |
| Slippage bounds | `maxWithSlippage(total, bps)`, `minWithSlippage(total, bps)` (at most 10 %) |

A quote throws where the contract would refuse (for example `SellPayoutTooSmallError` and `PoolPayoutTooSmallError`
below the 0.1 KAS payout minimum). The full list of pool refusals is in
[dex-and-routers.md](dex-and-routers.md#4-swaps-the-pool-refuses).

Size a trade from the curve program, not from the API's `params`: `builder.curveParams({ covenantId: C })` reads the
constants out of the served program itself.

## 4. Reading state

| Need | Route | Notes |
|---|---|---|
| Curve head and its supply and reserve cells | `GET /tokens/{T}/curve-head?cells=1` | One consistent read. `cells` is absent when the two did not agree within a few re-reads: read again. `410 curve-closed` once graduated |
| Curve-owned or pool-owned token cells | `GET /tokens/{T}/covenant-cells` | Bonding: `supply` and `reserve` (owned by C). Graduated: `reserve` (owned by P). `strays`: other cells sent to the covenant |
| Pool cell | `GET /pools/{P}/cell` | The 139-byte pool state, decoded |
| Pool summary | `GET /pools/{P}`, `GET /pools?token={T}` | |
| Liquidity quote | `GET /pools/{P}/lp-quote?side=add\|remove&shares=N` | `409 lp-not-open` while the pool is not set up, or deposits are paused |
| Your token cells | `GET /tokens/{T}/cells?owner=pk:<x-only key hex>` | |
| Your KAS | `GET /address/{address}/utxos` | |
| Fee rate | `GET /fees` | The rate only; the SDK computes the mass |
| Transaction status | `GET /tx/{txid}` | Section 7 |

The builder reads through a `UtxoSources` object you supply. `createApiSources({ baseUrl, network, tokenId, ownKey })`
is a complete one over the REST API (it waits out `429` and `503 head-moving`, builds on the pending tip by default,
and never offers coinbase outputs as funding); you can also write your own, for example over your own Kaspa node.
Every cell a source returns is checked again by the builder: program, state, lineage and amounts. A source can make a
build fail, but it cannot make the builder sign for a different trade.

## 5. Pending trades (chained trades)

Every trade spends the one live curve or pool cell, so trades race. While trades are pending in the mempool,
`curve-head` and `pools/{P}/cell` add `tip`: the cells at the end of the chain of pending trades the API can prove.
`via` lists those transactions, oldest first, at most 8.

- **Build on `tip`** to trade at once. If a link in `via` is dropped, your transaction is refused with it and nothing
  is charged.
- **`headSpent: true`** (or `503 head-moving` on the pool cell): the head is changing hands and no bridge applies.
  Wait `retryAfterMs` and read again.
- On the stream, a `token` subscription can receive live-only `curve.tip` / `pool.tip` frames. They are never
  replayed: after a reconnect, read `curve-head` or `pools/{P}/cell` once.

**Slippage on a tip.** A curve buy names exact lots, so a changed state means a refused transaction, never a worse
fill. A pool swap carries an on-chain minimum (`minTokensOut` or `minOutScaled`). Without `minOut`, the SDK writes the
exact quote there. Pass your own minimum only if you accept less.

## 6. Building: rules that refuse a transaction

- **Pool swaps name positions.** `reserveK` is the position of the pool's reserve among the transaction's token
  inputs; `restK` / `mergedK` that of its successor among the token outputs. The SDK's shapes use buy `0, 0` and
  sell `1, 0`. Compute budget: 16 for a buy and 19 for a sell in these shapes; 23 in a composed transaction.
- **The pool does not check your token output.** It pins only its reserve and its successor. Your signature over the
  whole transaction is what fixes where your tokens and KAS go. Never deliver tokens to a cell owned `0x04` by the
  token's own id (anyone can spend it) or by the pool's id (locked for good). The SDK's builders never create either.
- **Sell only cells your key owns.** A curve sell, a pool sell, and adding or removing liquidity refuse a seller's
  cell owned `0x03` by the script of the curve or pool cell the transaction spends, or of the reserve, supply or
  inventory cell it consumes. Cells sent to a contract address show up as `strays`; they are not yours to sell.
- **A curve sell takes one exact cell.** `sell(n)` needs one cell holding exactly `n` lots. The builder throws
  `NeedsSplit` or `NeedsConsolidation` and says what to do; `buildSplit` and `buildConsolidate` build those steps,
  and `buildExactCell` plans the whole chain. A sell must pay at least 0.1 KAS net.
- **A pool sell** takes one exact cell too, or two of your cells with `extraCell`.
- **LP shares are tied to their pool.** Every LP-share cell carries its pool id as its KCC-20 extension commitment.
  Keep it when you transfer shares, or they become worthless at the pool.
- **Signature scripts are not canonical.** No signature covers the signature script of a curve or pool input, and
  the transaction id does not include signature scripts. Anyone relaying your transaction can re-encode those pushes
  without changing its id. Key your records on the txid and outpoints, never on signature-script bytes, on a hash of
  the whole serialized transaction, or on its relayed size or mass.

## 7. Signing, submitting and following a transaction

**Signing.** `built.inputsToSign` lists the only inputs you sign, all `SIGHASH_ALL`.

- `signBuiltWithKey(built, key)` signs with a local key. In 0.1.0 it signs plain KAS inputs only (`kind: 'p2pk'`),
  which covers curve buys, pool buys and fee payouts. It refuses any other slot.
- A sell spends your token cell, a P2SH input (`kind: 'p2sh-leader'` or `'p2sh-delegator'`). Sign it through a wallet
  adapter (`signBuilt(wallet, built)`, see [wallets.md](wallets.md)), or with your own signer behind the same
  interface: for each slot, a 64-byte BIP-340 Schnorr signature over `sighashOfTxJson(built.txJson, index)` followed
  by the sighash byte `0x01`, written at the slot's `signatureOffset` in that input's signature script. Then pass the
  signed SafeJSON to `builder.finalize(built, signedJson)`.
- `finalize` (and `signBuilt`) accept the result only if the transaction id is unchanged, every input you were not
  asked to sign is byte for byte the same, every signature is `SIGHASH_ALL` and verifies, and the masses match the
  built ones (`FinalizeError` otherwise).

**Submitting.** `POST /tx` with `{ "txJson": "<signed SafeJSON>" }`.

- It relays a transaction that touches a lineage the indexer tracks (a Kasseal curve, pool or token, or an output of
  a transaction relayed in the last 15 minutes); anything else is `403`.
- `200`: in the mempool. `409`: the node refused it; the body classifies why.
- You may submit to your own Kaspa node instead. Kasseal's indexer records every accepted transaction, wherever it
  was sent.

**Following.** `GET /tx/{txid}`, or the stream's `tx` channel (`{op:'sub', ch:'tx', txid}`):

| `kind` | Meaning |
|---|---|
| `submitted` | In the mempool, or seen in a block and not yet accepted |
| `accepted` | Accepted by the network (`acceptingBlueScore`) |
| `confirmed` | Accepted, at least 10 blue score deep (`depth`) |
| `dropped` | Seen, not accepted, and gone from the mempool for two minutes: it did not go through (a conflicting spend won). Not final: a reorganisation could still accept it |
| `lost-race` | Another transaction spent the same cell first. Nothing was charged |
| `fee-too-low`, `budget-too-low`, `already-in-mempool`, `script-failed` | Node refusals, classified |

While the node is unhealthy (not synced, unreachable, or its sink stalled for 10 s), nothing reads `confirmed`. The
stream's `sink` frame, about once a second, carries the node's blue score so you can count depth without polling.

**Retrying without trading twice.**

1. If a submission answer is lost, do not build a new trade. Ask `GET /tx/{txid}` first.
2. If the transaction is `submitted`, `accepted` or `confirmed`, it is in flight: wait.
3. If you rebuild, rebuild on **the same wallet coins**: create the builder with
   `fundingOptions: { required: new Set(['<txid>:<index>', ...]) }`, listing the plain KAS inputs of the first
   attempt (`walletInputsOf` in the examples). For a sell, sell the same token cell. The two attempts then conflict,
   so at most one goes through. `PinnedFundingGone` means a pinned coin is gone: the first attempt may have landed.
   Stop and ask again.
4. `lost-race` and `dropped` cost nothing. Read the new state, quote again, and rebuild.

The SDK's `RetryPolicy` and `runSubmission` implement this loop with a time budget, back-off and a re-quote check
(`withinSlippage`).

## 8. Limits and access

**Rate limits**, per client IP (an IPv6 /64 counts as one), as token buckets with three seconds of burst:

| Requests | Limit |
|---|---|
| The trade loop: `curve-head`, `covenant-cells`, `cells`, `quote`, `pools/{P}`, `pools/{P}/cell`, `lp-quote`, `fees`, `tx/{txid}` | 200 per second |
| Other reads | 60 per second |
| `address/{a}/utxos` | 20 per second |
| `search`, `address/{a}/kns` | 10 per second |
| `POST /tx` | 20 per second, 4 in flight, plus 16 more in flight for transactions that spend a curve or pool head |
| Stream | 16 sockets per client, 32 subscriptions per socket, 10 client messages per second |

A refusal is `429` with `Retry-After` (seconds) and `retryAfterMs` in the body. Back off for at least that long, with
jitter. If you need more from fixed server IPs, contact Kasseal.

**Origin.** Send no `Origin` header from a server: every read, `POST /tx` and the stream work without one. A request
that carries an `Origin` is held to the browser rules (CORS for Kasseal's own origins only).

**Errors.** RFC 9457 problem details: `{ "type": "urn:kasseal:problem:<code>", "title", "status", "detail" }`, plus
`retryAfterMs` on 429 and 503. Codes a bot meets: `bad-request` (400), `not-found` (404), `curve-closed` (410),
`lp-not-open` and `pool-group-integrity` (409), `too-many-requests` (429), `head-moving` (503). See [api.md](api.md).
