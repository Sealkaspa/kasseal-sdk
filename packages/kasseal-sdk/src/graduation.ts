/**
 * The graduation check against the public Kaspa REST API, a source Kasseal does not operate. Step 9 of the launch
 * proof runs on the graduation transaction the Kasseal API serves; a compromised or intercepted API could serve a
 * doctored one naming a counterfeit pool. This recomputes the served transaction's id (it commits to every spent
 * outpoint and every output, covenant bindings included) and asks the public API whether that transaction was
 * accepted, and whether its signature scripts (not part of the id; step 9 reads the reserve's program from them) are
 * the served ones.
 */
import { txidV1, type PlainTx } from '../../codec/src/kip24.ts';
import { launchProofFromJson } from '../../codec/src/kcc0023.ts';
import { assertNetwork, type KassealNetwork } from './networks.ts';

/**
 * The outcome of the graduation check.
 *
 * - `confirmed`: accepted on chain with the served signature scripts.
 * - `mismatch`: the public API has that transaction with other inputs or signature scripts, or the bundle's
 *   graduation does not parse. The proof is `invalid`.
 * - `not-found`: no accepted transaction with that id: not indexed yet (seconds after a graduation) or never mined.
 *   The pool is not proven until it is found: treat the proof as `unverified` and ask again.
 * - `unavailable`: the public API could not be read, or its answer lacks the fields the check reads. The proof
 *   stands as checked from the served data.
 * - `none`: the token has not graduated.
 */
export type GraduationOnChain = 'confirmed' | 'mismatch' | 'not-found' | 'unavailable' | 'none';

/** The public Kaspa REST API of each network (not operated by Kasseal). */
export const PUBLIC_KASPA_API: Readonly<Record<KassealNetwork, string>> = Object.freeze({
  mainnet: 'https://api.kaspa.org',
  'testnet-10': 'https://api-tn10.kaspa.org',
});

/** A transaction as the public Kaspa REST API returns it (only the fields the check reads). */
export interface PublicApiTransaction {
  readonly transaction_id?: unknown;
  readonly is_accepted?: unknown;
  readonly inputs?: readonly { readonly index?: unknown; readonly previous_outpoint_hash?: unknown; readonly previous_outpoint_index?: unknown; readonly signature_script?: unknown }[] | null;
}

/**
 * Compare the public API's answer with the served graduation transaction (whose id `txid` the caller recomputed).
 * Only present values that differ are a mismatch; an answer missing a field the check reads is `unavailable`.
 */
export function compareGraduationWithChain(tx: PlainTx, txid: string, chain: PublicApiTransaction): Exclude<GraduationOnChain, 'none'> {
  const str = (v: unknown): v is string => typeof v === 'string';
  const int = (v: unknown): boolean => (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) && Number.isSafeInteger(Number(v));
  if (!str(chain.transaction_id) || typeof chain.is_accepted !== 'boolean') return 'unavailable';
  if (chain.transaction_id.toLowerCase() !== txid.toLowerCase()) return 'mismatch';
  if (!chain.is_accepted) return 'not-found';
  if (!Array.isArray(chain.inputs)) return 'unavailable';
  if (chain.inputs.some((c) => !int(c.index) || !str(c.previous_outpoint_hash) || !int(c.previous_outpoint_index) || !str(c.signature_script))) return 'unavailable';
  const ins = [...chain.inputs].sort((a, b) => Number(a.index) - Number(b.index));
  if (ins.length !== tx.inputs.length) return 'mismatch';
  for (const [k, i] of tx.inputs.entries()) {
    const c = ins[k]!;
    if (Number(c.index) !== k) return 'mismatch';
    if (String(c.previous_outpoint_hash).toLowerCase() !== i.transactionId.toLowerCase() || Number(c.previous_outpoint_index) !== i.index) return 'mismatch';
    if (String(c.signature_script).toLowerCase() !== i.signatureScript.toLowerCase()) return 'mismatch';
  }
  return 'confirmed';
}

/** Options of `graduationOnChain`. */
export interface GraduationOnChainOptions {
  /** The fetch to use (default: the global `fetch`). */
  readonly fetch?: typeof fetch;
  /** Request timeout in milliseconds (default 8000). */
  readonly timeoutMs?: number;
  /** Another public Kaspa REST API base URL than `PUBLIC_KASPA_API[network]`. */
  readonly baseUrl?: string;
}

/**
 * Whether a launch-proof bundle's graduation (the JSON `GET /tokens/{id}/launch-proof` serves) is the transaction the
 * network accepted. Never throws. Run it after `verifyLaunchProofJson` returned `bound` for a graduated token: on
 * `mismatch` treat the proof as `invalid`, on `not-found` as `unverified`; on `confirmed` or `unavailable` it stays
 * `bound`. Nothing is cached: a caller that checks often should keep the final answers (`confirmed`, `mismatch`).
 */
export async function graduationOnChain(json: unknown, network: KassealNetwork, options: GraduationOnChainOptions = {}): Promise<GraduationOnChain> {
  assertNetwork(network);
  let tx: PlainTx;
  let txid: string;
  try {
    const g = launchProofFromJson(json).graduation;
    if (g === null || g === undefined) return 'none';
    tx = g.tx;
    txid = txidV1(tx).txid;
  } catch {
    return 'mismatch';
  }
  const base = (options.baseUrl ?? PUBLIC_KASPA_API[network]).replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), options.timeoutMs ?? 8_000);
  try {
    const r = await doFetch(`${base}/transactions/${txid}?inputs=true&outputs=false&resolve_previous_outpoints=no`, { signal: ctl.signal });
    // 404: not indexed yet, or never mined. Anything else not OK: unreadable.
    if (r.status === 404) return 'not-found';
    if (!r.ok) return 'unavailable';
    return compareGraduationWithChain(tx, txid, (await r.json()) as PublicApiTransaction);
  } catch {
    return 'unavailable';
  } finally {
    clearTimeout(timer);
  }
}
