/**
 * Kaspire wallet adapter over the injected provider `window.kaspire`, with
 * the request and response shapes verified against Kaspire 1.2.0 on
 * testnet-10:
 *
 *   requestAccounts  -> string[] (one address)               popup on first use
 *   getNetwork       -> "mainnet" | "testnet-10" | ...       asserted equal to the configured network
 *   getPublicKey     -> 64-hex x-only key                    asserted equal to the address's key
 *   signPskt (legacy)      { sender, txJsonString, options: { signInputs: [{ index, sighashType: 1 }] } }
 *                          -> the signed SafeJSON string; never broadcasts
 *   signPskt (normalized)  { sender, psktTransactionJson, submitTransaction: false, signInputs,
 *                            scripts: [{ inputIndex, scriptHex: '', prebuiltSignatureScript, signatureOffsets, expectedSighash }] }
 *                          -> { psktTransactionJson }        the prebuilt-signature path (B2)
 *
 * B1 (the legacy request; Kaspire signs the P2SH input and answers P2PK-style,
 * the builder splices) is the default and the path proven on chain. B2 is
 * selected with `signing: 'b2'` for transactions that have P2SH inputs to
 * sign, so a Kaspire version that stops signing unknown scripts is a
 * configuration change; it was specified from Kaspire's source but not
 * exercised against the extension.
 *
 * Events: the provider's `accountsChanged` and `networkChanged` are
 * subscribed through `on`/`removeListener` when the provider has them. Their
 * payloads are not specified, so any such event drops the connected
 * account and notifies the subscribers; the app reconnects, which repeats
 * every check above. The network is also re-read before each signature.
 *
 * Documented by Kaspire but not exercised on chain (kaspire.kaslab.space/developers/extension,
 * docs/KASPACOM_PROVIDER.md of the Kaspire repository), used only where a
 * failure is harmless:
 *
 *   getAccounts      -> string[]; never opens a window, [] when this origin is not connected
 *                       (`restore`: the connection comes back on page load without a popup; any
 *                       error means "not restored", and the user connects with a click)
 *   disconnect       -> true; removes this origin's permission (best effort in `disconnect`;
 *                       the adapter forgets the account whatever the answer)
 *   signMessage      { message, address } -> { address, publicKey, signedMessage, signature }:
 *                       a 64-byte hex Schnorr signature over rusty-kaspa's PersonalMessageSigningHash,
 *                       one approval window per message (`./message.ts`; read from the extension source)
 *
 * `requestAccounts` opens Kaspire's approval window on every call (Kaspire
 * source), so it is only called from a click.
 *
 * The adapter signs and never submits; `signBuilt` hands the answer to
 * `finalize` (B1 splice at the recorded offset, budgets, txid unchanged).
 */

import { toHex } from '@kasseal/codec';
import { finalize } from '../finalize.ts';
import type { BuiltTx, InputToSign } from '../types.ts';
import { AddressError, addressPrefixOf, decodeAddress, xOnlyKeyOfAddress } from './address.ts';
import { kaspaMessageSignature, MessageSignatureError } from './message.ts';
import { assertAnswerMatchesRequest, prepareSignRequest, signedTxJsonOf, type PreparedSignRequest } from './splice.ts';

/** One provider request. */
export interface KaspireRequestArguments {
  /** Method name, e.g. `requestAccounts`. */
  readonly method: string;
  /** Method parameters. */
  readonly params?: unknown;
}

/** The part of the injected provider the adapter uses. */
export interface KaspireProvider {
  request(args: KaspireRequestArguments): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
  readonly version?: string;
}

/** A connected wallet account. */
export interface WalletAccount {
  /** The account's P2PK address. */
  readonly address: string;
  /** x-only public key, lowercase hex. */
  readonly publicKey: string;
  /** The network the wallet is on (`mainnet`, `testnet-10`). */
  readonly network: string;
}

