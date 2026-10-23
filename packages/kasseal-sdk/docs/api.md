# The Kasseal API

A public, read-only REST API over Kasseal's indexer, plus a WebSocket stream and a transaction relay. No key, no
account and no wallet are needed to read. The full contract is `GET /v1/openapi.yaml` (OpenAPI 3.1); the SDK's API
types mirror it.

| Network | Base URL | Stream |
|---|---|---|
| mainnet | `https://app.kasseal.com/v1` | `wss://app.kasseal.com/v1/stream` |
| testnet-10 | `https://testnet.kasseal.com/v1` | `wss://testnet.kasseal.com/v1/stream` |

The SDK never assumes a base URL: pass it explicitly.

## Format

- JSON throughout. Every large integer is a **decimal string** (sompi, token amounts, `kasScaled`). Ids and hashes are
  lowercase hex.
- On every cell, the top-level `amount` is the UTXO's KAS value in sompi; `state.amount` is the token count.
- Added fields are not breaking. A breaking change ships as `/v2`. The `/v1` in the path is the API version, unrelated
  to the contract build.
- Errors are RFC 9457 problem details (`application/problem+json`):
  `{ "type": "urn:kasseal:problem:<code>", "title", "status", "detail", "instance" }`, plus `retryAfterMs` on 429
  and 503.

## Routes integrators use

**Tokens**

| Route | Returns |
|---|---|
| `GET /tokens` | Token list: `sort` (`new`, `active`, `progress`, `holders`, `mcap`), `limit`, `cursor` |
| `GET /tokens/lookup?ids=…` | Up to 50 tokens by id |
| `GET /tokens/{id}` | One token: metadata, supply, phase, verification |
| `GET /tokens/{id}/launch-proof` | The launch proof ([launch-proof.md](launch-proof.md)) |
| `GET /tokens/{id}/trades`, `/candles`, `/holders` | History and holders |
| `GET /tokens/{id}/quote` | The server's quote, for display. Build trades from your own quote |

**Curve (while bonding)**

| Route | Returns |
|---|---|
| `GET /tokens/{id}/curve-head[?cells=1]` | The live curve cell, its constants, the pending `tip`; with `cells=1` the supply and reserve cells in one consistent read. `410 curve-closed` once graduated |
| `GET /tokens/{id}/covenant-cells` | The curve-owned (or, once graduated, pool-owned) token cells, and `strays` |
| `GET /tokens/{id}/cells?owner=<key>` | Live token cells of one owner: `pk:<x-only hex>`, `script:<hash>` or `covenant:<id>` |

**Pools**

| Route | Returns |
|---|---|
| `GET /pools[?token=T]` | Pools, or the token's pool |
| `GET /pools/{P}` | Pool summary: reserves, fees accrued, liquidity status (`openLiquidity`, `lpSafe`) |
| `GET /pools/{P}/cell` | The live pool cell, decoded, with the pending `tip`. `headSpent: true` or `503 head-moving`: read again |
| `GET /pools/{P}/lp-quote?side=add\|remove&shares=N` | A liquidity quote. `409 lp-not-open` while the pool is not set up or deposits are paused |
| `GET /pools/{P}/positions[?owner=…]`, `/lp-stats`, `/reserves`, `/transactions` | Liquidity positions, statistics, history |

**Wallets and transactions**

| Route | Returns |
|---|---|
| `GET /address/{address}/utxos` | The address's spendable plain KAS UTXOs (covenant outputs and outpoints spent in the mempool left out) |
| `GET /address/{address}/tokens` | Token balances, LP positions |
| `GET /fees` | The network fee rate (sompi per gram). The SDK computes the mass and bounds the rate |
| `POST /tx` | Relay a signed transaction: `{ "txJson": "<SafeJSON>" }` |
| `GET /tx/{txid}` | The transaction's status ([trading-bots.md](trading-bots.md#7-signing-submitting-and-following-a-transaction)) |
| `GET /price/kas` | The KAS/USD price and when it was taken |
| `GET /health` | The node's sync state and the indexer's lag |

