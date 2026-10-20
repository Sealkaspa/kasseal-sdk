/**
 * KasWare wallet adapter over the injected provider `window.kasware`, the
 * same `WalletAdapter` as Kaspire (kaspire.ts) and the same safety checks.
 * Logging every signing request and answer to the console (prefixed
 * `[kasware]`) is opt-in. How KasWare displays token outputs has not been
 * verified, so do not rely on what the wallet shows for them.
 *
 * Mapped methods, each a method of `window.kasware`, not a `request` call
 * (docs.kasware.xyz/wallet/developer-documentation/kaspa/kaspa-connection,
 * -account, -events, -sign, -transaction; github.com/kasware-wallet/extension
 * at 78bb300, src/content-script/pageProvider/index.ts and
 * src/background/controller/provider/controller.ts):
 *
 *   requestAccounts()  -> string[]                       popup on first use
 *   getAccounts()      -> string[]; [] when this origin is not connected (no popup)
 *   getNetwork()       -> "kaspa_mainnet" | "kaspa_testnet_10" | "kaspa_testnet_11" | "kaspa_testnet_12"
 *                         | "kaspa_devnet", or "" when not connected; mapped to the network id
 *                         ("testnet-10") and asserted
 *   getPublicKey()     -> hex, documented as a 33-byte compressed key (02/03 ‖ x); a 32-byte
 *                         x-only key is accepted too, and x must be the address's key
 *   signPskt({ txJsonString, options: { signInputs: [{ index, sighashType }] } })
 *                      -> the signed SafeJSON string (`Transaction.deserializeFromSafeJSON`, Schnorr
 *                         signatures for the listed indexes, `serializeToSafeJSON`); never broadcasts.
 *                         `sighashType` is always sent explicitly: inside `signInputs` KasWare does
 *                         not default it
 *   signMessage(text, { type: 'schnorr' })
 *                      -> hex string: the SDK's `signMessage` (64-byte Schnorr over the
 *                         PersonalMessageSigningHash); `type` is explicit because `auto` signs ECDSA
 *                         for Tangem accounts (`./message.ts`)
 *   disconnect(origin) -> best effort (not in the documented surface; skipped when absent)
 *   on / removeListener('accountsChanged' -> string[], 'networkChanged' -> network name)
 *
 * Signatures: the builder expects, per input to sign, the wallet's P2PK
 * signature script `41 ‖ sig64 ‖ 01` (Schnorr, SIGHASH_ALL). For a P2PK
 * funding input that is the final script. For the P2SH token-cell input of a
 * sell the request is Kaspire's B1: the input is listed in `signInputs` with
 * an empty signature script, and `finalize` takes the 65-byte `sig64 ‖ 01`
 * out of the wallet's P2PK-style answer and splices it into our sigscript at
 * the offset the builder computed. Whether KasWare signs an input whose UTXO
 * script is P2SH, computes the version-1 sighash, and keeps the covenant
 * fields of the JSON is exactly what the live test establishes; until then
 * an answer `finalize` cannot use fails closed, with the raw answer logged.
 *
 * The adapter signs and never submits.
 */

import { toHex } from '@kasseal/codec';
import type { InputToSign } from '../types.ts';
import { AddressError, addressPrefixOf, decodeAddress, xOnlyKeyOfAddress } from './address.ts';
import { kaspaMessageSignature, MessageSigningUnsupported } from './message.ts';
import { WalletAccountMismatch, WalletNetworkMismatch, WalletNotConnected, WalletUnavailable, type WalletAccount, type WalletAdapter, type WalletChange } from './kaspire.ts';
import { assertAnswerMatchesRequest, prepareSignRequest, SignRequestError, type PreparedSignRequest, type SignInput } from './splice.ts';

/** `signPskt`'s argument as KasWare documents it. */
export interface KasWareSignPsktParams {
  readonly txJsonString: string;
  readonly options: { readonly signInputs: readonly SignInput[] };
}

