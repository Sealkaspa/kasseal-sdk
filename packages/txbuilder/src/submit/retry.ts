/**
 * The client retry policy as a state machine over an injected clock and
 * random source, so an app, its tests and a load generator run the same
 * decisions.
 *
 *   trigger      a head change, never a timer: after `lost-race/mempool-spent` wait until the
 *                named winner is accepted (WS `curve.head` / `tx.status`), then back off
 *                120-200 ms (the UTXO index lags acceptance by ~120 ms p50) and re-read the head;
 *                or, when the winner is a link of the served pending tip (chained trades),
 *                re-read at once and build on the tip (`onWinnerInTip`);
 *                after `lost-race/orphan` re-read the head immediately (it already moved)
 *   silence      a winner not seen within 3 s, or our own transaction not heard of for 3 s,
 *                leads to a re-read or a `GET /v1/tx/:txid`
 *   budget       15 s of automatic retries from the first click, then "Busy curve"
 *   builder bugs `fee-too-low` and `budget-too-low` are retried once each with the node's number
 *                (neither was seen in 9,151 testnet-10 submissions), then surfaced
 *   never        `script-failed` (a require failed) and anything unclassified are surfaced at once;
 *                the client never replaces
 *
 * The machine only decides; `runSubmission` below is the driver that
 * executes the decisions through injected effects.
 */

import { budgetCovering, budgetFromLimit } from '../mass.ts';
import { MAX_SLIPPAGE_BPS } from '../slippage.ts';
import type { BuiltTx, SubmitState } from '../types.ts';

/** Timing of the retry policy, in milliseconds. */
export interface RetryPolicyConfig {
  /** Automatic retries stop this long after the first click. */
  readonly budgetMs: number;
  /** Back-off after the awaited winner was accepted, before the head is re-read (inclusive bounds). */
  readonly backoffMinMs: number;
  /** Upper bound of the back-off. */
  readonly backoffMaxMs: number;
  /** Silence after which a winner is assumed missed, or our own transaction's status is queried. */
  readonly silenceMs: number;
}

/** The default policy: 15 s budget, 120-200 ms back-off, 3 s silence. */
export const RETRY_POLICY: RetryPolicyConfig = Object.freeze({ budgetMs: 15_000, backoffMinMs: 120, backoffMaxMs: 200, silenceMs: 3_000 });

/** A millisecond clock (injected so tests can drive time). */
export interface Clock {
  /** Current time, ms. */
  now(): number;
}

/** Uniform in [0, 1). */
export type Random = () => number;

/** Why the policy stopped retrying. */
export type GiveUpReason = 'busy' | 'script-failed' | 'failed' | 'builder-bug';

/** What the policy tells the driver to do next. */
export type RetryAction =
  /** Wait until `winnerTxid` is accepted (head push or tx status), at most until `until`. */
  | { readonly kind: 'await-winner'; readonly winnerTxid: string; readonly until: number }
  /** Re-read the head at `at`, rebuild against it and resubmit (a new signature). */
  | { readonly kind: 'reread'; readonly at: number }
  /** Set one input's compute budget and resubmit the same signed transaction (budgets are outside the sighash). */
  | { readonly kind: 'patch-budget'; readonly inputIndex: number; readonly budget: number }
  /** Rebuild paying at least the node's required fee. */
  | { readonly kind: 'rebuild-with-fee'; readonly minFeeSompi: bigint }
  /** Our transaction is in flight: wait for its acceptance until `until`. */
  | { readonly kind: 'await-acceptance'; readonly txid: string; readonly until: number }
  /** Nothing heard: query `GET /v1/tx/:txid`. */
  | { readonly kind: 'check-status'; readonly txid: string }
  | { readonly kind: 'done'; readonly txid: string }
  /** Replaced by our own replacement; the new transaction is tracked on its own. */
  | { readonly kind: 'superseded'; readonly newTxid: string }
  | { readonly kind: 'give-up'; readonly reason: GiveUpReason; readonly state: SubmitState };

/** The policy was driven out of order (an event it was not waiting for, or a bad random value). */
export class RetryPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryPolicyError';
  }
}

/** The retry state machine; `runSubmission` drives it. */
export class RetryPolicy {
  readonly config: RetryPolicyConfig;
  readonly #clock: Clock;
  readonly #random: Random;
  #startedAt: number | undefined;
  #pending: RetryAction | undefined;
  #last: SubmitState | undefined;
  #feeRetries = 0;
  #budgetRetries = 0;
  #rereads = 0;