**Relay policy.** `POST /tx` relays a transaction that touches a lineage the indexer tracks (a Kasseal curve, pool or
token, or an output of a transaction relayed in the last 15 minutes); anything else is `403`. `200` means it is in
the mempool; `409` means the node refused it, with the reason classified in the body (`lost-race`, `fee-too-low`,
`budget-too-low`, `already-in-mempool`, `script-failed`). You can submit through any Kaspa node instead: the indexer
records every accepted transaction.

## The stream

`GET /v1/stream` upgrades to a WebSocket. One socket carries up to 32 subscriptions; use one socket, not one per
view.

| Client message | Effect |
|---|---|
| `{op:'sub', ch:'token', id, since?}` | A token's trades (`trade`, `trade.undo` after a reorganisation), curve and pool state (`curve.head`, `pool.state`), and the live-only `curve.tip` / `pool.tip` frames when the server sends them |
| `{op:'sub', ch:'tape', since?}` | Launches, trades and graduations across all tokens |
| `{op:'sub', ch:'tx', txid}` | `tx.status` frames for one transaction |
| `{op:'unsub', ch, id?}`, `{op:'ping'}` | |

- Every socket also receives a live-only `sink` frame about once a second: the node's blue score and the indexer's
  lag. Count confirmation depth with it instead of polling.
- Reconnect with your last `seq` (`since`) to replay what you missed. If you are more than 50,000 events behind, you
  get `resync {reason: 'gap'}` and a fresh snapshot instead.
- Live-only frames (`tip`, `sink`) are never replayed: after a reconnect, read `curve-head` or `pools/{P}/cell` once.
- While the node is unhealthy, nothing says `confirmed`. When it recovers, each affected socket receives
  `resync {reason: 'confirmations'}` and a fresh snapshot.
- A socket whose send buffer exceeds 256 frames or 1 MB is closed with code 4001: reconnect with your last `seq`.

## Rate limits

Per client (an IPv4 address or an IPv6 /64), as token buckets with three seconds of burst:

| Requests | Limit |
|---|---|
| Trade-loop reads: `curve-head`, `covenant-cells`, `cells`, `quote`, `pools/{P}`, `pools/{P}/cell`, `lp-quote`, `fees`, `tx/{txid}` | 200 per second |
| Other reads | 60 per second |
| `address/{a}/utxos` | 20 per second |
| `search`, `address/{a}/kns` | 10 per second |
| `POST /tx` | 20 per second and 4 in flight, plus 16 more in flight for transactions that spend a curve or pool head |
| Stream connections | 16 per client |
| Stream subscriptions | 32 per socket |
| Stream client messages | 10 per second per socket (burst 64); a message past it gets `error {code: 'rate-limited'}` and is dropped |

A refusal is `429` with `Retry-After` (whole seconds) and `retryAfterMs` in the body. Back off for at least that long,
with jitter, growing on repeats. If you need more from fixed server IPs, contact Kasseal.

## Browsers and Origin

- Requests without an `Origin` header (servers, bots) are not affected by any browser rule: every read, `POST /tx`
  and the stream work without one.
- CORS answers only Kasseal's own web origins, and the stream refuses an upgrade from any other `Origin` (403). Ask
  Kasseal to allow your origin if you call the API from a web page.
- Routes whose signed message names a site (Kasseal's own sign-in, terms, comments, follows) need a Kasseal app
  `Origin`. No integrator needs them.

## Problem codes you will meet

| Status | Code | Meaning |
|---|---|---|
| 400 | `bad-request` | A malformed id, parameter or body |
| 403 | | `POST /tx` for a transaction that touches no tracked lineage, or a browser origin that is not allowed |
| 404 | `not-found` | No such token, pool or transaction |
| 409 | `lp-not-open` | Liquidity is not open on this pool (not set up, or deposits paused) |
| 409 | `pool-group-integrity` | The pool failed the graduation integrity check; do not trade it |
| 410 | `curve-closed` | The curve has graduated: trade on the pool |
| 429 | `too-many-requests` | Rate limited: wait `retryAfterMs` |
| 503 | `head-moving` | The pool's head is changing hands: wait `retryAfterMs` and read again |
