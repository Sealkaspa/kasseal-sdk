# Explorers and indexers

What an explorer needs to label Kasseal covenants and transactions, show token names and logos, and decode curve and
pool state. Everything here holds on testnet-10 today. Mainnet uses the mainnet build, whose hashes are in
[contract-artifacts.md](contract-artifacts.md).

## 1. What to label

A Kasseal token is a family of covenant lineages, all on the KCC-20 reference token program for T and L:

| Lineage | What it is | Where its id comes from |
|---|---|---|
| **T**, token | The KCC-20 token (fixed supply, 0 decimals) | `GET /tokens` (`meta.covenantId`) |
| **C**, bonding curve | The curve that sells the token | Launch proof, `C` |
| **P**, pool | The constant-product pool the token graduates into | Launch proof, `graduation.P` (once graduated) |
| **L**, LP share | The pool's liquidity-share token | Pool state `lpCovId` (`GET /pools/{P}/cell`), once the pool is set up |

Suggested labels: `Kasseal · <TICKER> token`, `Kasseal · <TICKER> bonding curve`, `Kasseal · <TICKER> pool`,
`Kasseal · <TICKER> LP share`.

Kasseal's fee recipient (the treasury) on testnet-10:
`kaspatest:qp8pqkcf0w8l3mke93eu86ngyc808x54t574a8jha96nu63x8tfn2et7nk35w`. On mainnet:
`kaspa:qrt0p8sd5g8k383mzxgqtyl7ehkdez8ds8cpxqcuwjdaayke9rjhg9pqnr3zx`.

## 2. Enumerating every Kasseal covenant

From the public API (mainnet: `https://app.kasseal.com/v1`, testnet-10: `https://testnet.kasseal.com/v1`; no key needed):

1. `GET /tokens?limit=50`, following `nextCursor`: every token id T, with `phase` (`bonding`, `graduated`, `listed`)
   and its metadata.
2. For each T: `GET /tokens/{T}/launch-proof`: C, `params`, `graduation.P` once graduated, the KCC-23 `declaration`,
   and the API's own check in `verifier.result`. **Only label tokens whose proof is `bound`.** Better: verify it
   yourself with the SDK ([launch-proof.md](launch-proof.md)).
3. For each P: `GET /pools/{P}/cell`: `state.lpCovId` is L (all zeros until the pool is set up).

New launches arrive live on the stream (`wss://app.kasseal.com/v1/stream` on mainnet, `{"op":"sub","ch":"tape"}`), or re-poll
`GET /tokens?sort=new` every minute.

## 3. Recognising Kasseal programs from chain data alone

| Program | Template hash |
|---|---|
| Token (T and L): KCC-20 reference | `9703112ee6e3555107cd168858992b77d3b74f655205b2b463b1f9ec2ec73cf7` |
| Pool, testnet-10 (`v1-kasseal-mainnet-2-tn10`) | `28170395ca9350966c0d732ffce8b13c5a94201e74552b7add67143a35dea56a` |
| Pool, mainnet (`v1-kasseal-mainnet-2`) | `92acd761504e4fa05acf70675ef1aea0c66efa2126ec5c726e4779b8aef054e0` |

**Curves have no single hash.** The creator's payout key is a constant of the curve program, so every creator's curve
has its own template hash. Identify a curve by its token's launch proof. Alternatively, match the curve program with
the creator key masked, using the bundled curve artifacts.

**A matching template is not proof.** Anyone can create a cell from the same pool program under another covenant id.
Label a pool as Kasseal's only when a token's launch proof names its id.

## 4. Decoding state

The state sits at offset 1 of each covenant's script, KCC-1 encoded. The SDK decodes both
(`decodeCurveState`, `decodePoolState`), and the API serves them decoded (`GET /tokens/{T}/curve-head`,
`GET /pools/{P}/cell`).

**Curve state (53 bytes):** `tokenCovId` (32 bytes, = T), `lotsSold` (lots of `params.lot` tokens), `feeAccrued`
(sompi of fees waiting for a sweep), `phase` (1 = active). The curve sells 800,000,000 tokens; 400,000,000 are held
back for the pool; the supply is 1,200,000,000.

