/**
 * Consolidation planner. Sells and token->KAS swaps
 * absorb the leader cell whole, so before either the holder must own exactly
 * one cell of exactly the amount. In order of preference:
 *
 *   1. a cell of the amount exists: use it (no transaction);
 *   2. a larger cell exists: split the smallest such cell (one 1 -> 2);
 *   3. 2 or 3 cells sum to the amount exactly: merge them (one k -> 1);
 *   4. otherwise merge largest-first in rounds of at most 3 inputs
 *      (`max_token_inputs = 3`), each round's merged cell leading the next,
 *      until a cell of at least the amount exists, then split it unless it is
 *      exact.
 *
 * Step 3 is the merge path of step 4 when one round already lands on the
 * amount; it saves the final split (for example 80 + 40 + 10 lots merged for
 * a 130-lot sell).
 *
 * `planExactCell` works on amounts only and is what the property tests drive;
 * `buildExactCellChain` turns a plan into the chained transactions (every
 * later transaction spends predicted outputs of the earlier ones, which the
 * mempool accepts as a chain) and returns them with the total fee before
 * anything is signed. Every transaction of the chain goes through the shapes,
 * so the floors, the self-owned rule and the family check apply to each.
 */

import { MAX_TOKEN_INPUTS } from '@kasseal/codec';
import { ResidualBelowMinimum, outpointKey, p2pkScript, type FundingUtxo, type Outpoint, type TokenCell } from '../assemble.ts';
import type { FeeOptions, Shaped } from '../shapes/common.ts';
import { buildConsolidate } from '../shapes/consolidate.ts';
import { buildSplit, splitValues } from '../shapes/split.ts';
import type { BuilderContext } from '../cells.ts';
import { selectFunding, type SelectFundingOptions } from './funding.ts';
import { required } from '../required.ts';

/* -------------------------------------------------------------------------- */
/* Amount-level plan                                                           */
/* -------------------------------------------------------------------------- */

/** A cell as the planner sees it: an id and a token amount. */
export interface PlanCell {
  /** Caller-chosen id (an outpoint key, or a step output id). */
  readonly id: string;
  /** Whole tokens. */
  readonly amount: bigint;
}

/** One planned transaction: a merge of up to three cells, or a split carving `carve` tokens. */
export type PlanStep =
  | { readonly kind: 'merge'; readonly inputs: readonly string[]; readonly output: string; readonly amount: bigint }
  | { readonly kind: 'split'; readonly input: string; readonly carve: bigint; readonly rest: string; readonly carved: string };

/** How to reach one cell of exactly `target` tokens. */
export interface ExactCellPlan {
  /** The amount needed. */
  readonly target: bigint;
  /** Which path the plan takes. */
  readonly kind: 'exact' | 'split' | 'merge' | 'merge+split';
  /** The transactions, in order (empty for `exact`). */
  readonly steps: readonly PlanStep[];
  /** Id of the cell holding exactly `target` once every step has run (a step output id when steps exist). */
  readonly result: string;
}

/** The holder's cells do not add up to the amount needed. */
export class InsufficientTokensError extends Error {
  /** Tokens needed. */
  readonly needed: bigint;
  /** Tokens available. */
  readonly available: bigint;
  constructor(needed: bigint, available: bigint) {
    super(`insufficient tokens: need ${needed}, ${available} available`);
    this.name = 'InsufficientTokensError';
    this.needed = needed;
    this.available = available;
  }
}

const byAmountDesc = (a: PlanCell, b: PlanCell): number => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0);

/** Id of step `step`'s merged output. */
export const mergedId = (step: number): string => `step${step}:merged`;
/** Id of step `step`'s split rest. */
export const restId = (step: number): string => `step${step}:rest`;
/** Id of step `step`'s carved cell. */
export const carvedId = (step: number): string => `step${step}:carved`;

/** An exact subset of 2..maxInputs cells (larger cells first), or undefined. */
export function exactSubset(cells: readonly PlanCell[], amount: bigint, maxInputs: number = MAX_TOKEN_INPUTS): PlanCell[] | undefined {
  const sorted = [...cells].sort(byAmountDesc);
  for (let size = 2; size <= Math.min(maxInputs, sorted.length); size++) {
    const pick: PlanCell[] = [];
    const rec = (start: number, remaining: bigint): boolean => {
      if (pick.length === size) return remaining === 0n;
      for (let i = start; i < sorted.length; i++) {
        const c = sorted[i]!;
        if (c.amount > remaining) continue;
        pick.push(c);
        if (rec(i + 1, remaining - c.amount)) return true;
        pick.pop();
      }
      return false;
    };
    if (rec(0, amount)) return pick;
  }
  return undefined;
}