  constructor(clock: Clock, random: Random = Math.random, config: RetryPolicyConfig = RETRY_POLICY) {
    if (!(config.backoffMinMs >= 0 && config.backoffMaxMs >= config.backoffMinMs && config.budgetMs > 0 && config.silenceMs > 0)) throw new RetryPolicyError('invalid retry policy configuration');
    this.#clock = clock;
    this.#random = random;
    this.config = config;
  }

  /** Called once, at the first click. */
  start(): void {
    if (this.#startedAt !== undefined) throw new RetryPolicyError('retry policy already started');
    this.#startedAt = this.#clock.now();
  }

  get startedAt(): number {
    if (this.#startedAt === undefined) throw new RetryPolicyError('retry policy not started');
    return this.#startedAt;
  }

  get deadline(): number {
    return this.startedAt + this.config.budgetMs;
  }

  /** Re-reads of the head so far (one per rebuild after a lost race). */
  get rereads(): number {
    return this.#rereads;
  }

  /** The action awaiting an event or a timer, if any. */
  get pending(): RetryAction | undefined {
    return this.#pending;
  }

  /** The next action after a submission outcome or a state change of the current transaction. */
  onState(state: SubmitState): RetryAction {
    const now = this.#clock.now();
    this.#last = state;
    switch (state.kind) {
      case 'built':
      case 'signed':
        throw new RetryPolicyError(`state ${state.kind} is not a submission outcome`);
      case 'accepted':
      case 'confirmed':
        return this.#set({ kind: 'done', txid: state.txid });
      case 'replaced':
        return this.#set({ kind: 'superseded', newTxid: state.newTxid });
      case 'script-failed':
        return this.#giveUp('script-failed', state);
      case 'failed':
        return this.#giveUp('failed', state);
      case 'submitted':
      case 'already-in-mempool':
        return this.#inFlight(state.txid, now, state);
      case 'lost-race':
        if (state.cause === 'mempool-spent' && state.winnerTxid !== undefined) {
          if (now >= this.deadline) return this.#giveUp('busy', state);
          return this.#set({ kind: 'await-winner', winnerTxid: state.winnerTxid, until: Math.min(now + this.config.silenceMs, this.deadline) });
        }
        return this.#reread(now, state);
      case 'fee-too-low':
        if (this.#feeRetries >= 1) return this.#giveUp('builder-bug', state);
        if (now >= this.deadline) return this.#giveUp('busy', state);
        this.#feeRetries++;
        return this.#set({ kind: 'rebuild-with-fee', minFeeSompi: state.requiredSompi });
      case 'budget-too-low': {
        const committed = budgetFromLimit(state.limit);
        if (this.#budgetRetries >= 1 || state.inputIndex < 0 || committed === undefined) return this.#giveUp('builder-bug', state);
        if (now >= this.deadline) return this.#giveUp('busy', state);
        this.#budgetRetries++;
        return this.#set({ kind: 'patch-budget', inputIndex: state.inputIndex, budget: Math.max(committed + 1, budgetCovering(state.used)) });
      }
    }
  }

  /** The awaited winner reached the head: back off 120-200 ms, then re-read. */
  onWinnerAccepted(txid: string): RetryAction {
    const p = this.#pending;
    if (p?.kind !== 'await-winner' || p.winnerTxid !== txid) throw new RetryPolicyError(`not waiting for ${txid}`);
    const span = this.config.backoffMaxMs - this.config.backoffMinMs + 1;
    const r = this.#random();
    if (!(r >= 0 && r < 1)) throw new RetryPolicyError(`random source returned ${r}`);
    return this.#reread(this.#clock.now() + this.config.backoffMinMs + Math.floor(r * span), this.#last!);
  }

  /**
   * Chained trades: the awaited winner is a link of the pending tip the API serves,
   * so the rebuild goes on the tip now instead of after the winner's acceptance.
   */
  onWinnerInTip(txid: string): RetryAction {
    const p = this.#pending;
    if (p?.kind !== 'await-winner' || p.winnerTxid !== txid) throw new RetryPolicyError(`not waiting for ${txid}`);
    return this.#reread(this.#clock.now(), this.#last!);
  }

  /** A timer fired: decides what silence means for the pending action. */
  onTimer(): RetryAction {
    const now = this.#clock.now();
    const p = this.#pending;
    if (p === undefined) throw new RetryPolicyError('no pending action');
    if (p.kind === 'await-winner' && now >= p.until) return this.#reread(now, this.#last!);
    if (p.kind === 'await-acceptance' && now >= p.until) return now >= this.deadline ? this.#giveUp('busy', this.#last!) : this.#set({ kind: 'check-status', txid: p.txid });
    return p;
  }

  /** Answer of `GET /v1/tx/:txid` for our in-flight transaction. */
  onStatus(status: 'accepted' | 'in-mempool' | 'unknown'): RetryAction {
    const now = this.#clock.now();
    const last = this.#last;
    const txid = this.#pending?.kind === 'check-status' || this.#pending?.kind === 'await-acceptance' ? this.#pending.txid : undefined;
    if (txid === undefined || last === undefined) throw new RetryPolicyError('no transaction in flight');
    if (status === 'accepted') return this.#set({ kind: 'done', txid });
    if (status === 'in-mempool') return this.#inFlight(txid, now, last);
    return this.#reread(now, { kind: 'lost-race', txid, cause: 'orphan' });
  }

  #inFlight(txid: string, now: number, state: SubmitState): RetryAction {
    if (now >= this.deadline) return this.#giveUp('busy', state);
    return this.#set({ kind: 'await-acceptance', txid, until: Math.min(now + this.config.silenceMs, this.deadline) });
  }

  #reread(at: number, state: SubmitState): RetryAction {
    if (at >= this.deadline) return this.#giveUp('busy', state);
    this.#rereads++;
    return this.#set({ kind: 'reread', at });
  }

  #giveUp(reason: GiveUpReason, state: SubmitState): RetryAction {
    return this.#set({ kind: 'give-up', reason, state });
  }

  #set(a: RetryAction): RetryAction {
    this.#pending = a;
    return a;
  }
}

