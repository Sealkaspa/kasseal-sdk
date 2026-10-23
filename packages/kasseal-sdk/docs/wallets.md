# Wallets

Two parts: showing Kasseal tokens in a wallet (no SDK needed), and signing Kasseal trades from a web page through a
browser wallet with the SDK's adapters.

## Part 1: showing Kasseal tokens

### Token identity

- A Kasseal token **is its KCC-20 covenant id**: 64 hex characters, `meta.covenantId` in the API.
- Names and tickers are chosen by the creator and are **not unique**: two tokens can both be called "KAS". Always key
  tokens by covenant id. When two tokens share a ticker, show the id (for example its first and last 8 characters)
  or a warning.
- `meta.ticker` can be an empty string: the declaration named no symbol, or Kasseal hid the token's metadata. Show the
  name, or the shortened id, instead.

### Units

- **Decimals are 0.** Every amount is a count of whole tokens, in the API (`balance`, `supply.*`) and on chain.
- `meta.decimals` is always `0`. If a token's declaration says something else, the API reports it as
  `meta.declaredDecimals` and never applies it. Do not scale by it.
- On a cell, the top-level `amount` is the UTXO's KAS value in sompi; the token count is `state.amount`.
- Every token has a fixed supply of 1,200,000,000 (`supply.total`, `supplyFixed: true`).
- Each token cell also carries KAS, 5 KAS by default, as a refundable deposit. `holdings[].deposits` sums it.

### Routes

All under the API base URL (mainnet: `https://app.kasseal.com/v1`, testnet-10: `https://testnet.kasseal.com/v1`). Public, read-only, no key.

| Route | Returns |
|---|---|
| `GET /tokens/{id}` | One token: `meta`, `supply`, `phase`, `verification` |
| `GET /tokens/lookup?ids={id1},{id2},…` | Up to 50 tokens at once |
| `GET /tokens?sort=new&limit=100[&cursor=…]` | Newest tokens; follow `nextCursor`. Other sorts: `active`, `progress`, `holders`, `mcap` |
| `GET /address/{address}/tokens` | A wallet's balances: `holdings[]` (`tokenId`, `balance`, `cells`, `deposits`), the tokens' metadata in `tokens[]`, LP positions in `lpPositions` |
| `GET /images/{sha256}` | A token logo |
| `GET /tokens/{id}/launch-proof` | The launch proof, with the on-chain declaration |

**LP shares** are KCC-20 cells too, of the pool's LP-share lineage, with no metadata of their own. They are listed
under `lpPositions`, never under `holdings`. Show them as "LP share of <token>", or not at all.

### What to show

| Field | Use |
|---|---|
| `verification` | Show only `"verified"` tokens. It means the launch proof is bound and the supply sealed. It does not mean the project is official or endorsed. `invalid` comes with `verificationReason` |
| `meta.ticker`, `meta.name` | Creator-chosen, not unique |
| `meta.description` | Creator-provided text. Do not present it as verified |
| `meta.hidden` | `true`: Kasseal hid the token's metadata after a takedown request (empty name and ticker, no image). The token still trades and verifies. Show a neutral label such as "Hidden" |
| `phase` | `bonding` (on its curve), `graduated` (sold out, pool not open yet), `listed` (on its pool) or `unknown`. For information only |

### Logos

- `meta.imageSource: "verified"`: `meta.imageUrl` is a path on the API; prefix it with the API's host. The file name
  is the SHA-256 of the bytes, and the token's declaration names the same hash, so you can re-hash after download
  and cache it for good. Images are PNG, JPEG or WebP only (never SVG), at most 1 MiB and 2048 × 2048 px.
- `meta.imageSource: "external"`: `imageUrl` is an https URL the creator declared. Kasseal never fetches or checks it.
  Treat it as untrusted and do not load it without the user's consent.
- No `imageUrl`: no logo. Show a placeholder.

### Verifying without trusting Kasseal

The metadata is on chain: a token's name, ticker, decimals and logo hash are a KCC-23 declaration in the payload of
its preparation transaction, bound to the covenant id. `GET /tokens/{id}/launch-proof` returns both launch
transactions; the SDK's `verifyLaunchProofJson` checks the binding and the sealed supply in your own process (see
[launch-proof.md](launch-proof.md)). Check balances against your own Kaspa node if you can. We recommend both for
anything you display as verified.

### Sending tokens

- Kasseal tokens use the standard KCC-20 reference program (template hash
  `9703112ee6e3555107cd168858992b77d3b74f655205b2b463b1f9ec2ec73cf7`). Standard KCC-20 transfer support works as is.
