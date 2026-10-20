/**
 * Creator claims: a
 * "claim" is the sweep of one fee-holding cell, the curve's `sweep()` before
 * graduation or the pool's after (shapes/sweep.ts). The covenant fixes both
 * payout outputs, so anyone may submit it and the creator half can only go to
 * the creator script the cell names; the submitter pays the network fee.
 *
 * `planClaims` picks the sweepable cells and fixes, per cell, what the
 * contract will pay: everything accrued (curve `feeAccrued`; pool
 * `feeAccruedScaled * 1e6 + dust`), split 50/50 on the curve and the pool (the
 * creator gets `total - floor(total / 2)`, `payout.ts`). A cell is refused when
 * it is below the 10 KAS minimum, when the curve sold out (graduation pays it),
 * when the cell names no creator, or when the creator script is the preset's
 * placeholder.
 *
 * `buildClaims` builds one sweep per plan (batching would need a contract
 * change) and checks every built transaction against its plan before it is
 * handed to a wallet: the creator output pays exactly the planned amount to
 * exactly the planned script (`checkClaimTx`).
 */
import { builderContractSet, type ContractSet } from './artifacts.ts';
import { curvePayoutSplit, poolPayoutSplit } from './payout.ts';
import { toHex } from '@kasseal/codec';
import { p2pkScript } from './assemble.ts';
import { feeFromBytes, feeOutsideModel } from './fee-bytes.ts';
import type { BuiltTx, OutputRole } from './types.ts';

const KAS = 100_000_000n;
/** `SWEEP_MIN` of the curve (10 KAS of `feeAccrued`) and of the pool (1,000 scaled units of `feeAccruedScaled`). */
export const CLAIM_MIN_SOMPI = 10n * KAS;
const KAS_SCALE = 1_000_000n;
/** The preset's placeholder creator script (`0000 20 22×32 ac`): nobody holds its key. */
export const PLACEHOLDER_CREATOR_SPK = `000020${'22'.repeat(32)}ac`;

/** One fee-holding cell as the API serves it (`GET /v1/creators/{address}`, `cells[]`). */
export interface ClaimCell {
  /** The token lineage id T, hex. */
  readonly tokenId: string;
  /** Whether the fees sit in the curve or the pool. */
  readonly venue: 'curve' | 'pool';
  /** The curve covenant id C or the pool covenant id P. */
  readonly covenantId: string;
  /** The contract set of the cell. */
  readonly contractSet: ContractSet;
  /** Everything a sweep pays out now: curve `feeAccrued`; pool `feeAccruedScaled * 1e6 + dust`. */
  readonly accruedSompi: bigint;
  /** The creator script the contract pays (`0000 20 <key> ac`). */
  readonly creatorSpk?: string;
  /** The curve sold out: its sweep is closed. */
  readonly soldOut?: boolean;
}

/** Why a cell cannot be claimed: under the 10 KAS minimum, a sold-out curve, no creator, or the placeholder creator. */
export type ClaimRefusal = 'below-minimum' | 'sold-out' | 'no-creator' | 'placeholder';

/** What one sweep will pay. */
export interface ClaimPlan {
  /** The cell swept. */
  readonly cell: ClaimCell;
  /** Total payout, sompi. */
  readonly payoutSompi: bigint;
  /** The treasury's share. */
  readonly treasurySompi: bigint;
  /** The creator's share, sompi. */
  readonly creatorSompi: bigint;
}

/** The result of `planClaims`. */
export interface ClaimsPlan {
  /** One sweep per sweepable cell, in the order given. */
  readonly plans: readonly ClaimPlan[];
  /** Cells that cannot be claimed now, with the reason. */
  readonly skipped: readonly { readonly cell: ClaimCell; readonly reason: ClaimRefusal }[];
  /** What the creator receives from all plans. */
  readonly totalCreatorSompi: bigint;
}

/** The contract split of a payout of `total` sompi from a cell of this venue and set (`payout.ts`). */
export function claimSplit(venue: 'curve' | 'pool', set: ContractSet, total: bigint): { treasury: bigint; creator: bigint } {
  const v = builderContractSet(set, 'the claim planner');
  const s = venue === 'curve' ? curvePayoutSplit(v, total) : poolPayoutSplit(v, total);
  return { treasury: s.treasury, creator: s.creator };
}

