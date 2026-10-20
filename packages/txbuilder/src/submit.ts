/**
 * Submission through our own node, rejection classification and acceptance.
 *
 * The node's rejection strings are authoritative and quote its numbers; the
 * classifier matches the exact rusty-kaspa v2.1.0 wordings recorded on
 * testnet-10:
 *
 *   budget      `script units exceeded the amount committed in the input: used=N, limit=M`
 *               (the input is not named; `M = budget * 10000 + 9999` identifies it when budgets are distinct)
 *   fee-too-low `... fees which is under the required amount of N for <bucket> mass M ...`
 *   lost-race   `output (<txid>, i) already spent by transaction <id> in the mempool`
 *   orphan      `transaction <id> is an orphan where orphan is disallowed`
 *   duplicate   `transaction <id> is already in the mempool`
 *   unminable   `transaction storage mass of N is larger than max allowed size of 500000`
 *   script      `failed to verify the signature script: script ran, but verification failed`
 *
 * Only the first two are retryable without new inputs: a budget rejection is
 * patched into the signed transaction (budgets are outside the sighash); a
 * fee rejection means the model disagreed with the node and needs a rebuild
 * with the node's number, which is recorded, never silently absorbed.
 * Retry after a lost race is the caller's policy (head-change triggered,
 * `submit/retry.ts`); this module reports the winner.
 */

import { toHex } from '@kasseal/codec';
import { type AssembledTx, type FundingUtxo, type Outpoint, addressOfSpk, hexToBytes, patchBudget } from './assemble.ts';
import { budgetCovering, budgetFromLimit, type Masses } from './mass.ts';
import type { SdkRpcClient, SdkUtxoEntryReference } from './sdk.ts';

/** A node rejection, classified from the node's own wording. */
export type Rejection =
  | { readonly kind: 'budget'; readonly used: number; readonly limit: number; readonly inputIndex: number | undefined; readonly message: string }
  | { readonly kind: 'fee-too-low'; readonly required: bigint; readonly bucket: string; readonly message: string }
  | { readonly kind: 'lost-race'; readonly outpoint: Outpoint | undefined; readonly winnerTxid: string; readonly message: string }
  | { readonly kind: 'orphan'; readonly message: string }
  | { readonly kind: 'duplicate'; readonly message: string }
  | { readonly kind: 'unminable'; readonly storageMass: number; readonly message: string }
  | { readonly kind: 'script-failure'; readonly message: string }
  | { readonly kind: 'other'; readonly message: string };

/** Classify a node rejection string. `budgets` (per input) resolves the budget rejection's input index. */
export function classifyRejection(message: string, budgets?: readonly number[]): Rejection {
  const s = String(message);
  const budget = /script units exceeded the amount committed in the input: used=(\d+), limit=(\d+)/.exec(s);
  if (budget) {
    const used = Number(budget[1]);
    const limit = Number(budget[2]);
    const b = budgetFromLimit(limit);
    const inputIndex = budgets && b !== undefined ? indexOfBudget(budgets, b) : undefined;
    return { kind: 'budget', used, limit, inputIndex, message: s };
  }
  const fee = /fees which is under the required amount of (\d+) for ([a-z ]*mass)/.exec(s);
  if (fee) return { kind: 'fee-too-low', required: BigInt(fee[1]!), bucket: fee[2]!.trim(), message: s };
  const race = /output \(([0-9a-f]{64}), (\d+)\) already spent by transaction ([0-9a-f]{64}) in the mempool/.exec(s);
  if (race) return { kind: 'lost-race', outpoint: { txid: race[1]!, index: Number(race[2]) }, winnerTxid: race[3]!, message: s };
  const race2 = /already spent by transaction ([0-9a-f]{64}) in the mempool/.exec(s);
  if (race2) return { kind: 'lost-race', outpoint: undefined, winnerTxid: race2[1]!, message: s };
  if (/is an orphan where orphan is disallowed/.test(s)) return { kind: 'orphan', message: s };
  if (/is already in the mempool/.test(s)) return { kind: 'duplicate', message: s };
  const storage = /storage mass of (\d+) is larger than max allowed size of 500000/.exec(s);
  if (storage) return { kind: 'unminable', storageMass: Number(storage[1]), message: s };
  if (/failed to verify the signature script/.test(s)) return { kind: 'script-failure', message: s };
  return { kind: 'other', message: s };
}

