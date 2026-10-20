/**
 * Sell tokens on a pool from a browser wallet (KasWare, Kastle or Kaspire), on testnet-10.
 *
 * This file is a module for a web page. It assumes the page has loaded the SDK's web entry once, which checks the
 * Kaspa WASM and the contract artifacts against their pinned hashes (see docs/wallets.md).
 *
 * A sell is never gated on the launch proof, so a holder can always leave. It still names the pool the proof
 * names whenever you have one, so the API cannot send the sell to another pool.
 */
import {
  NeedsConsolidation,
  NeedsSplit,
  createKasWareAdapter,
  createApiSources,
  createTxBuilder,
  signBuilt,
  xOnlyKeyOfAddress,
  type BuiltTx,
  type PublicTxBuilder,
  type WalletAdapter,
} from '@kassealhq/sdk/web';
import { API_BASE, NETWORK, submit, waitForOutcome } from './lib/api.ts';

export async function connect(): Promise<WalletAdapter> {
  // The network is explicit: the adapter refuses a wallet that is on another network.
  const wallet = createKasWareAdapter({ network: NETWORK, log: null });
  if (!wallet.isAvailable()) throw new Error('KasWare is not installed');
  await wallet.connect();
  return wallet;
}

/**
 * Sell exactly `tokens` from one of the wallet's token cells of that amount. When no cell holds exactly that amount,
 * the builder says what to do first (split one cell, or merge several), and nothing is signed.
 */
export async function sell(wallet: WalletAdapter, tokenId: string, poolId: string, tokens: bigint, minKasNet: bigint): Promise<string> {
  const account = wallet.getAccount();
  if (account === null) throw new Error('connect the wallet first');
  const xOnly = xOnlyKeyOfAddress(account.address);
  const sources = createApiSources({ baseUrl: API_BASE, network: NETWORK, tokenId, ownKey: account.publicKey });
  const builder: PublicTxBuilder = createTxBuilder({ sources, networkId: NETWORK });

  let built: BuiltTx;
  try {
    built = await builder.buildSwap({
      poolId,
      expectedPoolId: poolId,
      tokenId,
      trader: account.address,
      traderXOnlyPubkey: xOnly,
      side: 'tok->kas',
      amountIn: tokens, // the amount of one exact cell
      minNetOut: minKasNet, // refused before signing if the KAS reaching the wallet would be less
    });
  } catch (e) {
    if (e instanceof NeedsSplit) {
      // One extra signature: carve a cell of exactly `tokens`, wait for it, then sell.
      const split = await builder.buildSplit({ covenantId: tokenId, owner: account.address, ownerXOnlyPubkey: xOnly, cell: e.cell, carve: e.carve });
      throw new Error(`split first: sign and submit ${split.txid}, then sell again`);
    }
    if (e instanceof NeedsConsolidation) throw new Error('merge your token cells first (buildConsolidate), then sell');
    throw e;
  }

  // The wallet signs only the inputs listed in `inputsToSign` (your token cell and any KAS top-up), SIGHASH_ALL.
  // `signBuilt` then checks that the signed transaction has the same id as the one built.
  const signed = await signBuilt(wallet, built);
  const answer = await submit(signed.txJson);
  if ('unknown' in answer) return signed.txid; // ask GET /tx/{txid} before building anything new
  const outcome = await waitForOutcome(signed.txid);
  return `${signed.txid}: ${outcome?.kind ?? 'unknown'}`;
}
