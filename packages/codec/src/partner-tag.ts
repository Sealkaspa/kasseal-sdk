/**
 * Partner tag (docs/partner-tag.md): which partner a trade is credited to.
 *
 * The tag is the whole transaction payload of a curve buy or sell, or a pool swap:
 *
 *   0x4B 0x53 ("KS") || version 0x01 || partner id (u16, big-endian) || channel (u8)      6 bytes
 *
 * Kasseal's builder writes it, and the payload is part of the txid (KIP-24) and of every input's sighash, so the
 * user's signature commits to it and a wallet that only signs cannot change it. The contracts never read the payload.
 * The prefix keeps clear of the other payloads Kasseal reads: 0x00 (KCC-23 declaration) and 0x01 (batch orders).
 *
 * Decoding is strict: exactly 6 bytes, the exact prefix and version, a known partner and a known channel. Anything
 * else, including a valid tag followed by more bytes, is not a tag (`null`), and the trade is untagged.
 *
 * The tag says which app built the transaction, as that app reports it. It cannot prove which app the user had open
 * (the user's device runs whatever it likes), so crediting rests on economics, not on the tag alone: a partner earns
 * a fraction of Kasseal's share of the fee the trade actually paid, below Kasseal's share, so a tagged trade always
 * costs its maker more than it earns anyone.
 */

export const PARTNER_TAG_MAGIC_0 = 0x4b;
export const PARTNER_TAG_MAGIC_1 = 0x53;
export const PARTNER_TAG_VERSION = 0x01;
export const PARTNER_TAG_BYTES = 6;

/**
 * Partner ids. Fixed forever once used: ledgers and statements key on them. Below 1000: wallets. 1000 and up: apps that
 * build Kasseal trades with the SDK (BraidSwap, a router: its own app builds every trade, so its trades use `embedded`).
 */
export const PARTNER_IDS = { kasware: 1, kaspire: 2, kastle: 3, braidswap: 1000 } as const;
export type PartnerKey = keyof typeof PARTNER_IDS;
export type PartnerId = (typeof PARTNER_IDS)[PartnerKey];

/**
 * Channels. `extension` and `walletconnect` are trades on Kasseal's own web app signed with the partner's wallet
 * (the "connected" rate); `embedded` is a trade the partner's own app built with the SDK (the "embedded" rate).
 */
export const PARTNER_CHANNELS = { extension: 1, walletconnect: 2, embedded: 3 } as const;
export type PartnerChannelKey = keyof typeof PARTNER_CHANNELS;
export type PartnerChannel = (typeof PARTNER_CHANNELS)[PartnerChannelKey];

export interface PartnerTag {
  readonly partner: PartnerId;
  readonly channel: PartnerChannel;
}

const KNOWN_PARTNERS: ReadonlySet<number> = new Set(Object.values(PARTNER_IDS));
const KNOWN_CHANNELS: ReadonlySet<number> = new Set(Object.values(PARTNER_CHANNELS));

export function isPartnerId(n: number): n is PartnerId {
  return KNOWN_PARTNERS.has(n);
}

export function isPartnerChannel(n: number): n is PartnerChannel {
  return KNOWN_CHANNELS.has(n);
}

/** The 6-byte payload for a tag. Throws on an unknown partner or channel: a builder never writes a tag that does not decode. */
export function encodePartnerTag(tag: PartnerTag): Uint8Array {
  if (!isPartnerId(tag.partner)) throw new RangeError(`unknown partner id ${String(tag.partner)}`);
  if (!isPartnerChannel(tag.channel)) throw new RangeError(`unknown partner channel ${String(tag.channel)}`);
  return Uint8Array.of(PARTNER_TAG_MAGIC_0, PARTNER_TAG_MAGIC_1, PARTNER_TAG_VERSION, tag.partner >> 8, tag.partner & 0xff, tag.channel);
}

/** The tag a payload carries, or `null` when the payload is not exactly a valid tag. */
export function decodePartnerTag(payload: Uint8Array): PartnerTag | null {
  if (payload.length !== PARTNER_TAG_BYTES) return null;
  if (payload[0] !== PARTNER_TAG_MAGIC_0 || payload[1] !== PARTNER_TAG_MAGIC_1 || payload[2] !== PARTNER_TAG_VERSION) return null;
  const partner = (payload[3]! << 8) | payload[4]!;
  const channel = payload[5]!;
  if (!isPartnerId(partner) || !isPartnerChannel(channel)) return null;
  return { partner, channel };
}

/** `decodePartnerTag` over a hex payload (the node's RPC form). Mixed case and odd lengths are not tags. */
export function decodePartnerTagHex(payloadHex: string): PartnerTag | null {
  if (payloadHex.length !== 2 * PARTNER_TAG_BYTES || !/^[0-9a-f]+$/.test(payloadHex)) return null;
  const bytes = new Uint8Array(PARTNER_TAG_BYTES);
  for (let i = 0; i < PARTNER_TAG_BYTES; i++) bytes[i] = parseInt(payloadHex.slice(2 * i, 2 * i + 2), 16);
  return decodePartnerTag(bytes);
}