/** The common wallet adapter interface (Kaspire, KasWare, Kastle); inputs to sign carry their kind and signature slot. */
export interface WalletAdapter {
  /** Short id, e.g. `kaspire`. */
  readonly id: string;
  /** Display name. */
  readonly label: string;
  /** Whether the wallet's provider is present in this browser. */
  isAvailable(): boolean;
  /** Connect (may open the wallet's approval window); checks the network and the key. */
  connect(): Promise<WalletAccount>;
  /** Forget the connected account (and revoke the site's permission where the wallet supports it). */
  disconnect(): Promise<void>;
  /** The connected account, or `null`. */
  getAccount(): WalletAccount | null;
  /** Signs `inputs` of a built SafeJSON transaction and returns the signed SafeJSON; never submits. */
  signPskt(txJson: string, inputs: readonly InputToSign[]): Promise<string>;
  /**
   * Signs `message` with the connected account's key: a Kaspa message signature (rusty-kaspa `signMessage`, BIP-340
   * Schnorr over the PersonalMessageSigningHash), 64 bytes, lowercase hex. One wallet popup.
   */
  signMessage(message: string): Promise<string>;
}

/** A wallet event: the account or the network changed. */
export type WalletChange =
  | { readonly kind: 'accounts-changed'; readonly payload: unknown }
  | { readonly kind: 'network-changed'; readonly payload: unknown };

/** Options of `createKaspireAdapter`. */
export interface KaspireOptions {
  /** The provider, or a getter evaluated on each use; default `globalThis.kaspire`. */
  readonly provider?: KaspireProvider | (() => KaspireProvider | undefined);
  /** Network the wallet must be on; default `testnet-10`. Pass it explicitly. */
  readonly network?: string;
  /** `b1` (default): legacy request, signatures spliced by the builder. `b2`: prebuilt-signature request for P2SH inputs. */
  readonly signing?: 'b1' | 'b2';
}

/** A provider error with Kaspire's code (4001 rejected, 4100 locked or watch-only, 4200 unsupported, -326xx malformed). */
export class KaspireError extends Error {
  /** The provider's error code, when it gave one. */
  readonly code: number | undefined;
  /** The provider method that failed. */
  readonly method: string;
  constructor(method: string, code: number | undefined, message: string) {
    super(`kaspire ${method}${code === undefined ? '' : ` (${code})`}: ${message}`);
    this.name = 'KaspireError';
    this.code = code;
    this.method = method;
  }
  /** True when the user rejected the request (code 4001). */
  get rejectedByUser(): boolean {
    return this.code === 4001;
  }
}

/** The wallet's provider is not present in this browser. */
export class WalletUnavailable extends Error {
  constructor(id: string) {
    super(`wallet "${id}" is not available in this browser`);
    this.name = 'WalletUnavailable';
  }
}

/** An operation needs a connected account and there is none. */
export class WalletNotConnected extends Error {
  constructor() {
    super('wallet is not connected');
    this.name = 'WalletNotConnected';
  }
}

/** The wallet is on another network than the adapter was configured for. */
export class WalletNetworkMismatch extends Error {
  /** The configured network. */
  readonly expected: string;
  /** What the wallet reported. */
  readonly actual: unknown;
  constructor(expected: string, actual: unknown) {
    super(`wallet is on network ${JSON.stringify(actual)}, expected ${expected}`);
    this.name = 'WalletNetworkMismatch';
    this.expected = expected;
    this.actual = actual;
  }
}

/** The wallet's account, key or answer does not match what was asked for. */
export class WalletAccountMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletAccountMismatch';
  }
}

const EVENTS = ['accountsChanged', 'networkChanged'] as const;

function defaultProvider(): KaspireProvider | undefined {
  const p = (globalThis as { kaspire?: unknown }).kaspire;
  return p !== null && typeof p === 'object' && typeof (p as { request?: unknown }).request === 'function' ? (p as KaspireProvider) : undefined;
}

/** The Kaspire adapter. Signs only; never submits. */
export class KaspireAdapter implements WalletAdapter {
  readonly id = 'kaspire';
  readonly label = 'Kaspire';
  readonly network: string;
  readonly signing: 'b1' | 'b2';
  readonly #provider: () => KaspireProvider | undefined;
  #account: WalletAccount | null = null;
  #subscribed: { provider: KaspireProvider; listeners: Map<string, (...args: unknown[]) => void> } | undefined;
  readonly #changeListeners = new Set<(change: WalletChange) => void>();

