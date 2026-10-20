/**
 * The `SubmitState` machine, driven by the events of the submission path and
 * of reconciliation with the API.
 *
 *   built --signed--> signed --submitted--> submitted
 *   submitted | already-in-mempool
 *       --accepted-->  accepted --depth >= 10--> confirmed
 *       --rejected-->  the classified state (classify.ts)
 *       --conflict-->  lost-race (winner pending: mempool-spent; winner accepted: orphan)
 *       --unknown-->   lost-race orphan  (GET /v1/tx answered unknown: treat as lost, re-read the head)
 *       --replaced-->  replaced          (own pending transaction only, replace.ts)
 *   lost-race | fee-too-low | budget-too-low --rebuilt--> built
 *   budget-too-low --budget-patched--> signed   (budgets are outside the sighash: no new signature)
 *   fee-too-low --replaced--> replaced
 *   any non-terminal --failed--> failed
 *
 * `script-failed`, `replaced`, `failed` and `confirmed` are terminal (a
 * confirmed transaction only reports a greater depth). Every event that names
 * a transaction must name the current one. An event the table does not allow
 * throws `InvalidTransition`; the machine never guesses.
 */

import type { SubmitState } from '../types.ts';
import { classifyNodeRejection } from './classify.ts';

/** Depth after which an accepted transaction is final for the UI. */
export const CONFIRM_DEPTH = 10;

/** An event of the submission path. */
export type SubmitEvent =
  | { readonly kind: 'signed' }
  | { readonly kind: 'submitted'; readonly txid: string; readonly at: number }
  | { readonly kind: 'rejected'; readonly error: unknown; readonly budgets?: readonly number[] }
  | { readonly kind: 'accepted'; readonly txid: string; readonly acceptingBlueScore: number }
  | { readonly kind: 'depth'; readonly txid: string; readonly depth: number }
  | { readonly kind: 'conflict'; readonly txid: string; readonly winnerTxid: string; readonly winnerAccepted: boolean }
  | { readonly kind: 'unknown'; readonly txid: string }
  | { readonly kind: 'rebuilt' }
  | { readonly kind: 'budget-patched' }
  | { readonly kind: 'replaced'; readonly oldTxid: string; readonly newTxid: string }
  | { readonly kind: 'failed'; readonly reason: string };

/** An event the state table does not allow from the current state. */
export class InvalidTransition extends Error {
  /** The current state. */
  readonly state: SubmitState;
  /** The refused event. */
  readonly event: SubmitEvent;
  constructor(state: SubmitState, event: SubmitEvent, why = 'not allowed') {
    super(`submit state ${state.kind} cannot take event ${event.kind}: ${why}`);
    this.name = 'InvalidTransition';
    this.state = state;
    this.event = event;
  }
}

const TERMINAL: ReadonlySet<SubmitState['kind']> = new Set(['script-failed', 'replaced', 'failed']);
const IN_FLIGHT: ReadonlySet<SubmitState['kind']> = new Set(['submitted', 'already-in-mempool']);
const RETRYABLE: ReadonlySet<SubmitState['kind']> = new Set(['lost-race', 'fee-too-low', 'budget-too-low']);

/** Whether `s` is terminal (`script-failed`, `replaced`, `failed`). */
export function isTerminal(s: SubmitState): boolean {
  return TERMINAL.has(s.kind);
}

/** The txid a state refers to, if any. */
export function txidOf(s: SubmitState): string | undefined {
  if (s.kind === 'replaced') return s.newTxid;
  return 'txid' in s ? s.txid : undefined;
}

function sameTx(state: SubmitState, event: SubmitEvent, txid: string): void {
  const current = txidOf(state);
  if (current !== undefined && current !== txid) throw new InvalidTransition(state, event, `event names ${txid}, state is about ${current}`);
}