/**
 * Largest-first merge rounds of at most `maxInputs` cells. With `target`, stops as soon as one cell holds at least
 * `target` (and adds no more inputs to a round than it needs); without it, merges everything into one cell.
 * Step numbers start at `firstStep`.
 */
export function planMerges(cells: readonly PlanCell[], target: bigint | undefined, maxInputs: number = MAX_TOKEN_INPUTS, firstStep = 0): { steps: PlanStep[]; largest: PlanCell } {
  return planMergesFrom([...cells].sort(byAmountDesc), target, maxInputs, firstStep);
}

/** `planMerges` over cells in the given order: the first cell is always an input of the first round. */
function planMergesFrom(ordered: readonly PlanCell[], target: bigint | undefined, maxInputs: number, firstStep: number): { steps: PlanStep[]; largest: PlanCell } {
  if (maxInputs < 2) throw new Error('a merge needs at least 2 inputs');
  if (ordered.length === 0) throw new Error('no cells');
  const working = [...ordered];
  const steps: PlanStep[] = [];
  for (;;) {
    const head = working[0]!;
    if (target !== undefined && head.amount >= target) return { steps, largest: head };
    if (working.length === 1) {
      if (target !== undefined) throw new InsufficientTokensError(target, head.amount);
      return { steps, largest: head };
    }
    const inputs: PlanCell[] = [head];
    let total = head.amount;
    for (let i = 1; i < working.length && inputs.length < maxInputs; i++) {
      if (target !== undefined && total >= target) break;
      inputs.push(working[i]!);
      total += working[i]!.amount;
    }
    const step = firstStep + steps.length;
    const merged: PlanCell = { id: mergedId(step), amount: total };
    steps.push({ kind: 'merge', inputs: inputs.map((c) => c.id), output: merged.id, amount: total });
    working.splice(0, inputs.length);
    working.unshift(merged); // the merged cell holds the largest cell plus more, so it stays first
  }
}

/** The plan that leaves exactly one cell of exactly `target` (see the module comment for the order). */
export function planExactCell(cells: readonly PlanCell[], target: bigint, maxInputs: number = MAX_TOKEN_INPUTS): ExactCellPlan {
  if (target <= 0n) throw new Error('target must be positive');
  const ids = new Set<string>();
  for (const c of cells) {
    if (c.amount <= 0n) throw new Error(`cell ${c.id} holds no tokens`);
    if (ids.has(c.id)) throw new Error(`cell ${c.id} listed twice`);
    ids.add(c.id);
  }
  const available = cells.reduce((a, c) => a + c.amount, 0n);
  if (available < target) throw new InsufficientTokensError(target, available);

  const exact = cells.find((c) => c.amount === target);
  if (exact) return { target, kind: 'exact', steps: [], result: exact.id };

  const larger = cells.filter((c) => c.amount > target).sort(byAmountDesc);
  if (larger.length > 0) {
    const source = larger[larger.length - 1]!;
    return { target, kind: 'split', steps: [{ kind: 'split', input: source.id, carve: target, rest: restId(0), carved: carvedId(0) }], result: carvedId(0) };
  }

  const subset = exactSubset(cells, target, maxInputs);
  if (subset) return { target, kind: 'merge', steps: [{ kind: 'merge', inputs: subset.map((c) => c.id), output: mergedId(0), amount: target }], result: mergedId(0) };

  const { steps, largest } = planMerges(cells, target, maxInputs);
  if (largest.amount === target) return { target, kind: 'merge', steps, result: largest.id };
  const n = steps.length;
  return { target, kind: 'merge+split', steps: [...steps, { kind: 'split', input: largest.id, carve: target, rest: restId(n), carved: carvedId(n) }], result: carvedId(n) };
}

/**
 * The exact-cell plan whose first step spends at least one cell of `mustSpend` (cell ids). A retry that changes the
 * amount of an earlier attempt which spent those cells then conflicts with it, so at most one of the two can be
 * accepted. Without `mustSpend` this is `planExactCell`.
 */
