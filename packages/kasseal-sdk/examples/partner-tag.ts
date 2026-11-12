/**
 * A wallet's own swap screen: every Kasseal trade it builds carries the wallet's partner tag (docs/partner-tag.md).
 *
 * This file is a module for a wallet. It assumes the wallet has loaded the SDK's web entry once (`initWeb`) and has a
 * builder from `createTxBuilder`, as in pool-sell-wallet.ts. The tag below is KasWare's (partner 1) on the in-wallet
 * channel (3); use the partner id Kasseal assigned to you.
 */
import {
  PARTNER_TAG_BYTES,
  decodePartnerTagHex,
  encodePartnerTag,
  type BuiltTx,
  type LaunchProofVerdict,
  type PartnerTag,
  type PublicTxBuilder,
} from '@kassealhq/sdk/web';

/** Your partner id and the in-wallet channel. Pass the same tag on every build and rebuild of a trade. */
export const PARTNER: PartnerTag = { partner: 1, channel: 3 };

/** A curve buy of `lots` lots, tagged. */
export function curveBuy(builder: PublicTxBuilder, tokenId: string, address: string, xOnly: Uint8Array, lots: bigint, maxAllIn: bigint, proofVerdict: LaunchProofVerdict): Promise<BuiltTx> {
  return builder.buildBuy({ covenantId: tokenId, tokenId, buyer: address, buyerXOnlyPubkey: xOnly, lots, maxAllIn, proofVerdict, partner: PARTNER });
}

/** A curve sell of `lots` lots, tagged. */
export function curveSell(builder: PublicTxBuilder, tokenId: string, address: string, xOnly: Uint8Array, lots: bigint, minNetOut: bigint, proofVerdict: LaunchProofVerdict): Promise<BuiltTx> {
  return builder.buildSell({ covenantId: tokenId, tokenId, seller: address, sellerXOnlyPubkey: xOnly, lots, minNetOut, proofVerdict, partner: PARTNER });
}

/** A pool swap either way, tagged: `amountIn` is the KAS leg (kas->tok) or the token amount (tok->kas). */
export function poolSwap(builder: PublicTxBuilder, poolId: string, tokenId: string, address: string, xOnly: Uint8Array, side: 'kas->tok' | 'tok->kas', amountIn: bigint): Promise<BuiltTx> {
  return builder.buildSwap({ poolId, expectedPoolId: poolId, tokenId, trader: address, traderXOnlyPubkey: xOnly, side, amountIn, partner: PARTNER });
}

/** A pool sell of a token cell held by a key-locked script, tagged. */
export function scriptSell(builder: PublicTxBuilder, poolId: string, tokenId: string, payout: string, redeem: Uint8Array, signerXOnly: Uint8Array, scriptAddress: string): Promise<BuiltTx> {
  return builder.buildScriptSell({ poolId, expectedPoolId: poolId, tokenId, payout, redeem, signerXOnly, scriptAddress, partner: PARTNER });
}

/** The 6 payload bytes by hand, for a wallet that builds its transactions without the SDK's builders. */
export function partnerPayload(): Uint8Array {
  const payload = encodePartnerTag(PARTNER); // 4b 53 01 00 01 03
  if (payload.length !== PARTNER_TAG_BYTES) throw new Error('unexpected tag length');
  return payload;
}

/** Whether a transaction's payload (lowercase hex, as the node and `built.txJson` give it) carries your tag. */
export function carriesOurTag(payloadHex: string): boolean {
  const tag = decodePartnerTagHex(payloadHex);
  return tag !== null && tag.partner === PARTNER.partner && tag.channel === PARTNER.channel;
}

/** Check a built trade before you show the signing prompt. */
export function assertTagged(built: BuiltTx): void {
  const payload = (JSON.parse(built.txJson) as { payload?: string }).payload ?? '';
  if (!carriesOurTag(payload)) throw new Error(`trade ${built.txid} does not carry the partner tag`);
}