function indexOfBudget(budgets: readonly number[], budget: number): number | undefined {
  const matches = budgets.map((b, i) => (b === budget ? i : -1)).filter((i) => i >= 0);
  // Inputs are verified in index order; the lowest matching index is the one that failed.
  return matches.length > 0 ? matches[0] : undefined;
}

/** The node rejected the transaction; `rejection` says how. */
export class RejectedError extends Error {
  /** The classified rejection. */
  readonly rejection: Rejection;
  /** The rejected transaction. */
  readonly txid: string;
  constructor(txid: string, rejection: Rejection) {
    super(`transaction ${txid} rejected (${rejection.kind}): ${rejection.message}`);
    this.name = 'RejectedError';
    this.rejection = rejection;
    this.txid = txid;
  }
}

/** One submission attempt. */
export interface SubmitAttempt {
  /** Budgets submitted. */
  readonly budgets: readonly number[];
  /** Fee paid, sompi. */
  readonly fee: bigint;
  /** Whether the node accepted it into the mempool. */
  readonly ok: boolean;
  /** The rejection, when not ok. */
  readonly rejection?: Rejection;
}

/** The result of `submit`. */
export interface SubmitOutcome {
  /** The submitted transaction. */
  readonly txid: string;
  /** Every attempt, in order. */
  readonly attempts: readonly SubmitAttempt[];
  /** Budgets as finally accepted. */
  readonly budgets: readonly number[];
  /** The transaction's masses. */
  readonly masses: Masses;
}

/** The node's own error text, without the SDK's wrapper. */
export function errorMessage(e: unknown): string {
  return String((e as { message?: unknown })?.message ?? e);
}

/**
 * Submit a fully signed transaction. Budget rejections are patched (up to
 * `maxBudgetPatches`); the fee is never raised here (that requires a rebuild),
 * so a `fee-too-low` or any other rejection throws `RejectedError`.
 */
export async function submit(rpc: SdkRpcClient, built: AssembledTx, { maxBudgetPatches = 6 }: { maxBudgetPatches?: number } = {}): Promise<SubmitOutcome> {
  const attempts: SubmitAttempt[] = [];
  let current = built;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await rpc.submitTransaction({ transaction: current.tx, allowOrphan: false });
      attempts.push({ budgets: current.budgets, fee: current.fee, ok: true });
      if (r.transactionId !== current.txid) throw new Error(`node echoed txid ${r.transactionId}, expected ${current.txid}`);
      return { txid: current.txid, attempts, budgets: current.budgets, masses: current.masses };
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('node echoed txid')) throw e;
      const rejection = classifyRejection(errorMessage(e), current.budgets);
      attempts.push({ budgets: current.budgets, fee: current.fee, ok: false, rejection });
      if (rejection.kind === 'budget' && rejection.inputIndex !== undefined && attempt < maxBudgetPatches) {
        const next = Math.max(current.budgets[rejection.inputIndex]! + 1, budgetCovering(rejection.used));
        current = patchBudget(current, rejection.inputIndex, next);
        if (current.masses.minFee > current.fee) {
          throw new RejectedError(current.txid, { ...rejection, message: `${rejection.message} (budget ${next} makes compute the binding bucket; rebuild with the new budget)` });
        }
        continue;
      }
      throw new RejectedError(current.txid, rejection);
    }
  }
}

/** An output of an accepted transaction as the node's UTXO index reports it. */
export interface AcceptedCell {
  /** Output index. */
  readonly outputIndex: number;
  /** Address of its script. */
  readonly address: string;
  /** Value, sompi. */
  readonly amount: bigint;
  /** Covenant id, when bound. */
  readonly covenantId: string | undefined;
  /** Script public key, hex. */
  readonly spk: string;
  /** DAA score of the accepting block. */
  readonly daaScore: bigint;
}

/** The result of `waitForAcceptance`. */
export interface Acceptance {
  /** The accepted transaction. */
  readonly txid: string;
  /** DAA score of acceptance. */
  readonly daaScore: bigint;
  /** Its watched outputs. */
  readonly cells: readonly AcceptedCell[];
  /** Node-reported masses from the mempool entry when it was still visible (storage mass, compute mass). */
  readonly mempool: { readonly fee: bigint; readonly storageMass: bigint | undefined; readonly computeMass: bigint | undefined } | undefined;
}