  constructor(options: KaspireOptions = {}) {
    const p = options.provider;
    this.#provider = typeof p === 'function' ? p : p !== undefined ? (): KaspireProvider => p : defaultProvider;
    this.network = options.network ?? 'testnet-10';
    this.signing = options.signing ?? 'b1';
    addressPrefixOf(this.network);
  }

  isAvailable(): boolean {
    return this.#provider() !== undefined;
  }

  getAccount(): WalletAccount | null {
    return this.#account;
  }

  /** Subscribe to account and network changes reported by the provider; returns the unsubscribe function. */
  onChange(listener: (change: WalletChange) => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  async connect(): Promise<WalletAccount> {
    const provider = this.#requireProvider();
    const accounts = await this.#call(provider, 'requestAccounts');
    if (!Array.isArray(accounts) || accounts.length === 0 || typeof accounts[0] !== 'string') throw new KaspireError('requestAccounts', undefined, 'no account returned');
    return this.#establish(provider, accounts[0]);
  }

  /**
   * The account this origin is already approved for, without a popup (`getAccounts`); `null` when there is none.
   * Throws like `connect` when that account is on another network or its key does not match.
   */
  async restore(): Promise<WalletAccount | null> {
    const provider = this.#provider();
    if (provider === undefined) return null;
    const accounts = await this.#call(provider, 'getAccounts');
    if (!Array.isArray(accounts) || accounts.length === 0 || typeof accounts[0] !== 'string') return null;
    return this.#establish(provider, accounts[0]);
  }

  async #establish(provider: KaspireProvider, address: string): Promise<WalletAccount> {
    // Subscribed before the network check, so a switch to the right network after a mismatch is heard.
    this.#subscribe(provider);
    await this.#assertNetwork(provider);
    let decoded;
    try {
      decoded = decodeAddress(address);
    } catch (e) {
      throw new WalletAccountMismatch(`wallet account ${address} is not a valid address: ${(e as AddressError).message}`);
    }
    if (decoded.prefix !== addressPrefixOf(this.network)) throw new WalletAccountMismatch(`wallet account ${address} is not a ${this.network} address`);
    const key = await this.#call(provider, 'getPublicKey');
    if (typeof key !== 'string' || !/^[0-9a-fA-F]{64}$/.test(key)) throw new WalletAccountMismatch(`getPublicKey returned ${JSON.stringify(key)}, expected a 32-byte x-only key`);
    let expected: string;
    try {
      expected = toHex(xOnlyKeyOfAddress(address));
    } catch (e) {
      throw new WalletAccountMismatch(`wallet account ${address}: ${(e as Error).message}`);
    }
    if (key.toLowerCase() !== expected) throw new WalletAccountMismatch(`getPublicKey ${key} is not the key of ${address}`);
    this.#account = { address, publicKey: expected, network: this.network };
    return this.#account;
  }

  async disconnect(): Promise<void> {
    this.#unsubscribe();
    this.#account = null;
    const provider = this.#provider();
    if (provider === undefined) return;
    try {
      await provider.request({ method: 'disconnect' });
    } catch {
      // An older Kaspire without `disconnect`: the account is forgotten here all the same.
    }
  }

  async signPskt(txJson: string, inputs: readonly InputToSign[]): Promise<string> {
    const { signed } = await this.signRequest(txJson, inputs);
    return signed;
  }