export function planExactCellSpending(cells: readonly PlanCell[], target: bigint, mustSpend: ReadonlySet<string>, maxInputs: number = MAX_TOKEN_INPUTS): ExactCellPlan {
  if (mustSpend.size === 0) return planExactCell(cells, target, maxInputs);
  if (target <= 0n) throw new Error('target must be positive');
  const available = cells.reduce((a, c) => a + c.amount, 0n);
  if (available < target) throw new InsufficientTokensError(target, available);
  const required = cells.filter((c) => mustSpend.has(c.id)).sort(byAmountDesc);
  if (required.length === 0) throw new Error('none of the cells the plan must spend is listed');
  const exact = required.find((c) => c.amount === target);
  if (exact) return { target, kind: 'exact', steps: [], result: exact.id };
  const larger = required.filter((c) => c.amount > target);
  if (larger.length > 0) {
    const source = larger[larger.length - 1]!;
    return { target, kind: 'split', steps: [{ kind: 'split', input: source.id, carve: target, rest: restId(0), carved: carvedId(0) }], result: carvedId(0) };
  }
  const head = required[0]!;
  const { steps, largest } = planMergesFrom([head, ...cells.filter((c) => c.id !== head.id).sort(byAmountDesc)], target, maxInputs, 0);
  if (largest.amount === target) return { target, kind: 'merge', steps, result: largest.id };
  const n = steps.length;
  return { target, kind: 'merge+split', steps: [...steps, { kind: 'split', input: largest.id, carve: target, rest: restId(n), carved: carvedId(n) }], result: carvedId(n) };
}

/** Runs a plan over amounts: the resulting multiset of cells (checks every step's inputs exist and are consumed once). */
export function applyPlan(cells: readonly PlanCell[], steps: readonly PlanStep[]): Map<string, bigint> {
  const live = new Map(cells.map((c) => [c.id, c.amount] as const));
  const take = (id: string): bigint => {
    const a = live.get(id);
    if (a === undefined) throw new Error(`plan spends ${id}, which is not live`);
    live.delete(id);
    return a;
  };
  for (const s of steps) {
    if (s.kind === 'merge') {
      const total = s.inputs.reduce((a, id) => a + take(id), 0n);
      if (total !== s.amount) throw new Error(`merge ${s.output}: inputs hold ${total}, step says ${s.amount}`);
      live.set(s.output, total);
    } else {
      const a = take(s.input);
      if (s.carve <= 0n || s.carve >= a) throw new Error(`split of ${s.input}: carve ${s.carve} of ${a}`);
      live.set(s.rest, a - s.carve);
      live.set(s.carved, s.carve);
    }
  }
  return live;
}

/* -------------------------------------------------------------------------- */
/* Chained build                                                               */
/* -------------------------------------------------------------------------- */

/** Inputs of `buildExactCellChain` and the merge chain. */
export interface ChainParams extends FeeOptions {
  /** The network's builder context. */
  readonly ctx: BuilderContext;
  /** The owner's spendable cells of one lineage (key-owned, not reserved). */
  readonly cells: readonly TokenCell[];
  /** The owner's key and P2PK address. */
  readonly owner: { readonly xOnlyPubkey: Uint8Array; readonly address: string };
  /** The owner's P2PK UTXOs (minus the reserved set): splits and funded merges draw on them, chained through change. */
  readonly funding: readonly FundingUtxo[];
  /** Funding selection options. */
  readonly fundingOptions?: SelectFundingOptions;
}

/** A built chain: the plan, its transactions in submission order and their total fee. */
export interface ChainResult {
  /** The plan the chain realises. */
  readonly plan: ExactCellPlan | { readonly steps: readonly PlanStep[] };
  /** The transactions, in submission order, unsigned. */
  readonly transactions: readonly Shaped[];
  /** Sum of the transactions' fees, sompi. */
  readonly totalFee: bigint;
  /** The predicted cell the chain ends with (the exact cell, or the merged cell of a consolidation). */
  readonly cell: TokenCell;
}

const planCellsOf = (cells: readonly TokenCell[]): PlanCell[] => cells.map((c) => ({ id: outpointKey(c.outpoint), amount: c.state.amount }));

/** A predicted token cell from a shape's output. */
export function producedCell(s: Shaped, index: number): TokenCell {
  const o = s.built.outputs[index];
  if (o?.cell?.predicted.kind !== 'token' || o.cell.covenantId === undefined) throw new Error(`${s.built.plan.name}: output ${index} is not a token cell`);
  return { kind: 'token', outpoint: { txid: s.built.txid, index }, value: o.value, covenantId: o.cell.covenantId, program: o.cell.program, state: o.cell.predicted.state, daaScore: 0n };
}

