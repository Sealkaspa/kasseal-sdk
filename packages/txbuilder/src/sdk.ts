/**
 * The rusty-kaspa WASM SDK (v2.1.0, bundled and checksum-verified) and the
 * small set of its types the builder uses.
 *
 * The SDK is used for: transaction objects and their serialisation, genesis
 * binding population (`populateGenesisCovenants`), `finalize()` (the cached
 * `Transaction.id` is stale after any output, binding or payload mutation),
 * Schnorr input signatures, address and P2PK
 * script helpers, and the RPC client. Everything consensus-critical that the
 * SDK gets wrong or does not expose is implemented here instead: the mass and
 * fee model (`mass.ts`, SDK functions ignore `computeBudget` and plurality),
 * the P2SH hash and KIP-20 covenant id and the KIP-24 txid (the codec's
 * `blake2b.ts`, `kip24.ts`), the v1 sighash (`wallet/sighash.ts`) and every
 * KCC-1 sigscript (`sigscript.ts` over the codec's `program.ts`).
 *
 * This module is shared by both builds and imports no SDK code itself (the
 * imports below are types only). The Node entry installs a loader that hashes
 * the bundled Node build against its pinned SHA-256 sums before requiring it;
 * the web entry installs the bundled web build after instantiating its WASM,
 * whose bytes it checks against the pinned hash.
 */

import type { KaspaSdk } from '@kasseal/sdk';
import type { ITransactionInput } from '@kasseal/sdk/vendor/nodejs/kaspa/kaspa.js';

export type { ITransactionInput as SdkTransactionInputInit };

export type { KaspaSdk };
/** The Kaspa SDK namespace. */
export type Kaspa = KaspaSdk;
/** The SDK's `Transaction`. */
export type SdkTransaction = InstanceType<KaspaSdk['Transaction']>;
/** The SDK's `TransactionOutput`. */
export type SdkTransactionOutput = InstanceType<KaspaSdk['TransactionOutput']>;
/** The SDK's `RpcClient`. */
export type SdkRpcClient = InstanceType<KaspaSdk['RpcClient']>;
/** The SDK's `PrivateKey`. */
export type SdkPrivateKey = InstanceType<KaspaSdk['PrivateKey']>;
/** The SDK's `UtxoEntryReference`. */
export type SdkUtxoEntryReference = KaspaSdk['UtxoEntryReference']['prototype'];

/** The upstream version both vendored builds must report. */
export const SDK_VERSION = '2.1.0';

/** The Kaspa SDK was used before an entry installed it. */
export class SdkNotInstalled extends Error {
  constructor() {
    super('the Kaspa SDK is not installed: import the package through its Node entry, or await initWeb() first');
    this.name = 'SdkNotInstalled';
  }
}

let installed: KaspaSdk | undefined;
let loader: (() => KaspaSdk) | undefined;

/** Install a verified SDK namespace. Refuses one that does not report `SDK_VERSION`. */
export function installSdk(k: KaspaSdk): void {
  const v = typeof k.version === 'function' ? k.version() : undefined;
  if (v !== SDK_VERSION) throw new Error(`SDK reports version ${JSON.stringify(v)}, expected ${SDK_VERSION}`);
  installed = k;
}

/** Register a synchronous loader used on first access (the Node entry's `loadSdk`). */
export function registerSdkLoader(load: () => KaspaSdk): void {
  loader = load;
}

/** True once an SDK is installed or a loader is registered. */
export function sdkAvailable(): boolean {
  return installed !== undefined || loader !== undefined;
}

/** The verified SDK namespace. */
export function sdk(): KaspaSdk {
  if (installed === undefined) {
    if (loader === undefined) throw new SdkNotInstalled();
    installSdk(loader());
  }
  return installed!;
}

/** The default network id where a caller passes none (`testnet-10`); pass the network explicitly. */
export const NETWORK_ID = 'testnet-10';
