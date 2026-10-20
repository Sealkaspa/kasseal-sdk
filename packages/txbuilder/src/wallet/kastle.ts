/**
 * Kastle wallet adapter over the injected provider `window.kastle`, the same
 * `WalletAdapter` as Kaspire (kaspire.ts) and KasWare (kasware.ts) and the
 * same safety checks. Every signing request and answer is logged to the
 * console (prefixed `[kastle]`) so a live test shows what the wallet really
 * does.
 *
 * Mapped methods, each a method of `window.kastle` (github.com/forbole/kastle
 * at 4f02273, release v2.61.0: docs/kastle-api.md, api/browser.ts and the
 * handlers under api/background/handlers/kaspa/):
 *
 *   connect()          -> true; opens the approval popup unless this origin is already connected
 *   getAccount()       -> { address, publicKey }; throws "Host not connected" before `connect` (no popup).
 *                         `publicKey` is `PublicKey.toString()`, a 33-byte compressed key (02/03 ‖ x);
 *                         a 32-byte x-only key is accepted too, and x must be the address's key
 *   getNetwork()       -> "mainnet" | "testnet-10" (Kastle's NetworkType); asserted
 *   getVersion()       -> e.g. "2.61.0+extension"; logged only (best effort)
 *   signTx(networkId, txJson, scripts)
 *                      -> the signed SafeJSON string (`deserializeFromSafeJSON`, signed,
 *                         `serializeToSafeJSON`); never broadcasts
 *   signMessage(message) -> 128-hex Schnorr signature of kaspa-wasm `signMessage({ message, privateKey })`,
 *                         the Kaspa personal-message scheme `verifyMessage` checks
 *   disconnect()       -> a no-op in Kastle; called best effort
 *   on / removeListener('accountsChanged' -> string[], 'networkChanged' -> network id)
 *
 * Signing (lib/wallet/sign-script.ts `signTxWithScriptOptions`): for every
 * `scripts` entry `{ inputIndex, signType }` without `scriptHex`, Kastle
 * writes `createInputSignature(...)` into that input's signature script, the
 * push-encoded `41 ‖ sig64 ‖ sighashByte`; an input that already carries a
 * signature script is refused. Only when some input is still empty does it
 * also run `signTransaction` over every input its key owns. The adapter
 * therefore lists every input it wants signed, P2PK funding inputs and the
 * P2SH token cell alike, with `signType: "All"` (SIGHASH_ALL), and nothing
 * else; `assertAnswerMatchesRequest` refuses an answer that touched any other
 * input. For a P2PK input the answer is the final script. For the P2SH
 * token-cell input of a sell it is Kaspire's B1: `finalize` takes the 65-byte
 * `sig64 ‖ 01` out of the P2PK-style answer and splices it into our
 * sigscript at the offset the builder computed. No `scriptHex` is sent:
 * Kastle would append a push of it, which is not our sigscript layout.
 *
 * Kastle's open pull request #389 (KCC-20 support, not merged and in no
 * release as of v2.61.0) makes `signTx` refuse every dApp transaction whose
 * version is not 0 with `{ code: 4200, message }`; that answer surfaces as a
 * `KastleError` with `covenantRefused` set. Ledger accounts in Kastle refuse
 * `scripts` and version 1 transactions outright.
 *
 * The adapter signs and never submits.
 */

import { toHex } from '@kasseal/codec';
import type { InputToSign } from '../types.ts';
import { AddressError, addressPrefixOf, decodeAddress, xOnlyKeyOfAddress } from './address.ts';
import { WalletAccountMismatch, WalletNetworkMismatch, WalletNotConnected, WalletUnavailable, type WalletAccount, type WalletAdapter, type WalletChange } from './kaspire.ts';
import { xOnlyOfReportedKey } from './kasware.ts';
import { assertAnswerMatchesRequest, prepareSignRequest, SignRequestError, type PreparedSignRequest } from './splice.ts';

/** One entry of `signTx`'s `scripts` as Kastle defines it (`ScriptOption`); the adapter never sends `scriptHex`. */
export interface KastleScriptOption {
  readonly inputIndex: number;
  readonly signType: 'All';
}