/** The part of `window.kasware` the adapter uses. */
export interface KasWareProvider {
  requestAccounts(): Promise<unknown>;
  getAccounts?(): Promise<unknown>;
  getNetwork(): Promise<unknown>;
  getPublicKey(): Promise<unknown>;
  signPskt(params: KasWareSignPsktParams): Promise<unknown>;
  signMessage?(text: string, params?: { readonly type?: 'auto' | 'schnorr' | 'ecdsa'; readonly noAuxRand?: boolean }): Promise<unknown>;
  disconnect?(origin?: string): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** Options of `createKasWareAdapter`. */
export interface KasWareOptions {
  /** The provider, or a getter evaluated on each use; default `globalThis.kasware`. */
  readonly provider?: KasWareProvider | (() => KasWareProvider | undefined);
  /** Network the wallet must be on; default `testnet-10`. Pass it explicitly. */
  readonly network?: string;
  /** Where the raw requests and answers go; default `console.info`. `null` silences them. */
  readonly log?: ((...args: unknown[]) => void) | null;
}

/** A provider error with KasWare's code when it has one (4001: the user rejected the request). */
export class KasWareError extends Error {
  readonly code: number | undefined;
  readonly method: string;
  constructor(method: string, code: number | undefined, message: string) {
    super(`kasware ${method}${code === undefined ? '' : ` (${code})`}: ${message}`);
    this.name = 'KasWareError';
    this.code = code;
    this.method = method;
  }
  get rejectedByUser(): boolean {
    return this.code === 4001;
  }
}

/** KasWare's network names and the network ids they stand for. */
export const KASWARE_NETWORKS: Readonly<Record<string, string>> = {
  kaspa_mainnet: 'mainnet',
  kaspa_testnet_10: 'testnet-10',
  kaspa_testnet_11: 'testnet-11',
  kaspa_testnet_12: 'testnet-12',
  kaspa_devnet: 'devnet',
};

/** The network id of a KasWare network name; the name itself when it is already an id (`testnet-10`). */
export function networkOfKasWare(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  return KASWARE_NETWORKS[name] ?? (Object.values(KASWARE_NETWORKS).includes(name) ? name : undefined);
}

/** KasWare's name for a network id (`testnet-10` -> `kaspa_testnet_10`). */
export function kasWareNetworkOf(networkId: string): string {
  const name = Object.keys(KASWARE_NETWORKS).find((k) => KASWARE_NETWORKS[k] === networkId);
  if (name === undefined) throw new AddressError(`KasWare has no network for ${JSON.stringify(networkId)}`);
  return name;
}

/**
 * The 32-byte x-only key (lowercase hex) of a key KasWare reports: 64 hex chars as is, or a 66-hex compressed key
 * `02|03 ‖ x` reduced to x (a Schnorr address commits to x only). `undefined` for anything else.
 */
export function xOnlyOfReportedKey(key: unknown): string | undefined {
  if (typeof key !== 'string') return undefined;
  const k = key.toLowerCase().replace(/^0x/, '');
  if (/^[0-9a-f]{64}$/.test(k)) return k;
  if (/^0[23][0-9a-f]{64}$/.test(k)) return k.slice(2);
  return undefined;
}

/**
 * The wallet's answer as a SafeJSON string: a string as is, an object with `inputs` serialised; anything else is
 * refused (the raw answer is logged by the adapter).
 */
export function kasWareSignedJsonOf(response: unknown): string {
  if (typeof response === 'string') return response;
  if (response !== null && typeof response === 'object') {
    const r = response as Record<string, unknown>;
    for (const key of ['txJsonString', 'psktTransactionJson', 'signedTxJson', 'tx']) {
      const v = r[key];
      if (typeof v === 'string') return v;
      if (v !== null && typeof v === 'object' && Array.isArray((v as { inputs?: unknown }).inputs)) return JSON.stringify(v);
    }
    if (Array.isArray(r.inputs)) return JSON.stringify(r);
  }
  throw new SignRequestError('KasWare returned no signed transaction JSON');
}

/** Per input: the signature script's length and first/last byte, for the log. */
function sigScriptSummary(json: string): unknown {
  try {
    const j = JSON.parse(json) as { inputs?: { signatureScript?: string }[] };
    return (j.inputs ?? []).map((inp, i) => {
      const s = inp.signatureScript ?? '';
      return { input: i, bytes: s.length / 2, head: s.slice(0, 2), tail: s.slice(-2) };
    });
  } catch {
    return 'unparseable';
  }
}

const EVENTS = ['accountsChanged', 'networkChanged'] as const;

function defaultProvider(): KasWareProvider | undefined {
  const p = (globalThis as { kasware?: unknown }).kasware;
  return p !== null && typeof p === 'object' && typeof (p as { requestAccounts?: unknown }).requestAccounts === 'function' ? (p as KasWareProvider) : undefined;
}

/** The KasWare adapter. Signs only; never submits. */
export class KasWareAdapter implements WalletAdapter {
  readonly id = 'kasware';
  readonly label = 'KasWare';
  readonly network: string;
  readonly #provider: () => KasWareProvider | undefined;
  readonly #log: ((...args: unknown[]) => void) | null;
  #account: WalletAccount | null = null;
  #subscribed: { provider: KasWareProvider; listeners: Map<string, (...args: unknown[]) => void> } | undefined;
  readonly #changeListeners = new Set<(change: WalletChange) => void>();