**Pool state (139 bytes):** `tokenCovId` (T), `kasScaled` (the KAS reserve, in 0.01 KAS units), `tokenReserve`
(tokens), `lpShares` (shares outstanding, including the 1,000,000 locked at graduation), `lpCovId` (L, or zeros until
set up), `feeAccruedScaled` (0.01 KAS units), `creatorSpk` (the creator's payout script).

Price per token in sompi: `kasScaled × 1,000,000 / tokenReserve`. This is a display figure, not an oracle (see
[dex-and-routers.md](dex-and-routers.md)).

## 5. Transaction types

The entry point is the 4-byte dispatch tag near the end of the covenant input's signature script, before the redeem
script.

| Transaction | Tag | Label |
|---|---|---|
| Preparation: creates the curve's first cell and carries the KCC-23 declaration in its payload | (no covenant input) | Launch (1/2) |
| Curve `init`: creates the full supply in two curve-owned cells | `a651f278` | Launch (2/2) |
| Curve `buy(n, user)` | `904b34e8` | Buy on curve |
| Curve `sell(n)` | `a42ba2dd` | Sell on curve |
| Curve or pool `sweep()` | `b1f6f40b` | Fee payout (creator and Kasseal) |
| Curve `graduate(poolPrefix, poolSuffix)` | `8cbe9536` | Graduation (curve to pool) |
| Pool `bindLp(tokenPrefix, tokenSuffix)` | `e411082d` | Pool liquidity setup |
| Pool `swapKasForTokens(kasInScaled, minTokensOut, reserveK, restK)` | `855ca714` | Buy on pool |
| Pool `swapTokensForKas(tokensIn, minOutScaled, reserveK, mergedK)` | `3698a282` | Sell on pool |
| Pool `addLiquidity(shares, lpUser)` | `ec0aa00c` | Add liquidity |
| Pool `removeLiquidity(shares, tokUser)` | `85e9489a` | Remove liquidity |

**Pool swaps are composable.** Other token inputs and outputs in the same transaction belong to the user, a router or
another venue. `reserveK` is the position of the pool's reserve among the transaction's token inputs, and `restK` /
`mergedK` the position of its successor among the token outputs. Kasseal's own app uses buy `0, 0` and sell `1, 0`.
The pool's part of any swap is its own cell, its reserve and that successor. One transaction can also swap on two
pools. Kasseal's indexer attributes a routed trade by net token flow: a buy to the party that gains the most tokens,
a sell to the party that gives the most.

**Fees.** Curve trades: 1 % of the KAS leg, rounded up. Pool swaps: 0.30 %. Of the fees paid out, half goes to the
creator and half to Kasseal's treasury. The two payout outputs of a sweep or graduation carry no covenant binding.

## 6. Token names, tickers and logos

- On chain, each token's metadata is a KCC-23 declaration in the preparation transaction (`name`, `symbol`,
  `decimals`, `description`, `image`). The launch proof returns it as `declaration`.
- `GET /tokens/{T}` returns it ready to display in `meta`: `name`, `ticker`, `decimals` (always 0), `description`,
  `imageUrl`, `imageSource`.
- **Logos.** `image` is `sha256:<hex>`; the file is `/v1/images/<hex>` on the API host (PNG, JPEG or WebP, up to 1 MiB
  and 2048 px). The file name is the SHA-256 of the bytes, so you can verify it. `imageSource: "external"` is a URL
  the creator declared that Kasseal never fetches or checks.
- **Hidden tokens.** `meta.hidden: true` means Kasseal hid a token's metadata after a takedown request (empty name and
  ticker, no image). Please honour it.
- Tickers are not unique. Key by covenant id.

## 7. Limits

Reads are free and unauthenticated: 60 requests per second per IP, 200 for the live state routes. Send no `Origin`
header from a server. If you index from fixed server IPs and need more, contact Kasseal. The full API description is
`GET /v1/openapi.yaml`; see also [api.md](api.md).