  /** `signPskt` that also returns the prepared request (for logging and for `assertAnswerMatchesRequest`). */
  async signRequest(txJson: string, inputs: readonly InputToSign[]): Promise<{ request: PreparedSignRequest; signed: string }> {
    const account = this.#account;
    if (account === null) throw new WalletNotConnected();
    const provider = this.#requireProvider();
    await this.#assertNetwork(provider);
    if (this.#account !== account) throw new WalletNotConnected();
    const request = prepareSignRequest(txJson, inputs, { networkId: this.network });
    const params = this.signing === 'b2' && request.prebuilt.length > 0
      ? { sender: account.address, psktTransactionJson: request.txJson, submitTransaction: false, signInputs: request.signInputs, scripts: request.prebuilt }
      : { sender: account.address, txJsonString: request.txJson, options: { signInputs: request.signInputs } };
    const response = await this.#call(provider, 'signPskt', params);
    const signed = signedTxJsonOf(response);
    assertAnswerMatchesRequest(request, signed);
    return { request, signed };
  }

  async signMessage(message: string): Promise<string> {
    const account = this.#account;
    if (account === null) throw new WalletNotConnected();
    const provider = this.#requireProvider();
    await this.#assertNetwork(provider);
    if (this.#account !== account) throw new WalletNotConnected();
    const response = await this.#call(provider, 'signMessage', { message, address: account.address });
    if (response === null || typeof response !== 'object') throw new MessageSignatureError('kaspire', 'expected { publicKey, signedMessage }');
    const r = response as { address?: unknown; publicKey?: unknown; signedMessage?: unknown; signature?: unknown };
    if (r.address !== undefined && r.address !== account.address) throw new WalletAccountMismatch(`signMessage answered for ${String(r.address)}, not ${account.address}`);
    if (r.publicKey !== undefined && (typeof r.publicKey !== 'string' || r.publicKey.toLowerCase() !== account.publicKey)) {
      throw new WalletAccountMismatch(`signMessage signed with ${String(r.publicKey)}, not the key of ${account.address}`);
    }
    return kaspaMessageSignature('kaspire', r.signedMessage ?? r.signature);
  }

  #requireProvider(): KaspireProvider {
    const provider = this.#provider();
    if (provider === undefined) throw new WalletUnavailable(this.id);
    return provider;
  }

  async #assertNetwork(provider: KaspireProvider): Promise<void> {
    const network = await this.#call(provider, 'getNetwork');
    if (network !== this.network) {
      this.#account = null;
      throw new WalletNetworkMismatch(this.network, network);
    }
  }

  async #call(provider: KaspireProvider, method: string, params?: unknown): Promise<unknown> {
    try {
      return await provider.request(params === undefined ? { method } : { method, params });
    } catch (e) {
      const err = e as { code?: unknown; message?: unknown };
      throw new KaspireError(method, typeof err?.code === 'number' ? err.code : undefined, typeof err?.message === 'string' ? err.message : String(e));
    }
  }

  #subscribe(provider: KaspireProvider): void {
    if (this.#subscribed?.provider === provider) return;
    this.#unsubscribe();
    if (typeof provider.on !== 'function') return;
    const listeners = new Map<string, (...args: unknown[]) => void>();
    for (const event of EVENTS) {
      const listener = (...args: unknown[]): void => this.#changed(event === 'accountsChanged' ? { kind: 'accounts-changed', payload: args[0] } : { kind: 'network-changed', payload: args[0] });
      provider.on(event, listener);
      listeners.set(event, listener);
    }
    this.#subscribed = { provider, listeners };
  }

  #unsubscribe(): void {
    const s = this.#subscribed;
    this.#subscribed = undefined;
    if (!s || typeof s.provider.removeListener !== 'function') return;
    for (const [event, listener] of s.listeners) s.provider.removeListener(event, listener);
  }

  #changed(change: WalletChange): void {
    this.#account = null;
    for (const l of [...this.#changeListeners]) {
      try {
        l(change);
      } catch {
        // A subscriber's failure must not stop the others from learning that the account is gone.
      }
    }
  }
}

/** Create a Kaspire adapter. */
export function createKaspireAdapter(options: KaspireOptions = {}): KaspireAdapter {
  return new KaspireAdapter(options);
}

/** One popup: the wallet signs the built transaction's inputs, then `finalize` splices, applies budgets and checks the txid. */
export async function signBuilt(wallet: Pick<WalletAdapter, 'signPskt'> & Partial<Pick<WalletAdapter, 'getAccount'>>, built: BuiltTx): Promise<BuiltTx> {
  // The key the signatures must verify against: the account the wallet reports when asked.
  const signer = wallet.getAccount?.()?.publicKey;
  const signed = await wallet.signPskt(built.txJson, built.inputsToSign);
  return finalize(built, signed, signer === undefined ? {} : { signer });
}
