/**
 * Classification of the node's submission rejections into `SubmitState`
 * The node's strings are authoritative and quote its numbers; each pattern
 * below is the exact rusty-kaspa v2.1.0 wording recorded on testnet-10,
 * anchored on both ends, after the wrapper
 * `[RPC Server (remote error) -> ]Rejected transaction <txid>: `:
 *
 *   output (<id>, <i>) already spent by transaction <winner> in the mempool       lost-race, mempool-spent, winner named
 *   transaction <id> is an orphan where orphan is disallowed                      lost-race, orphan (stale head)
 *   transaction <id> is already in the mempool                                    already-in-mempool
 *   transaction <id> was already accepted by the consensus                        already-in-mempool (the node has it)
 *   failed to verify the signature script: script units exceeded the amount
 *     committed in the input: used=N, limit=M                                     budget-too-low; the input is the one whose
 *                                                                                 budget b satisfies M = b * 10000 + 9999
 *   [transaction <id> is not standard: ]transaction has F fees which is under
 *     the required amount of N for <compute|normalized transient|storage> mass M
 *     [(proportional to transaction byte size)]                                   fee-too-low, requiredSompi N
 *   failed to verify the signature script: script ran, but verification failed    script-failed (a require failed)
 *   failed to verify the signature script: false stack entry at end of script
 *     execution                                                                   script-failed (signature did not verify)
 *
 * Anything else, including a rejection that names another transaction than
 * the one submitted, is `failed` with the node's text as the reason. Among
 * the recorded strings that are: `transaction storage mass of N is larger
 * than max allowed size of 500000`, `transaction transient (storage) mass of
 * N is larger than max allowed size of 1000000` and `transaction compute mass
 * of N is larger than max allowed size of 500000` (a shape the builder's
 * `assertMinable` refuses before signing).
 *
 * A budget rejection does not name the input. Inputs are verified in index
 * order, so the lowest input whose budget matches `limit` is reported; when
 * no budget matches (or none are given), `inputIndex` is -1 and the retry
 * policy surfaces the rejection instead of patching.
 */

import { budgetFromLimit } from '../mass.ts';
import type { SubmitState } from '../types.ts';

/** The `SubmitState`s a node rejection can map to. */
export type RejectionState = Extract<SubmitState, { kind: 'fee-too-low' | 'budget-too-low' | 'lost-race' | 'already-in-mempool' | 'script-failed' | 'failed' }>;

/** What `classifyNodeRejection` knows about the submitted transaction. */
export interface ClassifyContext {
  /** The txid that was submitted; a rejection naming another transaction is `failed`. */
  readonly txid?: string;
  /** Per-input compute budgets of the submitted transaction, to attribute a budget rejection. */
  readonly budgets?: readonly number[];
}

const ID = '([0-9a-f]{64})';
const WRAPPER = new RegExp(`^(?:RPC Server \\(remote error\\) -> )?Rejected transaction ${ID}: (.*)$`, 's');
const MEMPOOL_SPENT = new RegExp(`^output \\(${ID}, (\\d+)\\) already spent by transaction ${ID} in the mempool$`);
const ORPHAN = new RegExp(`^transaction ${ID} is an orphan where orphan is disallowed$`);
const DUPLICATE = new RegExp(`^transaction ${ID} is already in the mempool$`);
/** A re-sent transaction the network already accepted: it took effect once; not a failure. */
const ALREADY_ACCEPTED = new RegExp(`^transaction ${ID} was already accepted by the consensus$`);
const BUDGET = /^failed to verify the signature script: script units exceeded the amount committed in the input: used=(\d+), limit=(\d+)$/;
const FEE = new RegExp(`^(?:transaction ${ID} is not standard: )?transaction has (\\d+) fees which is under the required amount of (\\d+) for (compute|normalized transient|storage) mass (\\d+)(?: \\(proportional to transaction byte size\\))?$`);
const SCRIPT_FAILED = /^failed to verify the signature script: (?:script ran, but verification failed|false stack entry at end of script execution)$/;

const BUCKET: Readonly<Record<string, 'compute' | 'transient' | 'storage'>> = { compute: 'compute', 'normalized transient': 'transient', storage: 'storage' };

/** The node's message of a thrown submission error (the SDK throws strings as well as errors). */
export function rejectionMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  const m = (error as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m : String(error);
}

/** Classify a submission rejection (an error or its message) into a `SubmitState`. */
export function classifyNodeRejection(error: unknown, context: ClassifyContext = {}): RejectionState {
  const message = rejectionMessage(error).trim();
  const wrapped = WRAPPER.exec(message);
  if (!wrapped) return { kind: 'failed', reason: message };
  const rejected = wrapped[1]!;
  const body = wrapped[2]!;
  if (context.txid !== undefined && context.txid.toLowerCase() !== rejected) return { kind: 'failed', reason: `rejection names ${rejected}, submitted ${context.txid}: ${message}` };
  const txid = rejected;

  const spent = MEMPOOL_SPENT.exec(body);
  if (spent) return { kind: 'lost-race', txid, winnerTxid: spent[3]!, cause: 'mempool-spent' };
  const orphan = ORPHAN.exec(body);
  if (orphan && orphan[1] === txid) return { kind: 'lost-race', txid, cause: 'orphan' };
  const duplicate = DUPLICATE.exec(body);
  if (duplicate && duplicate[1] === txid) return { kind: 'already-in-mempool', txid };
  const accepted = ALREADY_ACCEPTED.exec(body);
  if (accepted && accepted[1] === txid) return { kind: 'already-in-mempool', txid };
  const budget = BUDGET.exec(body);
  if (budget) {
    const used = Number(budget[1]);
    const limit = Number(budget[2]);
    const b = budgetFromLimit(limit);
    const inputIndex = b === undefined || context.budgets === undefined ? -1 : context.budgets.indexOf(b);
    return { kind: 'budget-too-low', txid, inputIndex, used, limit };
  }
  const fee = FEE.exec(body);
  if (fee && (fee[1] === undefined || fee[1] === txid)) return { kind: 'fee-too-low', txid, requiredSompi: BigInt(fee[3]!), bucket: BUCKET[fee[4]!]! };
  if (SCRIPT_FAILED.test(body)) return { kind: 'script-failed', txid };
  return { kind: 'failed', reason: message };
}
