/**
 * Kaspa message signatures from a wallet (`WalletAdapter.signMessage`).
 *
 * A Kaspa message signature is rusty-kaspa's `signMessage`
 * (wallet/core/src/message.rs): a BIP-340 Schnorr signature by the account's
 * key over the BLAKE2b `PersonalMessageSigningHash` of the UTF-8 message,
 * 64 bytes, returned as hex; the SDK's `verifyMessage` checks it against the
 * 32-byte x-only key. Both wired wallets produce exactly this, read from
 * their source:
 *
 * - Kaspire: `request({ method: 'signMessage', params: { message, address } })`
 *   -> `{ address, publicKey, signedMessage, signature }` (docs/KASPACOM_PROVIDER.md
 *   of KaspaHUB21/Kaspire-Kaspa-Wallet; apps/browser_extension/src/background/index.ts
 *   calls `signPersonalMessage` of crates/kaspa_secure_core/src/lib.rs, which hashes
 *   with `kaspa_hashes::PersonalMessageSigningHash` and signs with `sign_schnorr`,
 *   hex-encoding the 64 bytes). One approval window per message.
 * - KasWare: `kasware.signMessage(text, { type: 'schnorr' })` -> hex string
 *   (docs.kasware.xyz kaspa-sign; kasware-wallet/extension
 *   src/background/service/keyringclass/simple-keyring.ts calls the SDK's
 *   `signMessage({ message, privateKey, noAuxRand })`). `type: 'schnorr'` is
 *   sent explicitly: the default `auto` signs ECDSA for Tangem accounts. One
 *   approval window per message.
 *
 * Neither wallet documents a batch (several messages in one approval).
 */

/** A wallet answered a message-signing request with something that is not a 64-byte Schnorr signature. */
export class MessageSignatureError extends Error {
  readonly wallet: string;
  constructor(wallet: string, message: string) {
    super(`${wallet} signMessage: ${message}`);
    this.name = 'MessageSignatureError';
    this.wallet = wallet;
  }
}

/** The wallet in this browser offers no message signing. */
export class MessageSigningUnsupported extends Error {
  readonly wallet: string;
  constructor(wallet: string, detail: string) {
    super(`${wallet} cannot sign messages here: ${detail}`);
    this.name = 'MessageSigningUnsupported';
    this.wallet = wallet;
  }
}

/**
 * A wallet's message signature as 64 bytes of lowercase hex: hex in any case, with or without `0x`. A 65-byte
 * signature (a recoverable ECDSA one) or anything that is not hex is refused, never converted.
 */
export function kaspaMessageSignature(wallet: string, raw: unknown): string {
  if (typeof raw !== 'string') throw new MessageSignatureError(wallet, `expected a hex signature, got ${raw === null ? 'null' : typeof raw}`);
  const hex = raw.trim().replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2 !== 0) throw new MessageSignatureError(wallet, 'the signature is not hex');
  if (hex.length !== 128) throw new MessageSignatureError(wallet, `expected a 64-byte Schnorr signature, got ${hex.length / 2} bytes`);
  return hex;
}
