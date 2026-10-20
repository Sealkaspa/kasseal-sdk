/**
 * Replacement of our own pending transaction:
 * `submitTransactionReplacement` with a strictly higher feerate, by default
 * +0.1 % (35 of 35 testnet-10 replacements won at 50 ms RTT; +1 sompi already
 * wins, the node's rule is strictly greater).
 *
 * Permitted only when
 *   - the transaction is in the caller's own `pending[]` (the replacement must
 *     conflict with exactly one mempool transaction, ours),
 *   - its state is in flight (`submitted`, `already-in-mempool`) or
 *     `fee-too-low`, and
 *   - the replacement spends exactly the same outpoints (no other funding
 *     input), pays every output the same except the signer's change or payout,
 *     and shares no outpoint with any other pending transaction of ours.
 *
 * Never on `lost-race`: a loser cannot replace the winner without taking the
 * fill from another user, and within the 0.9 s window any co-located party
 * wins that auction anyway. The app's client path does not replace at all;
 * this primitive serves server-side submitters and an explicit, labelled user
 * action ("replacing your earlier
 * transaction at a higher fee").
 *
 * The feerate is fee over the binding mass (`masses.max`); the comparison is
 * exact in integers: fee' * mass * 10^6 >= fee * mass' * (10^6 + bump_ppm),
 * and fee' * mass > fee * mass'.
 */

import { outpointKey, type Outpoint } from '../assemble.ts';
import type { BuiltTx, OutputRole, SubmitState } from '../types.ts';

/** Default feerate bump of a replacement: +0.1 %. */
export const REPLACEMENT_BUMP = 0.001;

/** What the replacement path needs to know about each of our pending transactions. */
export interface PendingRef {
  /** Transaction id. */
  readonly txid: string;
  /** Outpoints it spends. */
  readonly consumes: readonly Outpoint[];
}

/** A replacement is not allowed or did not come out as required; nothing is submitted. */
export class ReplacementRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplacementRefused';
  }
}

const REPLACEABLE: ReadonlySet<SubmitState['kind']> = new Set(['submitted', 'already-in-mempool', 'fee-too-low']);
const CHANGE_ROLES: ReadonlySet<OutputRole> = new Set(['change', 'payout']);

function bumpPpm(bump: number): bigint {
  if (!Number.isFinite(bump) || bump < 0 || bump > 1) throw new ReplacementRefused(`bump ${bump} out of range`);
  return BigInt(Math.round(bump * 1_000_000));
}

/** The smallest fee whose feerate over the same mass is at least `(1 + bump)` times the original and strictly greater. */
export function replacementMinFee(feeSompi: bigint, bump: number = REPLACEMENT_BUMP): bigint {
  if (feeSompi <= 0n) throw new ReplacementRefused('original fee must be positive');
  const ppm = bumpPpm(bump);
  const bumped = (feeSompi * (1_000_000n + ppm) + 999_999n) / 1_000_000n;
  return bumped > feeSompi ? bumped : feeSompi + 1n;
}

/** Refuses a replacement the policy does not permit for this transaction and state. */
export function assertReplaceable(built: BuiltTx, state: SubmitState, pending: readonly PendingRef[]): void {
  if (state.kind === 'lost-race') throw new ReplacementRefused('a lost race is never replaced: rebuild at the new head instead');
  if (!REPLACEABLE.has(state.kind)) throw new ReplacementRefused(`state ${state.kind} is not replaceable`);
  if ('txid' in state && state.txid !== built.txid) throw new ReplacementRefused(`state is about ${state.txid}, not ${built.txid}`);
  if (!pending.some((p) => p.txid === built.txid)) throw new ReplacementRefused(`${built.txid} is not one of our pending transactions`);
}

interface JsonOutput {
  value: string | number;
  scriptPublicKey: string;
  covenant?: { authorizingInput: number; covenantId: string } | null;
}

function outputsOf(b: BuiltTx): JsonOutput[] {
  return (JSON.parse(b.txJson) as { outputs: JsonOutput[] }).outputs;
}

