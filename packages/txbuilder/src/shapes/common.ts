/**
 * What every shape shares: the cell preconditions the covenants enforce
 * (checked before anything is built, so a refusal names the rule instead of
 * the node rejecting a script), the KCC-20 family check, the floor rules, and
 * the derivation of output roles and of the optimistic delta from an
 * assembled transaction.
 *
 * A shape function is synchronous and pure over its inputs: it takes the
 * cells and funding UTXOs explicitly and returns a `Shaped` (the assembled SDK
 * transaction with its roles and delta). `toBuilt` turns that into the
 * serialisable `BuiltTx`. The asynchronous `TxBuilder` (builder.ts) reads the
 * cells through `UtxoSources`, selects funding and calls the same functions.
 */

import { poolLimitsOf } from '../cells.ts';
import { hasOpenLiquidity } from '../artifacts.ts';
import { checkTransfer, fromHex, kcc0020Fields, templateHashOfProgram, toHex, type TokenState } from '@kasseal/codec';
import { assemble, feerateOf, scriptOfVersionedSpk, type AssembledTx, type CurveCell, type OutputPlan, type Outpoint, type PoolCell, type TokenCell, type TxPlan } from '../assemble.ts';
import { toBuiltTx } from '../finalize.ts';
import { SOMPI_PER_KAS } from '../mass.ts';
import { validateLpPool } from '@kasseal/curve-math';
import type { ContractSet } from '../artifacts.ts';
import { contextSet, plainOutput } from '../cells.ts';
import type { PayoutSplit } from '../payout.ts';
import { PHASE_ACTIVE, POOL_KAS_SCALE, isCovenantOwnedBy, isP2pkSpk36, isP2shSpk37, poolStateLayoutOf, poolStateSet, type CurveState, type PoolCellState } from '../program.ts';
import { assertFloors } from '../select/floors.ts';
import { required } from '../required.ts';
import { CovenantCellValue, LineageMismatch, NetBoundExceeded, ProofNotBound, type BuiltTx, type LineageGenesis, type LineageTermination, type LaunchProofVerdict, type OptimisticDelta, type OutputRole } from '../types.ts';
import type { BuilderContext } from '../cells.ts';
import type { FundingUtxo } from '../assemble.ts';

export { MIN_P2PK_OUTPUT_VALUE, MIN_USER_CELL_VALUE } from '../select/floors.ts';

export { DEFAULT_USER_CELL_VALUE } from '../mass.ts';
/** Payouts below this are refused, sompi (the consensus floor 0.02 KAS plus margin). */
export const MIN_PAYOUT = 2_010_000n;
/** The covenants' own payout minimum (curve `PAYOUT_MIN`, pool `PAYOUT_MIN` of 10 scaled units). */
export const PREFERRED_MIN_PAYOUT = SOMPI_PER_KAS / 10n;

/** Fee knobs every shape accepts. */
export interface FeeOptions {
  /** Sompi added on top of the model's minimum fee. */
  readonly feeMargin?: bigint;
  /** Sompi per gram (default and minimum 100; refused above `FEERATE_MAX_SOMPI_PER_GRAM`). */
  readonly feerate?: bigint;
}

/* -------------------------------------------------------------------------- */
/* Lineage and net bounds                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The launch-proof gate of the curve trades: fails closed. Refuses unless `verdict` is exactly
 * `bound`; a sell may pass `exit = true` to admit any verdict (a holder can always leave). A value that is not one of
 * the verdict strings (an untyped caller, a missing field) is refused like `unverified`.
 *
 * Which builders take the gate, and why the others do not:
 *   buy       gated. The buyer pays into C; a second C bearer can move the supply the buyer is buying from and sell it
 *             back into the curve, draining what buyers paid.
 *   sell      gated, with the explicit exit opt-in. The seller receives from the curve program; nothing they sign
 *             relies on C being a singleton, and refusing would trap holders in a curve that may be draining.
 *   graduate  not gated. It spends no user value (the funder pays the fee), consumes every C-owned cell (reserve and
 *             empty supply) and ends C; the P group is pinned by the curve program (`curve.sil` graduate). Refusing
 *             it would keep the escrow exposed longer.
 *   sweeps, claims  not gated. The payees are program constants and the amount is `feeAccrued` (curve) or the
 *             pool's accrual; the funder pays only the fee.
 *   pool buys gated in the asynchronous builder (`buildSwap` kas->tok): P is a covenant-pinned
 *             singleton in the current sets, but a pool that predates that pin relies on the proof. Pool sells are not gated.
 *   liquidity  not gated here. P is a covenant-pinned singleton (graduate), L by `bindLp`; deposits keep their own
 *             `lpSafe` gate.
 */