/** The state after `event` (pure). */
export function nextState(state: SubmitState, event: SubmitEvent): SubmitState {
  if (event.kind === 'failed') {
    if (isTerminal(state) || state.kind === 'confirmed') throw new InvalidTransition(state, event);
    return { kind: 'failed', reason: event.reason };
  }
  switch (state.kind) {
    case 'built':
      if (event.kind === 'signed') return { kind: 'signed' };
      break;
    case 'signed':
      if (event.kind === 'submitted') {
        if (!/^[0-9a-f]{64}$/.test(event.txid)) throw new InvalidTransition(state, event, 'txid is not 32-byte hex');
        return { kind: 'submitted', txid: event.txid, at: event.at };
      }
      break;
    case 'submitted':
    case 'already-in-mempool':
      switch (event.kind) {
        case 'accepted':
          sameTx(state, event, event.txid);
          return { kind: 'accepted', txid: event.txid, acceptingBlueScore: event.acceptingBlueScore };
        case 'rejected': {
          const r = classifyNodeRejection(event.error, event.budgets === undefined ? { txid: state.txid } : { txid: state.txid, budgets: event.budgets });
          // The node reporting our own transaction as already in its mempool keeps it in flight.
          return r;
        }
        case 'conflict':
          sameTx(state, event, event.txid);
          if (event.winnerTxid === event.txid) throw new InvalidTransition(state, event, 'a transaction cannot conflict with itself');
          return { kind: 'lost-race', txid: event.txid, winnerTxid: event.winnerTxid, cause: event.winnerAccepted ? 'orphan' : 'mempool-spent' };
        case 'unknown':
          sameTx(state, event, event.txid);
          return { kind: 'lost-race', txid: event.txid, cause: 'orphan' };
        case 'replaced':
          sameTx(state, event, event.oldTxid);
          if (event.newTxid === event.oldTxid) throw new InvalidTransition(state, event, 'a replacement has a new txid');
          return { kind: 'replaced', oldTxid: event.oldTxid, newTxid: event.newTxid };
        default:
          break;
      }
      break;
    case 'accepted':
      if (event.kind === 'accepted') {
        sameTx(state, event, event.txid);
        return { kind: 'accepted', txid: event.txid, acceptingBlueScore: event.acceptingBlueScore };
      }
      if (event.kind === 'depth') {
        sameTx(state, event, event.txid);
        return event.depth >= CONFIRM_DEPTH ? { kind: 'confirmed', txid: event.txid, depth: event.depth } : state;
      }
      break;
    case 'confirmed':
      if (event.kind === 'depth') {
        sameTx(state, event, event.txid);
        return event.depth > state.depth ? { kind: 'confirmed', txid: state.txid, depth: event.depth } : state;
      }
      break;
    case 'lost-race':
    case 'fee-too-low':
    case 'budget-too-low':
      if (event.kind === 'rebuilt') return { kind: 'built' };
      if (event.kind === 'budget-patched' && state.kind === 'budget-too-low') return { kind: 'signed' };
      if (event.kind === 'replaced' && state.kind === 'fee-too-low') {
        sameTx(state, event, event.oldTxid);
        return { kind: 'replaced', oldTxid: event.oldTxid, newTxid: event.newTxid };
      }
      break;
    default:
      break;
  }
  throw new InvalidTransition(state, event);
}

/** A submission's state with its history (for telemetry: every state it passed through, in order). */
export class SubmitMachine {
  #state: SubmitState;
  readonly #history: SubmitState[];

  constructor(initial: SubmitState = { kind: 'built' }) {
    this.#state = initial;
    this.#history = [initial];
  }

  get state(): SubmitState {
    return this.#state;
  }

  get history(): readonly SubmitState[] {
    return this.#history;
  }

  get inFlight(): boolean {
    return IN_FLIGHT.has(this.#state.kind);
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.#state.kind);
  }

  dispatch(event: SubmitEvent): SubmitState {
    const next = nextState(this.#state, event);
    if (next !== this.#state) {
      this.#state = next;
      this.#history.push(next);
    }
    return next;
  }
}
