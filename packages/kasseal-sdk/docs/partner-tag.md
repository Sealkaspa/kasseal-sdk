# Wallets: adding your partner tag

A wallet partner's trades on Kasseal are recognised by a **partner tag**: 6 bytes in the transaction's payload that
name the partner and the channel the trade came through. Tagged trades are credited to the partner under its partner
agreement with Kasseal. This page covers the format, what a wallet has to do for each channel, and how to add and
check the tag with the SDK.

Only trades of Kasseal tokens (a curve buy or sell, or a swap on a Kasseal pool) are credited: the share is a part of
Kasseal's own fee. An imported coin (a token whose `venue` field is set, see [api.md](api.md)) pays Kasseal no fee, so
its trades earn no share, tagged or not.

## The tag

The tag is the transaction's whole payload, exactly 6 bytes:

| Bytes | Field | Value |
|---|---|---|
| 0..1 | Magic | `4B 53` (`"KS"`) |
| 2 | Version | `01` |
| 3..4 | Partner id | u16, big-endian |
| 5 | Channel | u8 |

For example, KasWare (partner 1) on the in-wallet channel (3) is `4B 53 01 00 01 03`, or `4b5301000103` in hex.

A payload is a tag only when it is exactly these 6 bytes with a known partner and a known channel. Anything else,
including a valid tag followed by more bytes, is not a tag, and the trade is untagged.

The payload is part of the transaction id and of every input's signature hash, so the user's signature commits to the
tag. The contracts never read it: a tagged trade executes exactly as an untagged one, and costs only the network fee
of 6 more bytes, which the SDK includes in its fee.

Only curve buys, curve sells and pool swaps carry a tag. Liquidity, fee payouts (sweeps) and the other builders always
build an empty payload.

## Partner ids and channels

| Partner id | Partner | SDK constant |
|---|---|---|
| 1 | KasWare | `PARTNER_IDS.kasware` |
| 2 | Kaspire | `PARTNER_IDS.kaspire` |
| 3 | Reserved for Kastle | `PARTNER_IDS.kastle` |
| 1000 | BraidSwap (an app, not a wallet: its own app builds every trade, so it uses channel 3 only) | `PARTNER_IDS.braidswap` |
| 1001 and up | Future integrators | |

| Channel | Name | SDK constant | Who adds the tag |
|---|---|---|---|
| 1 | Extension: a trade on the Kasseal website, signed with the partner's browser extension | `PARTNER_CHANNELS.extension` | The Kasseal website |
| 2 | WalletConnect: a trade on the Kasseal website, signed with the partner's mobile wallet over WalletConnect | `PARTNER_CHANNELS.walletconnect` | The Kasseal website |
| 3 | In-wallet: a swap inside the partner's own app | `PARTNER_CHANNELS.embedded` | The partner's app |

Partner ids are assigned by Kasseal; do not pick one yourself. An id is never reused or given a new meaning. A newly
assigned id is added to `PARTNER_IDS` in an SDK minor release; until the SDK version you use knows your id, the
builders and `encodePartnerTag` refuse it with a `RangeError` rather than write a tag nobody can read.

## Connected trades (channels 1 and 2): sign the payload unchanged

When a user trades on the Kasseal website with your extension or over WalletConnect, the website builds the
transaction with your tag already in the payload. Your wallet does not need any Kasseal code. It only has to:

- sign the transaction it was given, with its payload unchanged;
- never strip, rewrite, re-encode or append to the payload, and never rebuild the transaction from its parts in a way
  that loses the payload.

Changing the payload changes the transaction id. The website checks that the signed transaction has the id it built
(`finalize` and `signBuilt` refuse anything else), so a wallet that drops or alters the payload does not just lose the
tag: the trade fails and nothing is submitted.

## In-wallet trades (channel 3): add the tag with the SDK

A swap screen inside your own app builds the trade itself, so your code adds the tag. Pass `partner` to the builder
from `createTxBuilder`. It takes a `PartnerTag`, `{ partner, channel }`, on all four trade builders:

```ts
import type { BuiltTx, LaunchProofVerdict, PartnerTag, PublicTxBuilder } from '@kassealhq/sdk/web';

const PARTNER: PartnerTag = { partner: 1, channel: 3 };   // your id from Kasseal, channel 3 (in-wallet)

declare const builder: PublicTxBuilder;                   // createTxBuilder({ sources, networkId })
declare const tokenId: string, poolId: string, address: string, xOnly: Uint8Array, proofVerdict: LaunchProofVerdict;

// Curve buy and sell
const buy: BuiltTx = await builder.buildBuy({ covenantId: tokenId, tokenId, buyer: address, buyerXOnlyPubkey: xOnly, lots: 10n, proofVerdict, partner: PARTNER });
const sell: BuiltTx = await builder.buildSell({ covenantId: tokenId, tokenId, seller: address, sellerXOnlyPubkey: xOnly, lots: 10n, proofVerdict, partner: PARTNER });

// Pool swap, either side
const swap: BuiltTx = await builder.buildSwap({ poolId, expectedPoolId: poolId, tokenId, trader: address, traderXOnlyPubkey: xOnly, side: 'kas->tok', amountIn: 100_000_000n, partner: PARTNER });

// Pool sell of a script-held token cell
declare const payout: string, redeem: Uint8Array, signerXOnly: Uint8Array, scriptAddress: string;
const scriptSell: BuiltTx = await builder.buildScriptSell({ poolId, expectedPoolId: poolId, tokenId, payout, redeem, signerXOnly, scriptAddress, partner: PARTNER });
```

The synchronous shapes take the same tag as `partnerTag`: `buildBuy`, `buildSell`, `buildSwapKasForTokens` and
`buildSwapTokensForKas` (`{ ...params, partnerTag: PARTNER }`).

- Pass the same tag on every build and rebuild of the same trade (a retry, a replacement, a build on a newer pending
  state), so every attempt is credited alike.
- Leave `partner` out and the payload stays empty: the transaction is byte for byte what an untagged build gives.
- Use channel 3 only for trades your own app builds. Trades your users make on the Kasseal website are tagged by the
  website (channels 1 and 2).

[examples/partner-tag.ts](../examples/partner-tag.ts) has these builders as functions, with the checks below.

## Building the tag by hand

If your app builds Kasseal transactions without the SDK's builders, write the payload with `encodePartnerTag` and set
it as the transaction's whole payload:

```ts
import { encodePartnerTag } from '@kassealhq/sdk';

const payload: Uint8Array = encodePartnerTag({ partner: 1, channel: 3 });   // 4b 53 01 00 01 03
```

`encodePartnerTag` throws a `RangeError` on a partner id or channel it does not know. The format constants are
exported too: `PARTNER_TAG_MAGIC_0` (`0x4B`), `PARTNER_TAG_MAGIC_1` (`0x53`), `PARTNER_TAG_VERSION` (`1`) and
`PARTNER_TAG_BYTES` (`6`). Remember the network fee of the 6 payload bytes when you compute your fee.

## Checking a transaction carries the tag

`decodePartnerTagHex` reads a payload in lowercase hex, the form `built.txJson` and the Kaspa node use, and returns
the tag or `null` (lowercase a payload from another source first). `decodePartnerTag` does the same for bytes.

```ts
import { decodePartnerTagHex, type BuiltTx } from '@kassealhq/sdk';

declare const built: BuiltTx;
const payloadHex: string = (JSON.parse(built.txJson) as { payload?: string }).payload ?? '';
const tag = decodePartnerTagHex(payloadHex);        // { partner: 1, channel: 3 }, or null when untagged
if (tag === null || tag.partner !== 1) throw new Error('not tagged as ours');
```

Run this check on a built trade before you show the signing prompt, and in your tests. `isPartnerId` and
`isPartnerChannel` tell whether a number is a known id or channel.