/** Checks a rebuilt transaction against the one it replaces (see the module comment). */
export function assertReplacement(old: BuiltTx, next: BuiltTx, pending: readonly PendingRef[], bump: number = REPLACEMENT_BUMP): void {
  if (next.txid === old.txid) throw new ReplacementRefused('the replacement has the same txid');
  const oldIns = old.consumes.map(outpointKey).sort();
  const newIns = next.consumes.map(outpointKey).sort();
  if (oldIns.length !== newIns.length || oldIns.some((k, i) => k !== newIns[i])) throw new ReplacementRefused('the replacement must spend exactly the same outpoints');
  const mine = new Set(newIns);
  for (const p of pending) {
    if (p.txid === old.txid) continue;
    const shared = p.consumes.find((o) => mine.has(outpointKey(o)));
    if (shared) throw new ReplacementRefused(`the replacement would also conflict with our pending ${p.txid} on ${outpointKey(shared)}`);
  }

  const a = outputsOf(old);
  const b = outputsOf(next);
  if (a.length !== b.length) throw new ReplacementRefused('the replacement changes the output count');
  const roles = new Map(old.produces.map((p) => [p.index, p.role]));
  const nextRoles = new Map(next.produces.map((p) => [p.index, p.role]));
  a.forEach((o, i) => {
    const n = b[i]!;
    if (roles.get(i) !== nextRoles.get(i)) throw new ReplacementRefused(`output ${i} changes its role`);
    const sameBinding = (o.covenant ?? null) === null ? (n.covenant ?? null) === null : n.covenant !== null && n.covenant !== undefined && o.covenant!.authorizingInput === n.covenant.authorizingInput && o.covenant!.covenantId === n.covenant.covenantId;
    if (o.scriptPublicKey !== n.scriptPublicKey || !sameBinding) throw new ReplacementRefused(`output ${i} changes its script or binding`);
    const role = roles.get(i);
    if (role !== undefined && CHANGE_ROLES.has(role)) {
      if (BigInt(n.value) > BigInt(o.value)) throw new ReplacementRefused(`output ${i} (${role}) grows in the replacement`);
    } else if (BigInt(n.value) !== BigInt(o.value)) {
      throw new ReplacementRefused(`output ${i} changes its value; only the change or payout may pay for the bump`);
    }
  });

  const oldMass = BigInt(old.masses.max);
  const newMass = BigInt(next.masses.max);
  if (oldMass <= 0n || newMass <= 0n) throw new ReplacementRefused('masses must be positive');
  const ppm = bumpPpm(bump);
  if (!(next.feeSompi * oldMass > old.feeSompi * newMass)) throw new ReplacementRefused('the replacement feerate is not strictly greater');
  if (next.feeSompi * oldMass * 1_000_000n < old.feeSompi * newMass * (1_000_000n + ppm)) throw new ReplacementRefused(`the replacement feerate is below the +${Number(ppm) / 10_000} % bump`);
}

/** The effects `replace` performs. */
export interface ReplaceEffects {
  /** Rebuild the same action over the same outpoints paying at least `minFeeSompi`. */
  rebuild(minFeeSompi: bigint): Promise<BuiltTx>;
  /** Wallet signature and finalize (one popup). */
  sign(built: BuiltTx): Promise<BuiltTx>;
  /** `submitTransactionReplacement`: the new transaction id and the id of the transaction it replaced. */
  submitReplacement(signed: BuiltTx): Promise<{ readonly transactionId: string; readonly replacedTxid: string }>;
}

/** Replace our own pending `built` at a feerate `bump` higher (default +0.1 %). Returns the `replaced` state and the new transaction. */
export async function replace(
  built: BuiltTx,
  p: { readonly state: SubmitState; readonly pending: readonly PendingRef[]; readonly bump?: number } & ReplaceEffects,
): Promise<{ state: Extract<SubmitState, { kind: 'replaced' }>; built: BuiltTx }> {
  const bump = p.bump ?? REPLACEMENT_BUMP;
  assertReplaceable(built, p.state, p.pending);
  const next = await p.rebuild(replacementMinFee(built.feeSompi, bump));
  assertReplacement(built, next, p.pending, bump);
  const signed = await p.sign(next);
  if (signed.txid !== next.txid) throw new ReplacementRefused('signing changed the replacement txid');
  const r = await p.submitReplacement(signed);
  if (r.transactionId !== signed.txid) throw new ReplacementRefused(`node echoed ${r.transactionId}, submitted ${signed.txid}`);
  if (r.replacedTxid !== built.txid) throw new ReplacementRefused(`the node replaced ${r.replacedTxid}, not our ${built.txid}`);
  return { state: { kind: 'replaced', oldTxid: built.txid, newTxid: signed.txid }, built: signed };
}
