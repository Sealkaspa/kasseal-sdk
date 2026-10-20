/**
 * The curve's supply and reserve cells (and a pool's reserve), picked by state, never by position.
 *
 * Nothing on chain marks which C-owned token cell is "the supply" and which is "the reserve": the curve finds them
 * only by their fields (owner C under scheme 0x04, borrowing disabled, a zero guard) and the amounts it pins:
 *
 *   supply    (curveLots - lotsSold) * lot
 *   reserve   gradReserve
 *
 * Anyone can send T to owner C (a decoy), and at `lotsSold = curveLots - gradReserve / lot` (400,000 lots on every
 * launchable preset) the two pinned amounts are equal, so either cell can serve either role. A source that lists
 * cells by age or by launch output therefore serves the wrong one. These selectors take every candidate the sources
 * offer, keep the cells whose fields and amounts the covenant would accept, and return two distinct outpoints when the
 * amounts are equal. Every other covenant-owned cell (a decoy, a donation) is ignored.
 */

import { borrowGuardOf, borrowSchemeOf, toHex } from '@kasseal/codec';
import { outpointKey, type TokenCell } from '../assemble.ts';
import { BORROW_SCHEME_DISABLED, isCovenantOwnedBy } from '../program.ts';

/** Thrown when no candidate cell has the state the covenant pins. */
export class CovenantCellNotFound extends Error {
  /** Which cell was looked for. */
  readonly role: 'supply' | 'reserve' | 'pool-reserve';
  /** The amount the covenant pins, whole tokens. */
  readonly expectedAmount: bigint;
  /** How many covenant-owned candidates were examined. */
  readonly candidates: number;
  constructor(role: 'supply' | 'reserve' | 'pool-reserve', expectedAmount: bigint, candidates: number) {
    super(`no live ${role} cell holding ${expectedAmount} tokens among ${candidates} covenant-owned candidate(s)`);
    this.name = 'CovenantCellNotFound';
    this.role = role;
    this.expectedAmount = expectedAmount;
    this.candidates = candidates;
  }
}

const ZERO_GUARD = '00'.repeat(32);

/**
 * A token cell of lineage `T` the covenant `owner` can spend as its own: owner `owner` under scheme 0x04, borrowing
 * disabled, a zero borrow guard.
 */
export function isCovenantVaultCell(cell: TokenCell, T: string, owner: string): boolean {
  if (cell.covenantId !== T || !isCovenantOwnedBy(cell.state, owner)) return false;
  try {
    return borrowSchemeOf(cell.state) === BORROW_SCHEME_DISABLED && toHex(borrowGuardOf(cell.state)) === ZERO_GUARD;
  } catch {
    return false;
  }
}

/** Distinct candidates in the order given (the first sighting of an outpoint wins). */
function distinct(cells: readonly TokenCell[]): TokenCell[] {
  const seen = new Set<string>();
  const out: TokenCell[] = [];
  for (const c of cells) {
    const k = outpointKey(c.outpoint);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/** The token amounts the curve pins on its two cells. */
export interface CurveCellAmounts {
  /** `(curveLots - lotsSold) * lot` from the verified curve head and its committed template. */
  readonly supply: bigint;
  /** `gradReserve` of the committed template. */
  readonly reserve: bigint;
}

/**
 * The supply cell and, when `needReserve`, the reserve cell, from `candidates` (any order, duplicates allowed). The
 * supply is the first candidate of the pinned supply amount; the reserve the first *other* candidate of the reserve
 * amount, so the crossover (equal amounts) yields two distinct outpoints. Throws `CovenantCellNotFound`.
 */
export function selectCurveCells(
  candidates: readonly TokenCell[], T: string, curveId: string, amounts: CurveCellAmounts, needReserve: true,
): { supply: TokenCell; reserve: TokenCell };
export function selectCurveCells(
  candidates: readonly TokenCell[], T: string, curveId: string, amounts: CurveCellAmounts, needReserve?: boolean,
): { supply: TokenCell; reserve: TokenCell | undefined };
export function selectCurveCells(
  candidates: readonly TokenCell[], T: string, curveId: string, amounts: CurveCellAmounts, needReserve = false,
): { supply: TokenCell; reserve: TokenCell | undefined } {
  const own = distinct(candidates).filter((c) => isCovenantVaultCell(c, T, curveId));
  const supply = own.find((c) => c.state.amount === amounts.supply);
  if (supply === undefined) throw new CovenantCellNotFound('supply', amounts.supply, own.length);
  const reserve = own.find((c) => c !== supply && c.state.amount === amounts.reserve);
  if (reserve === undefined && needReserve) throw new CovenantCellNotFound('reserve', amounts.reserve, own.length);
  return { supply, reserve };
}

/** The pool's reserve: the one P-owned cell of lineage `T` holding exactly `tokenReserve` (first of several). */
export function selectPoolReserve(candidates: readonly TokenCell[], T: string, poolId: string, tokenReserve: bigint): TokenCell {
  const own = distinct(candidates).filter((c) => isCovenantVaultCell(c, T, poolId));
  const r = own.find((c) => c.state.amount === tokenReserve);
  if (r === undefined) throw new CovenantCellNotFound('pool-reserve', tokenReserve, own.length);
  return r;
}
