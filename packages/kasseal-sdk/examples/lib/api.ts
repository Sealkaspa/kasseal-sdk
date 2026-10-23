/**
 * A small client for the public Kasseal REST API: reads, submission and status. The builder's `UtxoSources` comes from
 * the SDK (`createApiSources`).
 *
 * Pure: no WASM is needed, so it works with the Node and the web entry. Testnet-10 only. The API sends every large
 * integer as a decimal string. Nothing here signs or holds keys.
 */
import { ApiError, outpointKey, type BuiltTx, type FundingUtxo, type KassealNetwork } from '@kassealhq/sdk';

export const NETWORK: KassealNetwork = 'testnet-10';
export const API_BASE = 'https://testnet.kasseal.com/v1';

/* -------------------------------------------------------------------------- */
/* HTTP                                                                        */
/* -------------------------------------------------------------------------- */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** GET with the two waits the API asks for: 429 (rate limit) and 503 `head-moving`. Both carry `retryAfterMs`. */
export async function get<T>(path: string, attempts = 5): Promise<T> {
  for (let i = 0; ; i++) {
    const res = await fetch(`${API_BASE}${path}`, { headers: { accept: 'application/json' } });
    if (res.ok) return (await res.json()) as T;
    const problem = (await res.json().catch(() => null)) as { retryAfterMs?: number } | null;
    if ((res.status === 429 || res.status === 503) && i + 1 < attempts) {
      await sleep((problem?.retryAfterMs ?? 1_000) + Math.floor(Math.random() * 250));
      continue;
    }
    throw new ApiError(path, res.status, problem);
  }
}

/* -------------------------------------------------------------------------- */
/* Wire shapes (see GET /v1/openapi.yaml)                                     */
/* -------------------------------------------------------------------------- */

/** A covenant cell as the API serves it. */
export interface CellWire {
  outpoint: { txid: string; index: number };
  /** The UTXO's KAS value, sompi. */
  amount: string;
  covenantId: string;
  redeemScript: string;
  templateHash: string;
  state: unknown;
  confirmed: boolean;
}

/** `GET /pools/{P}/cell`. */
export interface PoolCellWire extends CellWire {
  headSpent?: true;
  tip?: { pool: CellWire; reserve: CellWire; inventory?: CellWire; via: string[] };
}

/** `GET /tx/{txid}` and the `state` of `POST /tx`. */
export type SubmitStateWire =
  | { kind: 'submitted'; txid: string; at: number }
  | { kind: 'accepted'; txid: string; acceptingBlueScore: number }
  | { kind: 'confirmed'; txid: string; depth: number }
  | { kind: 'dropped'; txid: string }
  | { kind: 'fee-too-low' | 'budget-too-low' | 'lost-race' | 'already-in-mempool' | 'script-failed'; txid: string }
  | { kind: 'failed'; reason: string };

/* -------------------------------------------------------------------------- */
/* Retries                                                                     */
/* -------------------------------------------------------------------------- */

/** The wallet (plain KAS) outpoints a built transaction spends: the pin for a safe retry. */
export function walletInputsOf(built: Pick<BuiltTx, 'consumes'>, funding: readonly FundingUtxo[]): Set<string> {
  const own = new Set(funding.map((u) => outpointKey(u.outpoint)));
  return new Set(built.consumes.map(outpointKey).filter((k) => own.has(k)));
}

/* -------------------------------------------------------------------------- */
/* Submission and status                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `POST /tx`. 200: in the mempool. 409: the node refused it, classified (`lost-race`, `fee-too-low`...). Any other
 * answer, or no answer, means you do not know: ask `GET /tx/{txid}` before you build anything new.
 */
export async function submit(txJson: string): Promise<{ txid: string; state: SubmitStateWire } | { unknown: true; error: unknown }> {
  try {
    const res = await fetch(`${API_BASE}/tx`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ txJson }),
    });
    if (res.status === 200 || res.status === 409) return (await res.json()) as { txid: string; state: SubmitStateWire };
    return { unknown: true, error: new ApiError('/tx', res.status, await res.json().catch(() => null)) };
  } catch (error) {
    return { unknown: true, error };
  }
}

/** `GET /tx/{txid}`; null when the API never saw the transaction. */
export async function txStatus(txid: string): Promise<SubmitStateWire | null> {
  try {
    return await get<SubmitStateWire>(`/tx/${txid}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** Poll until the transaction is accepted, confirmed or definitely not going through. */
export async function waitForOutcome(txid: string, timeoutMs = 60_000): Promise<SubmitStateWire | null> {
  const end = Date.now() + timeoutMs;
  let last: SubmitStateWire | null = null;
  while (Date.now() < end) {
    last = await txStatus(txid);
    if (last !== null && (last.kind === 'accepted' || last.kind === 'confirmed' || last.kind === 'dropped' || last.kind === 'lost-race' || last.kind === 'script-failed')) return last;
    await sleep(500);
  }
  return last;
}