/**
 * Price-drift guard for a rebuild after a lost race: proceed without asking while the re-quoted amount stays within
 * `slippageBps` of the amount the user accepted. `cost` amounts (KAS paid) may not rise beyond it, `proceeds`
 * (KAS or tokens received) may not fall below it. The tolerance is refused outside `[0, MAX_SLIPPAGE_BPS]`.
 */
export function withinSlippage(p: { readonly quoted: bigint; readonly requoted: bigint; readonly slippageBps: number; readonly side: 'cost' | 'proceeds' }): boolean {
  if (!Number.isInteger(p.slippageBps) || p.slippageBps < 0 || p.slippageBps > MAX_SLIPPAGE_BPS) throw new RetryPolicyError(`slippage ${p.slippageBps} bps out of range`);
  if (p.quoted <= 0n || p.requoted < 0n) throw new RetryPolicyError('quotes must be positive');
  const bps = BigInt(p.slippageBps);
  return p.side === 'cost' ? p.requoted * 10_000n <= p.quoted * (10_000n + bps) : p.requoted * 10_000n >= p.quoted * (10_000n - bps);
}

/* -------------------------------------------------------------------------- */
/* Driver                                                                      */
/* -------------------------------------------------------------------------- */

/** What a rebuild must respect after a fee or budget rejection. */
export interface BuildHint {
  /** The node's required fee, sompi. */
  readonly minFeeSompi?: bigint;
  /** A budget the node asked for. */
  readonly budget?: { readonly inputIndex: number; readonly budget: number };
}

/** The effects `runSubmission` performs: building, signing, submitting and waiting. */
export interface SubmissionEffects {
  /** The clock. */
  readonly clock: Clock;
  /** Random source for the back-off (default `Math.random`). */
  readonly random?: Random;
  /** Resolves at (or after) clock time `t`. */
  sleepUntil(t: number): Promise<void>;
  /** Read the head and build; `minFeeSompi` after a fee rejection, `budget` after a budget rejection the fee no longer covers. */
  build(hint: BuildHint): Promise<BuiltTx>;
  /** Re-quote consent for a rebuild (the slippage guard); false stops with `failed`. */
  approve?(built: BuiltTx, rebuild: number): Promise<boolean>;
  /** Wallet signature and finalize (one popup). */
  sign(built: BuiltTx): Promise<BuiltTx>;
  /** Submit and classify: `submitted` or a rejection state. */
  submit(built: BuiltTx): Promise<SubmitState>;
  /** The same signed transaction with one budget changed, or undefined when the fee no longer covers it (rebuild). */
  patchBudget(built: BuiltTx, inputIndex: number, budget: number): BuiltTx | undefined;
  /** Resolves with the accepting blue score when `txid` is accepted before clock time `until`, else undefined. */
  waitForAcceptance(txid: string, until: number): Promise<number | undefined>;
  /** `GET /v1/tx/:txid`: whether the transaction is accepted, in the mempool or unknown. */
  status(txid: string): Promise<'accepted' | 'in-mempool' | 'unknown'>;
  /** Every state the current transaction passes through (for logging and the optimistic store). */
  onState?(state: SubmitState, built: BuiltTx | undefined): void;
}