- **Do not let users send tokens to a Kasseal contract address** (the P2SH address of a curve or pool cell). The
  sender loses them either way: cells of the same token sent there are locked for good, and cells of another token
  can be taken by whoever submits the next transaction of that curve or pool. The same holds for a cell owned by a
  curve's or pool's covenant id, or by the token's own id (anyone can spend the latter).
  `GET /tokens/{id}/covenant-cells` lists such cells as `strays`.
- Pool swaps are composable: one transaction may carry a Kasseal swap together with other contracts' cells.
  Balances are read from the cells as always; nothing changes for a wallet.

### Limits, CORS and live updates

- **Rate limits**, per client IP: 60 reads per second with three seconds of burst. Calls from users' own devices are
  well within this. A refusal is `429` with `Retry-After`. If you proxy through your own servers and need more,
  contact Kasseal.
- **CORS.** Only Kasseal's own web origins get CORS headers. Requests without an `Origin` header (servers) and
  extension background requests with host permissions are not affected. Ask Kasseal to allow your web origin if you
  call the API from a web page.
- **Live updates.** Polling `GET /tokens?sort=new` every 30 to 60 seconds is enough for a wallet. The stream
  (`wss://app.kasseal.com/v1/stream` on mainnet, `wss://testnet.kasseal.com/v1/stream` on testnet-10) pushes trades and launches; a page that sends an `Origin` header
  is refused unless that origin is allowed.
- **Signed messages.** The only API writes a wallet is ever asked to sign for are Kasseal's own app actions
  (sign-in, terms, comments, follows). Their messages name the site, so a signature made for another site does not
  verify. No read and no transaction relay needs one.

## Part 2: signing Kasseal trades with a browser wallet

The SDK's web entry includes adapters for three wallets. Each one connects, reports the account, signs a built
transaction's own inputs and signs messages. None of them submits anything.

| Wallet | Factory | Provider it uses by default |
|---|---|---|
| KasWare | `createKasWareAdapter({ network })` | `window.kasware` |
| Kastle | `createKastleAdapter({ network })` | `window.kastle` |
| Kaspire | `createKaspireAdapter({ network })` | `window.kaspire` |

Always pass `network` (`'testnet-10'` or `'mainnet'`). An adapter refuses a wallet that is on another network
(`WalletNetworkMismatch`), and an account whose address is not of that network or whose reported key does not match its address (`WalletAccountMismatch`).

```ts
import { createKasWareAdapter, createTxBuilder, signBuilt, xOnlyKeyOfAddress } from '@kassealhq/sdk/web';

const wallet = createKasWareAdapter({ network: 'testnet-10' });
if (!wallet.isAvailable()) throw new Error('KasWare is not installed');
const account = await wallet.connect();            // { address, publicKey (x-only hex), network }

const built = await builder.buildSwap({ /* ... see examples/pool-sell-wallet.ts */ });
const signed = await signBuilt(wallet, built);      // one wallet popup
// signed.txJson is ready for POST /tx; signed.txid equals built.txid.
```

**Loading the web entry.** Call `initWeb` once before you build. It instantiates the bundled Kaspa WASM SDK
(rusty-kaspa v2.1.0) and installs the contract artifacts. If you serve the WASM file yourself (`wasm` option: bytes,
a URL or a `Response`), the SDK hashes the bytes against the pinned SHA-256 before instantiating them and throws
`SdkWasmMismatch` on any difference.

**What the wallet signs.** `signBuilt` passes the wallet exactly `built.inputsToSign`: the user's own KAS inputs and,
for a sell, the user's own token cell. Every signature is `SIGHASH_ALL`. The wallet never signs a curve or pool input.
After the wallet answers, `signBuilt`:

- checks the signed transaction has the same id as the built one (no outpoint, output, binding or payload changed);
- checks every input the wallet was not asked to sign is byte for byte the same;
- verifies every signature against the connected account's key;
- places the signatures in the prebuilt signature scripts and checks the final masses.

Anything else is refused with `FinalizeError` and nothing is submitted.

**Before you show a signing prompt**, show the user what the SDK computed: the tokens or KAS they receive, the
all-in cost (`maxAllIn`) or the net amount (`minNetOut`), the cell deposit and the network fee. The builder refuses
to build when those bounds are not met (`NetBoundExceeded`).

**Errors.** A user rejection is a `KasWareError`, `KastleError` or `KaspireError` whose `rejectedByUser` is true (code
4001). `WalletUnavailable`: no provider. `WalletNotConnected`: call `connect()` first. `MessageSigningUnsupported`: the
wallet cannot sign messages. See [errors.md](errors.md).