/** Why a cell cannot be claimed now, or null when it can. */
export function claimRefusal(cell: ClaimCell): ClaimRefusal | null {
  if (cell.creatorSpk === undefined) return 'no-creator';
  if (cell.creatorSpk === PLACEHOLDER_CREATOR_SPK) return 'placeholder';
  if (cell.venue === 'curve' && cell.soldOut === true) return 'sold-out';
  // The pool's minimum counts the scaled accrual; the dust (below one scaled unit) rides along.
  const counted = cell.venue === 'pool' ? (cell.accruedSompi / KAS_SCALE) * KAS_SCALE : cell.accruedSompi;
  if (counted < CLAIM_MIN_SOMPI) return 'below-minimum';
  return null;
}

/** One sweep plan per claimable cell, with what each pays the creator. */
export function planClaims(cells: readonly ClaimCell[]): ClaimsPlan {
  const plans: ClaimPlan[] = [];
  const skipped: { cell: ClaimCell; reason: ClaimRefusal }[] = [];
  for (const cell of cells) {
    const reason = claimRefusal(cell);
    if (reason !== null) {
      skipped.push({ cell, reason });
      continue;
    }
    const split = claimSplit(cell.venue, cell.contractSet, cell.accruedSompi);
    plans.push({ cell, payoutSompi: cell.accruedSompi, treasurySompi: split.treasury, creatorSompi: split.creator });
  }
  return { plans, skipped, totalCreatorSompi: plans.reduce((a, p) => a + p.creatorSompi, 0n) };
}

/** The built sweep pays something other than the plan: nothing is signed. */
export class ClaimMismatch extends Error {
  constructor(detail: string) {
    super(`the built sweep does not match the claim: ${detail}`);
    this.name = 'ClaimMismatch';
  }
}

interface SafeJsonOutput {
  value?: string | number;
  scriptPublicKey?: string;
  covenant?: unknown;
}

/** Options of `checkClaimTx`. */
export interface ClaimCheckOptions {
  /** The funder's address: the only script the change may pay. */
  readonly funder: string;
  /** The feerate the caller accepts (sompi/g; default the builder's cap): the fee from the bytes may not exceed it. */
  readonly feerate?: bigint;
}

/**
 * Throws `ClaimMismatch` unless the built transaction's creator output (the output whose role is `creator`) pays
 * exactly `plan.creatorSompi` to exactly `plan.cell.creatorSpk`, and, from the serialised bytes alone:
 *  - the fee is `inputs - outputs`, equal to the built figure, and inside the mass model recomputed from the bytes
 *    (at most `opts.feerate`, default the builder's cap), so a change output cut into the fee is refused;
 *  - every unbound output other than the payees pays the funder (the change), at most one of them, and the payees
 *    together pay exactly the planned payout.
 * A sweep's state may have moved since the plan was read (a trade added fees): the caller re-plans from fresh cells
 * and asks again rather than signing a different figure.
 */