/** How a submission ended. */
export interface SubmissionResult {
  /** The final action: done, superseded or given up. */
  readonly outcome: Extract<RetryAction, { kind: 'done' | 'give-up' | 'superseded' }>;
  /** The last transaction built (signed when it was submitted). */
  readonly built: BuiltTx | undefined;
  /** Submissions made. */
  readonly submissions: number;
  /** Rebuilds made. */
  readonly rebuilds: number;
  /** Wall time from start to the outcome, ms. */
  readonly elapsedMs: number;
}

/** Runs one user action to acceptance or to a surfaced outcome, following `RetryPolicy`. */
export async function runSubmission(fx: SubmissionEffects, config: RetryPolicyConfig = RETRY_POLICY): Promise<SubmissionResult> {
  const policy = new RetryPolicy(fx.clock, fx.random ?? Math.random, config);
  policy.start();
  let submissions = 0;
  let rebuilds = 0;
  let hint: BuildHint = {};
  let built: BuiltTx | undefined;
  let signed: BuiltTx | undefined;
  const report = (s: SubmitState): void => fx.onState?.(s, signed ?? built);
  const finish = (outcome: SubmissionResult['outcome']): SubmissionResult => ({ outcome, built: signed ?? built, submissions, rebuilds, elapsedMs: fx.clock.now() - policy.startedAt });

  let action: RetryAction = { kind: 'reread', at: fx.clock.now() };
  for (;;) {
    switch (action.kind) {
      case 'done':
      case 'give-up':
      case 'superseded':
        return finish(action);
      case 'reread':
      case 'rebuild-with-fee': {
        if (action.kind === 'reread') await fx.sleepUntil(action.at);
        else hint = { ...hint, minFeeSompi: action.minFeeSompi };
        if (built !== undefined) rebuilds++;
        built = await fx.build(hint);
        report({ kind: 'built' });
        if (rebuilds > 0 && fx.approve !== undefined && !(await fx.approve(built, rebuilds))) {
          const state: SubmitState = { kind: 'failed', reason: 'price moved beyond the accepted slippage' };
          report(state);
          return finish({ kind: 'give-up', reason: 'failed', state });
        }
        signed = await fx.sign(built);
        report({ kind: 'signed' });
        action = await submitOnce(signed);
        break;
      }
      case 'patch-budget': {
        const patched = fx.patchBudget(signed!, action.inputIndex, action.budget);
        if (patched === undefined) {
          hint = { ...hint, budget: { inputIndex: action.inputIndex, budget: action.budget } };
          if (built !== undefined) rebuilds++;
          built = await fx.build(hint);
          report({ kind: 'built' });
          signed = await fx.sign(built);
          report({ kind: 'signed' });
          action = await submitOnce(signed);
          break;
        }
        signed = patched;
        report({ kind: 'signed' });
        action = await submitOnce(signed);
        break;
      }
      case 'await-winner': {
        const r = await fx.waitForAcceptance(action.winnerTxid, action.until);
        action = r !== undefined ? policy.onWinnerAccepted(action.winnerTxid) : await timer(action.until);
        break;
      }
      case 'await-acceptance': {
        const r = await fx.waitForAcceptance(action.txid, action.until);
        if (r !== undefined) {
          const accepted: SubmitState = { kind: 'accepted', txid: action.txid, acceptingBlueScore: r };
          report(accepted);
          action = policy.onState(accepted);
        } else {
          action = await timer(action.until);
        }
        break;
      }
      case 'check-status':
        action = policy.onStatus(await fx.status(action.txid));
        break;
    }
  }

  async function timer(until: number): Promise<RetryAction> {
    await fx.sleepUntil(until);
    return policy.onTimer();
  }

  async function submitOnce(tx: BuiltTx): Promise<RetryAction> {
    submissions++;
    const state = await fx.submit(tx);
    report(state);
    return policy.onState(state);
  }
}
