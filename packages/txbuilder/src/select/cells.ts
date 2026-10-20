/**
 * Token cell selection for a sell or token->KAS swap, which absorbs one cell
 * holding exactly the amount (`OpCovOutputCount(T) == 1`, no change record):
 *
 *   exact                 a cell holds the amount
 *   needs-split           a cell holds more (the smallest such cell is named)
 *   needs-consolidation   2 or 3 cells sum to it exactly (`max_token_inputs = 3`)
 *   needs-plan            the holder has enough only across a longer merge chain (select/planner.ts)
 *   insufficient
 *
 * Only cells the builder can have signed are candidates: key-owned
 * (owner scheme 0x00), of the lineage, not already reserved by a pending
 * transaction. The order of `cells` is kept among equal amounts, so a caller
 * that lists cells in a stable order gets a stable choice.
 */

import { MAX_TOKEN_INPUTS } from '@kasseal/codec';
import { outpointKey, type TokenCell } from '../assemble.ts';

/** The result of `selectTokenCells` (see the module comment). */
export type TokenSelection =
  | { readonly kind: 'exact'; readonly cell: TokenCell }
  | { readonly kind: 'needs-split'; readonly cell: TokenCell; readonly available: bigint }
  | { readonly kind: 'needs-consolidation'; readonly cells: readonly TokenCell[] }
  | { readonly kind: 'needs-plan'; readonly available: bigint }
  | { readonly kind: 'insufficient'; readonly available: bigint };

/** Options of `spendableCells`. */
export interface SelectCellsOptions {
  /** Outpoints of cells consumed by pending transactions. */
  readonly reserved?: ReadonlySet<string>;
  /** Most cells one transaction may merge (default 3). */
  readonly maxInputs?: number;
}

const byAmountDesc = (a: TokenCell, b: TokenCell): number => (a.state.amount < b.state.amount ? 1 : a.state.amount > b.state.amount ? -1 : 0);

/** Cells the builder can spend for `owner` (x-only key hex) in lineage `T`, minus the reserved set. */
export function spendableCells(cells: readonly TokenCell[], T: string | undefined, options: SelectCellsOptions = {}): TokenCell[] {
  const reserved = options.reserved ?? new Set<string>();
  return cells.filter((c) => (T === undefined || c.covenantId === T) && c.state.owner.schemeByte === 0x00 && c.state.amount > 0n && !reserved.has(outpointKey(c.outpoint)));
}

/** Find the cell or cell set of a holder that yields exactly `amount` tokens (see the module comment). */
export function selectTokenCells(cells: readonly TokenCell[], amount: bigint, maxInputs: number = MAX_TOKEN_INPUTS): TokenSelection {
  if (amount <= 0n) throw new Error('amount must be positive');
  const available = cells.reduce((a, c) => a + c.state.amount, 0n);
  if (available < amount) return { kind: 'insufficient', available };
  const exact = cells.find((c) => c.state.amount === amount);
  if (exact) return { kind: 'exact', cell: exact };
  // A split of the smallest larger cell before any merge.
  const larger = cells.filter((c) => c.state.amount > amount).sort(byAmountDesc);
  if (larger.length > 0) return { kind: 'needs-split', cell: larger[larger.length - 1]!, available };
  const sorted = [...cells].sort(byAmountDesc);
  for (let size = 2; size <= Math.min(maxInputs, sorted.length); size++) {
    const found = subsetOfSize(sorted, size, amount);
    if (found) return { kind: 'needs-consolidation', cells: found };
  }
  return { kind: 'needs-plan', available };
}

/** A subset of exactly `size` cells summing to `amount`, preferring larger cells first (fewer small cells left behind). */
export function subsetOfSize(cells: readonly TokenCell[], size: number, amount: bigint): TokenCell[] | undefined {
  const pick: TokenCell[] = [];
  const rec = (start: number, remaining: bigint): boolean => {
    if (pick.length === size) return remaining === 0n;
    for (let i = start; i < cells.length; i++) {
      const c = cells[i]!;
      if (c.state.amount > remaining) continue;
      pick.push(c);
      if (rec(i + 1, remaining - c.state.amount)) return true;
      pick.pop();
    }
    return false;
  };
  return rec(0, amount) ? pick : undefined;
}