/** The part of `window.kastle` the adapter uses. */
export interface KastleProvider {
  connect(): Promise<unknown>;
  getAccount(): Promise<unknown>;
  getNetwork(): Promise<unknown>;
  signTx(networkId: string, txJson: string, scripts?: readonly KastleScriptOption[]): Promise<unknown>;
  signMessage?(message: string): Promise<unknown>;
  getVersion?(): Promise<unknown>;
  disconnect?(): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** Options of `createKastleAdapter`. */
export interface KastleOptions {
  /** The provider, or a getter evaluated on each use; default `globalThis.kastle`. */
  readonly provider?: KastleProvider | (() => KastleProvider | undefined);
  /** Network the wallet must be on; default `testnet-10`. Pass it explicitly. */
  readonly network?: string;
  /** Where the raw requests and answers go; default `console.info`. `null` silences them. */
  readonly log?: ((...args: unknown[]) => void) | null;
}

/** Kastle's networks (`NetworkType` in contexts/SettingsContext.tsx). */
export const KASTLE_NETWORKS: readonly string[] = ['mainnet', 'testnet-10'];

/** Kastle's error code for a method it does not support; PR #389 answers a covenant transaction with it. */
export const KASTLE_METHOD_NOT_SUPPORTED = 4200;

/**
 * A provider error. Kastle rejects with a plain string for its own errors ("User denied" when the popup is declined or
 * closed, "Host not connected", "Failed to sign transaction: …") and with `{ code, message }` for RPC errors; a
 * declined popup is given code 4001 here, as the other adapters report it.
 */
export class KastleError extends Error {
  readonly code: number | undefined;
  readonly method: string;
  constructor(method: string, code: number | undefined, message: string) {
    super(`kastle ${method}${code === undefined ? '' : ` (${code})`}: ${message}`);
    this.name = 'KastleError';
    this.code = code;
    this.method = method;
  }
  get rejectedByUser(): boolean {
    return this.code === 4001;
  }
  /** Kastle refused the transaction because it is a covenant (version 1) transaction (its PR #389 behaviour). */
  get covenantRefused(): boolean {
    return this.method === 'signTx' && this.code === KASTLE_METHOD_NOT_SUPPORTED;
  }
}

/** The wallet's answer as a SafeJSON string: a string as is, a transaction object serialised; anything else is refused. */
export function kastleSignedJsonOf(response: unknown): string {
  if (typeof response === 'string') return response;
  if (response !== null && typeof response === 'object' && Array.isArray((response as { inputs?: unknown }).inputs)) return JSON.stringify(response);
  throw new SignRequestError('Kastle returned no signed transaction JSON');
}

/** A Schnorr message signature as Kastle returns it: 64 bytes, lowercase hex. */
export function kastleMessageSignatureOf(response: unknown): string {
  if (typeof response === 'string') {
    const s = response.toLowerCase().replace(/^0x/, '');
    if (/^[0-9a-f]{128}$/.test(s)) return s;
  }
  throw new KastleError('signMessage', undefined, `expected a 64-byte hex signature, got ${JSON.stringify(response)}`);
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

function defaultProvider(): KastleProvider | undefined {
  const p = (globalThis as { kastle?: unknown }).kastle;
  return p !== null && typeof p === 'object' && typeof (p as { signTx?: unknown }).signTx === 'function' ? (p as KastleProvider) : undefined;
}

/** The Kastle adapter. Signs only; never submits. */
export class KastleAdapter implements WalletAdapter {
  readonly id = 'kastle';
  readonly label = 'Kastle';
  readonly network: string;
  readonly #provider: () => KastleProvider | undefined;
  readonly #log: ((...args: unknown[]) => void) | null;
  #account: WalletAccount | null = null;
  #subscribed: { provider: KastleProvider; listeners: Map<string, (...args: unknown[]) => void> } | undefined;
  readonly #changeListeners = new Set<(change: WalletChange) => void>();

  constructor(options: KastleOptions = {}) {
    const p = options.provider;
    this.#provider = typeof p === 'function' ? p : p !== undefined ? (): KastleProvider => p : defaultProvider;
    this.network = options.network ?? 'testnet-10';
    this.#log = options.log === undefined ? (...args: unknown[]): void => console.info(...args) : options.log;
    addressPrefixOf(this.network);
    if (!KASTLE_NETWORKS.includes(this.network)) throw new AddressError(`Kastle has no network ${JSON.stringify(this.network)}`);
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
    const ok = await this.#call('connect', () => provider.connect());
    if (ok !== true) throw new KastleError('connect', undefined, `connection not approved (${JSON.stringify(ok)})`);
    await this.#logVersion(provider);
    return this.#establish(provider);
  }

  /** The account this origin is already connected for, without a popup (`getAccount`); `null` when there is none. */
  async restore(): Promise<WalletAccount | null> {
    const provider = this.#provider();
    if (provider === undefined) return null;
    try {
      await provider.getAccount();
    } catch {
      return null; // "Host not connected" (or locked): the user connects with a click
    }
    return this.#establish(provider);
  }

  async #establish(provider: KastleProvider): Promise<WalletAccount> {
    // Subscribed before the network check, so a switch to the right network after a mismatch is heard.
    this.#subscribe(provider);
    await this.#assertNetwork(provider);
    const reported = await this.#call('getAccount', () => provider.getAccount());
    this.#log?.('[kastle] getAccount ->', reported);
    const r = (reported ?? {}) as { address?: unknown; publicKey?: unknown };
    if (typeof r.address !== 'string') throw new KastleError('getAccount', undefined, 'no account returned');
    const address = r.address;
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
    const key = xOnlyOfReportedKey(r.publicKey);
    if (key === undefined) throw new WalletAccountMismatch(`getAccount returned the key ${JSON.stringify(r.publicKey)}, expected a 33-byte compressed or 32-byte x-only key`);
    if (key !== expected) throw new WalletAccountMismatch(`getAccount key ${String(r.publicKey)} is not the key of ${address}`);
    this.#account = { address, publicKey: expected, network: this.network };
    return this.#account;
  }

  async disconnect(): Promise<void> {
    this.#unsubscribe();
    this.#account = null;
    const provider = this.#provider();
    if (provider === undefined || typeof provider.disconnect !== 'function') return;
    try {
      await provider.disconnect();
    } catch {
      // Best effort (a no-op in Kastle): the account is forgotten here all the same.
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
    const scripts: KastleScriptOption[] = request.signInputs.map((s) => ({ inputIndex: s.index, signType: 'All' }));
    this.#log?.('[kastle] signTx request', {
      networkId: this.network,
      txid: request.txid,
      inputsToSign: inputs.map((i) => ({ index: i.index, kind: i.kind, signatureOffset: i.signatureOffset })),
      scripts,
    });
    this.#log?.('[kastle] signTx txJson', request.txJson);
    let response: unknown;
    try {
      response = await this.#call('signTx', () => provider.signTx(this.network, request.txJson, scripts));
    } catch (e) {
      this.#log?.('[kastle] signTx error', e instanceof KastleError ? { code: e.code, message: e.message, covenantRefused: e.covenantRefused } : e);
      throw e;
    }
    this.#log?.('[kastle] signTx raw response', typeof response === 'string' ? response : JSON.stringify(response));
    const signed = kastleSignedJsonOf(response);
    this.#log?.('[kastle] signTx signature scripts', sigScriptSummary(signed));
    assertAnswerMatchesRequest(request, signed);
    return { request, signed };
  }