/** Read the mempool entry right after submission (testnet-10 mines within ~100 ms; a few quick retries). */
export async function mempoolEntry(rpc: SdkRpcClient, txid: string, tries = 5): Promise<Acceptance['mempool']> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await rpc.getMempoolEntry({ transactionId: txid, includeOrphanPool: false, filterTransactionPool: false });
      const t = r.mempoolEntry.transaction;
      return { fee: r.mempoolEntry.fee, storageMass: t.storageMass ?? t.mass, computeMass: t.verboseData?.computeMass };
    } catch {
      await sleep(50);
    }
  }
  return undefined;
}

/** Fetch UTXOs of an address as plain funding UTXOs (non-coinbase), with their covenant ids when present. */
export async function utxosOf(rpc: SdkRpcClient, address: string): Promise<(FundingUtxo & { covenantId: string | undefined })[]> {
  const r = await rpc.getUtxosByAddresses([address]);
  return r.entries.filter((e) => !e.isCoinbase).map((e) => utxoOf(e, address));
}

function utxoOf(e: SdkUtxoEntryReference, address: string): FundingUtxo & { covenantId: string | undefined } {
  const covenantId = e.entry.covenantId?.toString();
  return {
    outpoint: { txid: e.outpoint.transactionId, index: e.outpoint.index },
    amount: e.amount,
    spk: hexToBytes(e.scriptPublicKey.script),
    daaScore: e.blockDaaScore,
    address,
    covenantId: covenantId === undefined || /^0+$/.test(covenantId) ? undefined : covenantId,
  };
}

/**
 * Wait until every covenant output of the transaction is in the UTXO index
 * (acceptance; inclusion precedes acceptance by ~120 ms). Polls each cell's P2SH address.
 */
export async function waitForAcceptance(rpc: SdkRpcClient, built: AssembledTx, networkId: string, { timeoutMs = 60_000, pollMs = 200 }: { timeoutMs?: number; pollMs?: number } = {}): Promise<Acceptance> {
  const wanted = built.outputs.filter((o) => o.cell !== undefined || o.binding !== undefined);
  const watch = wanted.length > 0 ? wanted : [built.outputs[built.outputs.length - 1]!];
  const deadline = Date.now() + timeoutMs;
  const found = new Map<number, AcceptedCell>();
  const mempool = await mempoolEntry(rpc, built.txid);
  while (Date.now() < deadline) {
    for (const o of watch) {
      if (found.has(o.index)) continue;
      const address = addressOfSpk(o.spk, networkId);
      const r = await rpc.getUtxosByAddresses([address]);
      const hit = r.entries.find((e) => e.outpoint.transactionId === built.txid && e.outpoint.index === o.index);
      if (hit) {
        found.set(o.index, { outputIndex: o.index, address, amount: hit.amount, covenantId: hit.entry.covenantId?.toString(), spk: hit.scriptPublicKey.script, daaScore: hit.blockDaaScore });
      }
    }
    if (found.size === watch.length) {
      const cells = [...found.values()].sort((a, b) => a.outputIndex - b.outputIndex);
      return { txid: built.txid, daaScore: cells[0]!.daaScore, cells, mempool };
    }
    await sleep(pollMs);
  }
  throw new Error(`${built.plan.name} ${built.txid}: not in the UTXO index after ${timeoutMs} ms (${found.size}/${watch.length} outputs seen)`);
}

/** Assert that an accepted cell matches what the builder predicted: amount, script, covenant id. */
export function assertAcceptedCell(built: AssembledTx, accepted: AcceptedCell): void {
  const o = built.outputs[accepted.outputIndex];
  if (!o) throw new Error(`no output ${accepted.outputIndex}`);
  if (accepted.amount !== o.value) throw new Error(`output ${o.index} "${o.label}": on-chain amount ${accepted.amount} != built ${o.value}`);
  if (accepted.spk !== toHex(o.spk)) throw new Error(`output ${o.index} "${o.label}": on-chain spk ${accepted.spk} != built ${toHex(o.spk)}`);
  const expectedId = o.cell?.covenantId ?? o.binding?.covenantId;
  if (expectedId !== undefined && accepted.covenantId !== expectedId) throw new Error(`output ${o.index} "${o.label}": on-chain covenant id ${accepted.covenantId} != ${expectedId}`);
}

/** Resolve after `ms` milliseconds. */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