/** Execute plan steps in order; every step's cells are real cells or outputs of earlier steps. */
export function buildSteps(params: ChainParams, steps: readonly PlanStep[]): { transactions: Shaped[]; cells: Map<string, TokenCell> } {
  const { ctx, owner } = params;
  const cells = new Map(params.cells.map((c) => [outpointKey(c.outpoint), c] as const));
  let funding = [...params.funding];
  const ownerSpk = p2pkScript(owner.address);
  const take = (id: string): TokenCell => {
    const c = cells.get(id);
    if (!c) throw new Error(`plan step needs cell ${id}, which is not available`);
    cells.delete(id);
    return c;
  };
  const spendFunding = (s: Shaped, used: readonly FundingUtxo[]): void => {
    const spent = new Set(used.map((u) => outpointKey(u.outpoint)));
    funding = funding.filter((u) => !spent.has(outpointKey(u.outpoint)));
    const change = s.optimistic.funding.change;
    if (change) funding.push({ outpoint: change.outpoint, amount: change.amount, spk: ownerSpk, daaScore: 0n, address: owner.address });
  };
  const fee = { ...(params.feeMargin === undefined ? {} : { feeMargin: params.feeMargin }), ...(params.feerate === undefined ? {} : { feerate: params.feerate }) };
  const transactions: Shaped[] = [];
  for (const step of steps) {
    if (step.kind === 'merge') {
      const inputs = step.inputs.map(take);
      let s: Shaped;
      try {
        // Unfunded first: the merged cell pays the fee, no P2PK input, the owner's UTXOs stay free.
        s = buildConsolidate({ ctx, cells: inputs, owner, ...fee });
      } catch (e) {
        if (!(e instanceof ResidualBelowMinimum)) throw e;
        const used = selectFunding(funding, 0n, params.fundingOptions);
        s = buildConsolidate({ ctx, cells: inputs, owner, funding: used, ...fee });
        spendFunding(s, used);
      }
      transactions.push(s);
      cells.set(step.output, producedCell(s, 0));
    } else {
      const input = take(step.input);
      const used = selectFunding(funding, splitValues(input.value).topUp, params.fundingOptions);
      const s = buildSplit({ ctx, cell: input, carve: step.carve, changeAddress: owner.address, funding: used, ...fee });
      spendFunding(s, used);
      transactions.push(s);
      cells.set(step.rest, producedCell(s, 0));
      cells.set(step.carved, producedCell(s, 1));
    }
  }
  return { transactions, cells };
}

/** Plan and build the chain that leaves exactly one cell of exactly `target`; nothing is signed. */
export function buildExactCellChain(params: ChainParams & { readonly target: bigint; readonly mustSpend?: readonly Outpoint[] }): ChainResult {
  const mustSpend = new Set((params.mustSpend ?? []).map(outpointKey));
  const plan = planExactCellSpending(planCellsOf(params.cells), params.target, mustSpend);
  const { transactions, cells } = buildSteps(params, plan.steps);
  const cell = cells.get(plan.result);
  if (!cell || cell.state.amount !== params.target) throw new Error(`chain did not produce a cell of ${params.target}`);
  return { plan, transactions, totalFee: transactions.reduce((a, s) => a + s.built.fee, 0n), cell };
}

/**
 * Merge an owner's cells: into one cell holding at least `target` (an exact 2- or 3-cell subset first, then
 * largest-first rounds), or into a single cell when `target` is omitted.
 */
export function buildMergeChain(params: ChainParams & { readonly target?: bigint }): ChainResult {
  const pc = planCellsOf(params.cells);
  if (pc.length < 2) throw new Error('nothing to consolidate: fewer than two cells');
  let steps: PlanStep[];
  const target = params.target;
  if (target !== undefined) {
    const available = pc.reduce((a, c) => a + c.amount, 0n);
    if (available < target) throw new InsufficientTokensError(target, available);
    if (pc.some((c) => c.amount >= target)) throw new Error(`a cell of at least ${target} already exists`);
    const subset = exactSubset(pc, target);
    steps = subset ? [{ kind: 'merge', inputs: subset.map((c) => c.id), output: mergedId(0), amount: target }] : planMerges(pc, target).steps;
  } else {
    steps = planMerges(pc, undefined).steps;
  }
  const { transactions, cells } = buildSteps(params, steps);
  const last = steps[steps.length - 1]!;
  if (last.kind !== 'merge') throw new Error('unreachable: a merge chain ends with a merge');
  return { plan: { steps }, transactions, totalFee: transactions.reduce((a, s) => a + s.built.fee, 0n), cell: required(cells.get(last.output), `the merged cell ${last.output}`) };
}