  constructor(options: KasWareOptions = {}) {
    const p = options.provider;
    this.#provider = typeof p === 'function' ? p : p !== undefined ? (): KasWareProvider => p : defaultProvider;
    this.network = options.network ?? 'testnet-10';
    this.#log = options.log === undefined ? (...args: unknown[]): void => console.info(...args) : options.log;
    addressPrefixOf(this.network);
    kasWareNetworkOf(this.network);
  }

  isAvailable(): boolean {
    return this.#provider() !== undefined;
  }

  getAccount(): WalletAccount | null {
    return this.#account;
  }

  onChange(listener: (change: WalletChange) => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  async connect(): Promise<WalletAccount> {
    const provider = this.#requireProvider();
    const accounts = await this.#call('requestAccounts', () => provider.requestAccounts());
    if (!Array.isArray(accounts) || accounts.length === 0 || typeof accounts[0] !== 'string') throw new KasWareError('requestAccounts', undefined, 'no account returned');
    return this.#establish(provider, accounts[0]);
  }

  /** The account this origin is already approved for, without a popup (`getAccounts`); `null` when there is none. */
  async restore(): Promise<WalletAccount | null> {
    const provider = this.#provider();
    if (provider === undefined || typeof provider.getAccounts !== 'function') return null;
    const accounts = await this.#call('getAccounts', () => provider.getAccounts!());
    if (!Array.isArray(accounts) || accounts.length === 0 || typeof accounts[0] !== 'string') return null;
    return this.#establish(provider, accounts[0]);
  }

  async #establish(provider: KasWareProvider, address: string): Promise<WalletAccount> {
    this.#subscribe(provider);
    await this.#assertNetwork(provider);
    let decoded;
    try {
      decoded = decodeAddress(address);
    } catch (e) {
      throw new WalletAccountMismatch(`wallet account ${address} is not a valid address: ${(e as AddressError).message}`);
    }
    if (decoded.prefix !== addressPrefixOf(this.network)) throw new WalletAccountMismatch(`wallet account ${address} is not a ${this.network} address`);
    let expected: string;
    try {
      expected = toHex(xOnlyKeyOfAddress(address));
    } catch (e) {
      throw new WalletAccountMismatch(`wallet account ${address}: ${(e as Error).message}`);
    }
    const reported = await this.#call('getPublicKey', () => provider.getPublicKey());
    this.#log?.('[kasware] getPublicKey ->', reported);
    const key = xOnlyOfReportedKey(reported);
    if (key === undefined) throw new WalletAccountMismatch(`getPublicKey returned ${JSON.stringify(reported)}, expected a 33-byte compressed or 32-byte x-only key`);
    if (key !== expected) throw new WalletAccountMismatch(`getPublicKey ${String(reported)} is not the key of ${address}`);
    this.#account = { address, publicKey: expected, network: this.network };
    return this.#account;
  }

  async disconnect(): Promise<void> {
    this.#unsubscribe();
    this.#account = null;
    const provider = this.#provider();
    if (provider === undefined || typeof provider.disconnect !== 'function') return;
    try {
      const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
      await provider.disconnect(origin);
    } catch {
      // Best effort: the account is forgotten here all the same.
    }
  }