export function checkClaimTx(plan: ClaimPlan, tx: BuiltTx, opts: ClaimCheckOptions): void {
  let outputs: SafeJsonOutput[];
  try {
    outputs = (JSON.parse(tx.txJson) as { outputs?: SafeJsonOutput[] }).outputs ?? [];
  } catch {
    throw new ClaimMismatch('its JSON does not parse');
  }
  let bytes;
  try {
    bytes = feeFromBytes(tx.txJson);
  } catch (e) {
    throw new ClaimMismatch(`its inputs or outputs do not parse (${(e as Error).message})`);
  }
  if (bytes.fee !== tx.feeSompi) throw new ClaimMismatch(`it pays a fee of ${bytes.fee} sompi, the build said ${tx.feeSompi}`);
  const why = feeOutsideModel(bytes, opts.feerate);
  if (why !== undefined) throw new ClaimMismatch(why);
  const changeSpk = `0000${toHex(p2pkScript(opts.funder))}`;
  // Every unbound output is one of: the treasury payout, the creator payout, or at most one change to the funder; and
  // the payouts together are exactly the planned payout. Checked by role, not by script, because the scripts may
  // coincide: a creator claiming their own fees funds the claim, and the treasury's wallet may itself be the creator
  // and the funder.
  /** The one output of a role: exactly `sompi` to `spk` (when the plan knows the script). */
  const check = (role: OutputRole, sompi: bigint, spk: string | undefined, name: string): void => {
    const roles = tx.produces.filter((p) => p.role === role);
    if (roles.length !== 1) throw new ClaimMismatch(roles.length === 0 ? `it has no ${name} output` : `it has ${roles.length} ${name} outputs`);
    const index = roles[0]!.index;
    const out = outputs[index];
    if (out?.value === undefined || out.scriptPublicKey === undefined) throw new ClaimMismatch(`output ${index} is missing`);
    if (spk !== undefined && out.scriptPublicKey !== spk) throw new ClaimMismatch(`output ${index} pays ${out.scriptPublicKey}, the ${name} is ${spk}`);
    if (BigInt(out.value) !== sompi) throw new ClaimMismatch(`output ${index} pays ${String(out.value)} sompi, the plan ${sompi}`);
  };
  if (plan.cell.creatorSpk === undefined) throw new ClaimMismatch('the plan names no creator');
  check('creator', plan.creatorSompi, plan.cell.creatorSpk, 'creator');
  check('treasury', plan.treasurySompi, undefined, 'treasury');
  // The only covenant-bound output is the swept cell's continuation (an output bound to any other covenant would carry
  // the funder's KAS out of reach), and the payouts sit where the
  // covenant pins them, continuation + 1 (treasury) and + 2 (creator): curve `sweep` (requireFeeSplit(c + 1, c + 2))
  // and pool `sweep` (continuation 0, payouts 1 and 2). The treasury's script is then the covenant's, so a funder whose
  // script is also the treasury's cannot be led to pay a third party labelled "treasury" from its own inputs.
  const bound = outputs.map((o, k) => ({ o, k })).filter(({ o }) => o.covenant !== null && o.covenant !== undefined);
  const venueId = plan.cell.covenantId.toLowerCase();
  for (const { o, k } of bound) {
    const id = String((o.covenant as { covenantId?: unknown }).covenantId ?? '').toLowerCase();
    if (id !== venueId) throw new ClaimMismatch(`output ${k} is bound to covenant ${id}, not the swept cell ${venueId}`);
  }
  if (bound.length !== 1) throw new ClaimMismatch(`${bound.length} outputs are bound to the swept cell; a sweep has one continuation`);
  const cont = bound[0]!.k;
  const indexOf = (role: OutputRole): number | undefined => tx.produces.find((p) => p.role === role)?.index;
  if (indexOf('treasury') !== cont + 1 || indexOf('creator') !== cont + 2) {
    throw new ClaimMismatch(`the payouts are at outputs ${indexOf('treasury')} and ${indexOf('creator')}, the covenant pins them at ${cont + 1} and ${cont + 2}`);
  }
  const roleOf = new Map(tx.produces.map((p) => [p.index, p.role] as const));
  let changes = 0;
  let paid = 0n;
  for (const [k, o] of outputs.entries()) {
    if (o.value === undefined || o.scriptPublicKey === undefined) throw new ClaimMismatch(`output ${k} is malformed`);
    if (o.covenant !== null && o.covenant !== undefined) continue; // the venue's continuation (checked above), pinned by the covenant
    const role = roleOf.get(k);
    if (role === 'change') {
      if (o.scriptPublicKey !== changeSpk) throw new ClaimMismatch(`the change output ${k} does not pay the funder`);
      changes++;
      continue;
    }
    if (role !== 'treasury' && role !== 'creator') throw new ClaimMismatch(`output ${k} is neither a payee nor the change: an output pays neither a payee nor the funder`);
    paid += BigInt(o.value);
  }
  if (changes > 1) throw new ClaimMismatch(`${changes} change outputs pay the funder`);
  if (paid !== plan.payoutSompi) throw new ClaimMismatch(`the payouts total ${paid} sompi, the plan ${plan.payoutSompi}: an output pays neither a payee nor the funder`);
}

/** A built sweep with its plan, checked. */
export interface BuiltClaim {
  /** The plan. */
  readonly plan: ClaimPlan;
  /** The unsigned sweep. */
  readonly tx: BuiltTx;
}

/** The builder call a claim needs (`KassealTxBuilder.buildSweep`). */
export type SweepBuilder = (p: { covenantId: string; venue: 'curve' | 'pool'; funder: string }) => Promise<BuiltTx>;

/** Build one sweep per plan, each checked against its plan, with the network fee total. Nothing is signed. */
export async function buildClaims(build: SweepBuilder, plans: readonly ClaimPlan[], funder: string): Promise<{ claims: BuiltClaim[]; totalFeeSompi: bigint; totalCreatorSompi: bigint }> {
  const claims: BuiltClaim[] = [];
  for (const plan of plans) {
    const tx = await build({ covenantId: plan.cell.covenantId, venue: plan.cell.venue, funder });
    checkClaimTx(plan, tx, { funder });
    claims.push({ plan, tx });
  }
  return {
    claims,
    totalFeeSompi: claims.reduce((a, c) => a + c.tx.feeSompi, 0n),
    totalCreatorSompi: claims.reduce((a, c) => a + c.plan.creatorSompi, 0n),
  };
}