export function requireProofBound(operation: string, verdict: LaunchProofVerdict | undefined, exit = false): void {
  if (exit) return;
  if (verdict !== 'bound') throw new ProofNotBound(operation, verdict);
}

/**
 * The venue's token lineage must be the one the caller is trading (the page's token id), when the caller names it.
 * The lineage otherwise comes from the served cell alone, which the API controls.
 */
export function requireLineage(venue: string, tokenCovId: Uint8Array, tokenId: string | undefined): string {
  const actual = toHex(tokenCovId);
  if (tokenId !== undefined && actual !== tokenId.toLowerCase()) throw new LineageMismatch(venue, tokenId.toLowerCase(), actual);
  return actual;
}

/** Total sompi of a list of funding UTXOs (0 for none). */
export const fundingSum = (funding: readonly FundingUtxo[] | undefined): bigint => (funding ?? []).reduce((a, u) => a + u.amount, 0n);

/** `allIn` (what leaves the wallet: the venue amount, the cell deposit and the network fee) may not exceed `maxAllIn`. */
export function assertAllIn(tx: string, allIn: bigint, fee: bigint, maxAllIn: bigint | undefined): void {
  if (maxAllIn !== undefined && allIn > maxAllIn) throw new NetBoundExceeded(tx, 'all-in', allIn, maxAllIn, fee);
}

/** `net` (what reaches the wallet: the payout minus any top-up input the wallet put in) may not fall below `minNetOut`. */
export function assertNetOut(tx: string, net: bigint, fee: bigint, minNetOut: bigint | undefined): void {
  if (minNetOut !== undefined && net < minNetOut) throw new NetBoundExceeded(tx, 'net-out', net, minNetOut, fee);
}

/** An assembled transaction with the role of each output and its optimistic delta. */
export interface Shaped {
  /** The assembled transaction. */
  readonly built: AssembledTx;
  /** Role per output index of `built.outputs`. */
  readonly roles: readonly OutputRole[];
  /** The state change to apply optimistically once submitted. */
  readonly optimistic: OptimisticDelta;
}

/** The serialisable `BuiltTx` of a shape (txid asserted against `txidV1` and the SDK). */
export function toBuilt(s: Shaped): BuiltTx {
  return toBuiltTx(s.built, { feerate: feerateOf(s.built.plan), produces: s.roles.map((role, index) => ({ index, role })), optimistic: s.optimistic });
}

/** The plan's fee fields from the options. */
export function feeFields(o: FeeOptions): Pick<TxPlan, 'feeMargin'> & { feerate?: bigint } {
  return o.feerate === undefined ? { feeMargin: o.feeMargin ?? 0n } : { feeMargin: o.feeMargin ?? 0n, feerate: o.feerate };
}

/**
 * Assemble a plan and finish it: the floor rules over the final outputs, the roles (one per fixed output, then the
 * residual's when it was kept) and the optimistic delta.
 */
export function finish(plan: TxPlan, fixedRoles: readonly OutputRole[], residualRole: OutputRole | undefined, extra: DeltaExtras = {}): Shaped {
  if (fixedRoles.length !== plan.outputs.length) throw new Error(`${plan.name}: ${fixedRoles.length} roles for ${plan.outputs.length} fixed outputs`);
  const built = assemble(plan);
  assertFloors(built);
  const roles: OutputRole[] = [...fixedRoles];
  if (built.outputs.length > plan.outputs.length) {
    if (residualRole === undefined) throw new Error(`${plan.name}: residual output without a role`);
    roles.push(residualRole);
  }
  return { built, roles, optimistic: deltaOf(built, roles, extra) };
}

/* -------------------------------------------------------------------------- */
/* Optimistic delta                                                            */
/* -------------------------------------------------------------------------- */