  async signPskt(txJson: string, inputs: readonly InputToSign[]): Promise<string> {
    const { signed } = await this.signRequest(txJson, inputs);
    return signed;
  }

  /** `signPskt` that also returns the prepared request. */
  async signRequest(txJson: string, inputs: readonly InputToSign[]): Promise<{ request: PreparedSignRequest; signed: string }> {
    const account = this.#account;
    if (account === null) throw new WalletNotConnected();
    const provider = this.#requireProvider();
    await this.#assertNetwork(provider);
    if (this.#account !== account) throw new WalletNotConnected();
    const request = prepareSignRequest(txJson, inputs, { networkId: this.network });
    const params: KasWareSignPsktParams = { txJsonString: request.txJson, options: { signInputs: request.signInputs } };
    this.#log?.('[kasware] signPskt request', {
      txid: request.txid,
      inputsToSign: inputs.map((i) => ({ index: i.index, kind: i.kind, signatureOffset: i.signatureOffset })),
      options: params.options,
    });
    this.#log?.('[kasware] signPskt txJsonString', request.txJson);
    let response: unknown;
    try {
      response = await this.#call('signPskt', () => provider.signPskt(params));
    } catch (e) {
      this.#log?.('[kasware] signPskt error', e instanceof KasWareError ? { code: e.code, message: e.message } : e);
      throw e;
    }
    this.#log?.('[kasware] signPskt raw response', typeof response === 'string' ? response : JSON.stringify(response));
    const signed = kasWareSignedJsonOf(response);
    this.#log?.('[kasware] signPskt signature scripts', sigScriptSummary(signed));
    assertAnswerMatchesRequest(request, signed);
    return { request, signed };
  }

  async signMessage(message: string): Promise<string> {
    const account = this.#account;
    if (account === null) throw new WalletNotConnected();
    const provider = this.#requireProvider();
    if (typeof provider.signMessage !== 'function') throw new MessageSigningUnsupported('KasWare', 'this version has no signMessage');
    await this.#assertNetwork(provider);
    if (this.#account !== account) throw new WalletNotConnected();
    this.#log?.('[kasware] signMessage request', { message });
    let response: unknown;
    try {
      response = await this.#call('signMessage', () => provider.signMessage!(message, { type: 'schnorr' }));
    } catch (e) {
      this.#log?.('[kasware] signMessage error', e instanceof KasWareError ? { code: e.code, message: e.message } : e);
      throw e;
    }
    this.#log?.('[kasware] signMessage raw response', response);
    return kaspaMessageSignature('kasware', response);
  }

  #requireProvider(): KasWareProvider {
    const provider = this.#provider();
    if (provider === undefined) throw new WalletUnavailable(this.id);
    return provider;
  }

  async #assertNetwork(provider: KasWareProvider): Promise<void> {
    const name = await this.#call('getNetwork', () => provider.getNetwork());
    const network = networkOfKasWare(name);
    if (network !== this.network) {
      this.#account = null;
      throw new WalletNetworkMismatch(this.network, network ?? name);
    }
  }

  async #call(method: string, run: () => Promise<unknown>): Promise<unknown> {
    try {
      return await run();
    } catch (e) {
      const err = e as { code?: unknown; message?: unknown };
      throw new KasWareError(method, typeof err?.code === 'number' ? err.code : undefined, typeof err?.message === 'string' ? err.message : String(e));
    }
  }

  #subscribe(provider: KasWareProvider): void {
    if (this.#subscribed?.provider === provider) return;
    this.#unsubscribe();
    if (typeof provider.on !== 'function') return;
    const listeners = new Map<string, (...args: unknown[]) => void>();
    for (const event of EVENTS) {
      const listener = (...args: unknown[]): void => {
        this.#log?.(`[kasware] ${event}`, args[0]);
        this.#changed(event === 'accountsChanged' ? { kind: 'accounts-changed', payload: args[0] } : { kind: 'network-changed', payload: args[0] });
      };
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

/** Create a KasWare adapter. */
export function createKasWareAdapter(options: KasWareOptions = {}): KasWareAdapter {
  return new KasWareAdapter(options);
}