  /**
   * Kaspa personal-message signature of `message` by the connected account (hex, 64 bytes), verifiable with the SDK's
   * `verifyMessage` against the account's key. Network re-read first, like a transaction signature.
   */
  async signMessage(message: string): Promise<string> {
    const account = this.#account;
    if (account === null) throw new WalletNotConnected();
    const provider = this.#requireProvider();
    if (typeof provider.signMessage !== 'function') throw new KastleError('signMessage', KASTLE_METHOD_NOT_SUPPORTED, 'this Kastle version has no signMessage');
    await this.#assertNetwork(provider);
    if (this.#account !== account) throw new WalletNotConnected();
    this.#log?.('[kastle] signMessage request', message);
    let response: unknown;
    try {
      response = await this.#call('signMessage', () => provider.signMessage!(message));
    } catch (e) {
      this.#log?.('[kastle] signMessage error', e instanceof KastleError ? { code: e.code, message: e.message } : e);
      throw e;
    }
    this.#log?.('[kastle] signMessage raw response', response);
    return kastleMessageSignatureOf(response);
  }

  #requireProvider(): KastleProvider {
    const provider = this.#provider();
    if (provider === undefined) throw new WalletUnavailable(this.id);
    return provider;
  }

  async #assertNetwork(provider: KastleProvider): Promise<void> {
    const network = await this.#call('getNetwork', () => provider.getNetwork());
    if (network !== this.network) {
      this.#account = null;
      throw new WalletNetworkMismatch(this.network, network);
    }
  }

  async #logVersion(provider: KastleProvider): Promise<void> {
    if (this.#log === null || typeof provider.getVersion !== 'function') return;
    try {
      this.#log('[kastle] getVersion ->', await provider.getVersion());
    } catch {
      // Diagnostics only.
    }
  }

  async #call(method: string, run: () => Promise<unknown>): Promise<unknown> {
    try {
      return await run();
    } catch (e) {
      if (typeof e === 'string') throw new KastleError(method, e === 'User denied' ? 4001 : undefined, e);
      const err = e as { code?: unknown; message?: unknown };
      const message = typeof err?.message === 'string' ? err.message : String(e);
      const code = typeof err?.code === 'number' ? err.code : message === 'User denied' ? 4001 : undefined;
      throw new KastleError(method, code, message);
    }
  }

  #subscribe(provider: KastleProvider): void {
    if (this.#subscribed?.provider === provider) return;
    this.#unsubscribe();
    if (typeof provider.on !== 'function') return;
    const listeners = new Map<string, (...args: unknown[]) => void>();
    for (const event of EVENTS) {
      const listener = (...args: unknown[]): void => {
        this.#log?.(`[kastle] ${event}`, args[0]);
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

/** Create a Kastle adapter. */
export function createKastleAdapter(options: KastleOptions = {}): KastleAdapter {
  return new KastleAdapter(options);
}