/** Extra lineage events and reserved outputs for `finish`. */
export interface DeltaExtras {
  /** P2PK outputs of this transaction that a later transaction of the same flow spends (tx01's prep outpoint). */
  readonly reserveOutputs?: readonly number[];
}

const CHANGE_ROLES: ReadonlySet<OutputRole> = new Set<OutputRole>(['change', 'payout']);

/** The delta of an assembled transaction: every covenant input and output by kind, P2PK inputs reserved, change. */
export function deltaOf(a: AssembledTx, roles: readonly OutputRole[], extra: DeltaExtras = {}): OptimisticDelta {
  const at = (index: number): Outpoint => ({ txid: a.txid, index });
  const consumed: Outpoint[] = [];
  const reserved: Outpoint[] = [];
  const curveIn: { covenantId: string; outpoint: Outpoint }[] = [];
  const poolIn: { covenantId: string; outpoint: Outpoint }[] = [];
  for (const i of a.plan.inputs) {
    const outpoint = { txid: i.outpoint.txid, index: i.outpoint.index };
    // Companion-contract cells are not the signer's funding nor a lineage the app tracks: consumed outpoints.
    if (i.cellKind === 'vault' || i.cellKind === 'deposit' || i.cellKind === 'splitter' || i.cellKind === 'order' || i.cellKind === 'anchor' || i.cellKind === 'dist-key') consumed.push(outpoint);
    else if (i.covenantId === undefined) reserved.push(outpoint);
    else if (i.cellKind === 'token') consumed.push(outpoint);
    else if (i.cellKind === 'curve') curveIn.push({ covenantId: i.covenantId, outpoint });
    else if (i.cellKind === 'pool') poolIn.push({ covenantId: i.covenantId, outpoint });
    else throw new Error(`${a.plan.name}: covenant input "${i.label}" has no cell kind`);
  }
  const produced: OptimisticDelta['cells']['produced'] = [];
  const curveOut: { covenantId: string; outpoint: Outpoint; state: CurveState; amount: bigint }[] = [];
  const poolOut: { covenantId: string; outpoint: Outpoint; state: PoolCellState; amount: bigint }[] = [];
  let change: { outpoint: Outpoint; amount: bigint } | undefined;
  for (const o of a.outputs) {
    const p = o.cell?.predicted;
    const covenantId = o.binding?.covenantId ?? o.cell?.covenantId;
    if (p !== undefined && covenantId === undefined) throw new Error(`${a.plan.name}: output ${o.index} has a predicted cell but no covenant id`);
    const idOf = (): string => required(covenantId, `${a.plan.name}: covenant id of the predicted cell at output ${o.index}`);
    if (p?.kind === 'token') produced.push({ outpoint: at(o.index), state: p.state, amount: o.value });
    else if (p?.kind === 'curve') curveOut.push({ covenantId: idOf(), outpoint: at(o.index), state: p.state, amount: o.value });
    else if (p?.kind === 'pool') poolOut.push({ covenantId: idOf(), outpoint: at(o.index), state: p.state, amount: o.value });
    else if (CHANGE_ROLES.has(roles[o.index]!)) {
      if (change !== undefined) throw new Error(`${a.plan.name}: more than one change output`);
      change = { outpoint: at(o.index), amount: o.value };
    }
  }
  for (const index of extra.reserveOutputs ?? []) reserved.push(at(index));
  if (curveIn.length > 1 || curveOut.length > 1 || poolIn.length > 1 || poolOut.length > 1) throw new Error(`${a.plan.name}: more than one singleton of a kind`);

  const genesis: LineageGenesis[] = [];
  const terminated: LineageTermination[] = [];
  let curve: OptimisticDelta['curve'];
  let pool: OptimisticDelta['pool'];
  const [ci, co, pi, po] = [curveIn[0], curveOut[0], poolIn[0], poolOut[0]];
  if (ci && co) {
    if (ci.covenantId !== co.covenantId) throw new Error(`${a.plan.name}: curve continuation of another lineage`);
    curve = { covenantId: ci.covenantId, fromOutpoint: ci.outpoint, toOutpoint: co.outpoint, state: co.state, amount: co.amount };
  } else if (co) genesis.push({ kind: 'curve', covenantId: co.covenantId, outpoint: co.outpoint, state: co.state, amount: co.amount });
  else if (ci) terminated.push({ kind: 'curve', covenantId: ci.covenantId, outpoint: ci.outpoint });
  if (pi && po) {
    if (pi.covenantId !== po.covenantId) throw new Error(`${a.plan.name}: pool continuation of another lineage`);
    pool = { poolId: pi.covenantId, fromOutpoint: pi.outpoint, toOutpoint: po.outpoint, state: po.state, amount: po.amount };
  } else if (po) genesis.push({ kind: 'pool', covenantId: po.covenantId, outpoint: po.outpoint, state: po.state, amount: po.amount });
  else if (pi) terminated.push({ kind: 'pool', covenantId: pi.covenantId, outpoint: pi.outpoint });

  return {
    ...(curve ? { curve } : {}),
    ...(pool ? { pool } : {}),
    cells: { consumed, produced },
    funding: change ? { reserved, change } : { reserved },
    ...(genesis.length > 0 ? { genesis } : {}),
    ...(terminated.length > 0 ? { terminated } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Preconditions                                                               */
/* -------------------------------------------------------------------------- */

/** Require an initialised, active curve cell of this context's template; returns T (hex). */
export function requireActiveCurve(ctx: BuilderContext, curve: CurveCell): string {
  if (curve.state.phase !== PHASE_ACTIVE) throw new Error(`curve is in phase ${curve.state.phase}, not active`);
  if (curve.state.tokenCovId.every((b) => b === 0)) throw new Error('curve state has no token lineage (not initialised)');
  if (curve.program.length !== ctx.curve.bytecode.length) throw new Error('curve cell program length does not match the template');
  return toHex(curve.state.tokenCovId);
}

/** The curve-owned supply cell: amount pinned to `(curveLots - lotsSold) * lot` (the reserve cell has the same owner). */
export function requireSupplyCell(ctx: BuilderContext, curve: CurveCell, supply: TokenCell): string {
  const T = toHex(curve.state.tokenCovId);
  if (supply.covenantId !== T) throw new Error(`supply cell lineage ${supply.covenantId} != curve's T ${T}`);
  if (!isCovenantOwnedBy(supply.state, curve.covenantId)) throw new Error('supply cell is not owned by the curve');
  const expected = (ctx.curve.params.curveLots - curve.state.lotsSold) * ctx.curve.params.lot;
  if (supply.state.amount !== expected) throw new Error(`supply cell holds ${supply.state.amount}, expected ${expected} (is this the reserve cell?)`);
  return T;
}

/**
 * The value a curve-owned token cell (supply, reserve) is carried forward with.
 *
 * A covenant cell's KAS amount comes from the API and the user's signature does not commit to it (a signature covers
 * only the amount of the input it signs). Over-reporting lowers the real fee; under-reporting hands the difference to
 * the miner. The curve requires every curve-owned token output to hold at least `tokenCellKas`, and every such cell
 * the builder creates holds exactly that. So: a served value below `count * tokenCellKas` is refused
 * (`CovenantCellValue`), and the continuation is written at exactly `count * tokenCellKas`. Whatever the API reports
 * above that is the wallet's residual, never the fee; the user's outlay does not depend on the reported amount, and a
 * surplus someone else left in the cell is not carried forward (so it cannot be used to lock the app out of the curve).
 */
export function curveOwnedCellValue(ctx: BuilderContext, cells: readonly { readonly cell: TokenCell; readonly name: string }[]): bigint {
  const min = ctx.curve.params.tokenCellKas;
  for (const { cell, name } of cells) {
    if (cell.value < min) throw new CovenantCellValue(`${name} cell ${cell.outpoint.txid}:${cell.outpoint.index}`, cell.value, min);
  }
  return BigInt(cells.length) * min;
}

/**
 * The pool cell belongs to the context's contract set (the layouts differ: 108 / 139 B) and, for a v1
 * pool, its state is well formed as its program checks it (`requireWellFormed`: the share range, the reserve caps, the
 * dust rule). Returns the set.
 */
export function requirePoolOfContext(ctx: BuilderContext, pool: PoolCell): ContractSet {
  const version = contextSet(ctx);
  const of = poolStateSet(pool.state);
  if (of !== poolStateLayoutOf(version)) throw new Error(`a ${of} pool cell in a ${version} context`);
  // The program must be this context's pool template (every v1 build, current or frozen, shares the state layout).
  const { stateOffset, stateLength, templateHash } = ctx.pool;
  if (pool.program.length !== ctx.pool.bytecode.length || templateHashOfProgram(pool.program, stateOffset, stateLength) !== templateHash) {
    throw new Error(`the pool cell's program is not this context's ${version} pool template`);
  }
  if (hasOpenLiquidity(version)) {
    const s = pool.state;
    const dust = pool.value - (s.kasScaled + s.feeAccruedScaled) * POOL_KAS_SCALE;
    validateLpPool({ kasScaled: s.kasScaled, tokenReserve: s.tokenReserve, feeAccruedScaled: s.feeAccruedScaled, dust, lpShares: s.lpShares }, poolLimitsOf(ctx));
  }
  return version;
}

/** The pool-owned token cell: amount equal to the pool state's `tokenReserve`. */
export function requirePoolToken(pool: PoolCell, poolToken: TokenCell): string {
  const T = toHex(pool.state.tokenCovId);
  if (poolToken.covenantId !== T) throw new Error('pool token cell is not of lineage T');
  if (!isCovenantOwnedBy(poolToken.state, pool.covenantId)) throw new Error('token cell is not pool-owned');
  if (poolToken.state.amount !== pool.state.tokenReserve) throw new Error(`pool token cell holds ${poolToken.state.amount}, state says ${pool.state.tokenReserve}`);
  // The pool pins borrow 0 and a zero guard on its reserve (pinReserve): refuse any other cell here
  // rather than build a transaction the covenant refuses.
  const f = kcc0020Fields(poolToken.state);
  if (f.borrowScheme !== 0 || f.borrowGuard.some((b) => b !== 0)) throw new Error('pool token cell has a borrow scheme or guard set; it is not the pool reserve');
  return T;
}

/** A user leader the builder can have signed: key-owned (scheme 0x00), of lineage T, not owned by `venue`. */
export function requireUserCell(cell: TokenCell, T: string, venue: string): void {
  if (cell.covenantId !== T) throw new Error('user cell is not of lineage T');
  if (isCovenantOwnedBy(cell.state, venue)) throw new Error('leader cell is owned by the venue');
  if (cell.state.owner.schemeByte !== 0x00) throw new Error(`user cell owner scheme ${cell.state.owner.schemeByte} is not p2pk-schnorr/v1; the builder signs only key-owned leaders`);
}

/**
 * The KCC-20 family check the token leader performs (KCC-20 sections 2 and 5, minus signature verification), run
 * on the predicted transition before it is built: counts, state validity, shared extension commitment,
 * conservation, the witness path and the self-owned footgun.
 */
export function checkTokenFamily(T: string, inputs: readonly TokenCell[], outputs: readonly TokenState[], witness: Uint8Array, outputValues?: readonly bigint[]): void {
  const r = checkTransfer({
    inputs: inputs.map((c, index) => ({ state: c.state, index, kasValue: c.value })),
    outputs: outputs.map((state, index) => (outputValues?.[index] === undefined ? { state, index } : { state, index, kasValue: outputValues[index]! })),
    witness,
    covenantId: fromHex(T),
  });
  if (r.selfOwnedOutputs.length > 0) throw new Error(`token output ${r.selfOwnedOutputs[0]} would be self-owned (anyone-can-spend)`);
}

/** The payee scripts a payout may name: the template's treasury constant and the creator. */
export interface PayoutScripts {
  readonly treasurySpk?: Uint8Array | undefined;
  readonly creatorSpk: Uint8Array;
}

/** The plain script of a `version(2) || script` constant; refuses a non-zero version and a script of the wrong form. */
function payeeScript(versioned: Uint8Array | undefined, what: string, form: 'p2pk' | 'p2sh'): Uint8Array {
  if (versioned === undefined) throw new Error(`the template names no ${what} script`);
  if (form === 'p2pk' ? !isP2pkSpk36(versioned) : !isP2shSpk37(versioned)) throw new Error(`the ${what} script is not a version-0 ${form === 'p2pk' ? 'P2PK' : 'P2SH'} script`);
  return scriptOfVersionedSpk(versioned).script;
}

/** The form of a treasury constant: P2PK (36 B), or P2SH (37 B, v1 only; the template loader refuses it elsewhere). */
function treasuryForm(versioned: Uint8Array | undefined): 'p2pk' | 'p2sh' {
  return versioned !== undefined && versioned.length === 37 ? 'p2sh' : 'p2pk';
}

/**
 * The fee outputs of a payout, in the order the covenants pin them, with their roles: treasury then creator (a
 * treasury-only payout: the treasury alone, `creator` 0 and omitted).
 */
export function payoutOutputs(
  split: PayoutSplit, scripts: PayoutScripts, labels: { readonly treasury: string; readonly creator: string }, treasuryOnly = false,
): { outputs: OutputPlan[]; roles: OutputRole[] } {
  if (treasuryOnly) {
    if (split.creator !== 0n) throw new Error('a treasury-only payout with a creator share');
    return { outputs: [plainOutput(labels.treasury, split.treasury, payeeScript(scripts.treasurySpk, 'treasury', treasuryForm(scripts.treasurySpk)))], roles: ['treasury'] };
  }
  return {
    outputs: [
      plainOutput(labels.treasury, split.treasury, payeeScript(scripts.treasurySpk, 'treasury', treasuryForm(scripts.treasurySpk))),
      plainOutput(labels.creator, split.creator, payeeScript(scripts.creatorSpk, 'creator', 'p2pk')),
    ],
    roles: ['treasury', 'creator'],
  };
}

/** Witness bytes as the sigscripts carry them, for `checkTokenFamily`. */
export const WITNESS_COVENANT = Uint8Array.of(0x00);
/** A signed leader's witness: `00` followed by a 65-byte signature slot. */
export const WITNESS_SIGNED: Uint8Array = (() => {
  const w = new Uint8Array(66);
  w[0] = 0x00;
  return w;
})();

/* -------------------------------------------------------------------------- */
/* Foreign covenant inputs                                                     */
/* -------------------------------------------------------------------------- */

/** A curve or pool transaction would spend a covenant cell of another lineage, or a P2SH output as plain funding. */
export class ForeignCovenantInput extends Error {
  /** The transaction's name. */
  readonly tx: string;
  /** The refused input, `txid:index`. */
  readonly outpoint: string;
  constructor(tx: string, outpoint: string, why: string) {
    super(`${tx}: input ${outpoint} ${why}: refused (a foreign covenant cell in a curve or pool transaction is taken by its submitter)`);
    this.name = 'ForeignCovenantInput';
    this.tx = tx;
    this.outpoint = outpoint;
  }
}

const isP2shScript = (spk: Uint8Array): boolean => spk.length === 35 && spk[0] === 0xaa && spk[1] === 0x20 && spk[34] === 0x87;

/**
 * The curve and the pool count and validate only their own lineages; any other covenant cell they happen to carry
 * (a T2 cell owned by C or P) is released to whatever output the submitter writes. The builder therefore
 * spends only cells of the shape's own lineages (`lineages`: C and T, P and T, plus L for a bound pool), and funding
 * inputs must be plain outputs with no covenant binding and no P2SH script.
 */
export function requireOwnLineages(plan: TxPlan, lineages: readonly string[], authority?: { readonly outpoint: Outpoint; readonly spk: Uint8Array }): void {
  const allowed = new Set(lineages.map((l) => l.toLowerCase()));
  for (const i of plan.inputs) {
    const at = `${i.outpoint.txid}:${i.outpoint.index}`;
    if (i.cellKind === undefined) {
      if (i.covenantId !== undefined) throw new ForeignCovenantInput(plan.name, at, `is a funding input bound to covenant ${i.covenantId}`);
      // The one P2SH input a script-authorized sell names (`scriptAuthority`): the caller's own script, not a stray.
      const isAuthority = authority !== undefined && authority.outpoint.txid === i.outpoint.txid && authority.outpoint.index === i.outpoint.index && toHex(authority.spk) === toHex(i.spk);
      if (isP2shScript(i.spk) && !isAuthority) throw new ForeignCovenantInput(plan.name, at, 'is a funding input paying a P2SH script');
      continue;
    }
    if (i.covenantId === undefined || !allowed.has(i.covenantId.toLowerCase())) throw new ForeignCovenantInput(plan.name, at, `carries lineage ${String(i.covenantId)}, not one of the transaction's own`);
  }
}
