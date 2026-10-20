/**
 * split 1 -> 2 (the reference token's normal path with two continuations):
 *
 *   in0   KCC20 user cell (T leader)   transfer([rest, carved], 00 || sig65)   the owner signs this P2SH input
 *   in1.. owner KAS (P2PK)             fee, and any KAS the two cells need beyond the input cell's
 *   out0  rest    binding (0, T)       the input state with amount - carve (owner, borrow scheme and guard kept)
 *   out1  carved  binding (0, T)       amount = carve, same owner, borrowing disabled, same extension commitment
 *   out2  change
 *
 * The carved cell is the one a sell or token->KAS swap then absorbs whole, so
 * it is created with borrowing disabled: a borrowable cell can be grown by any
 * party, which would change the amount a pending sell expects.
 *
 * Cell values default to the input cell's value split in half (for example
 * 10 KAS into 5 + 5), each half raised to `SPLIT_MIN_CELL_VALUE` with the difference
 * taken from the funding input. Storage mass is 4e12 / v per new cell, so two
 * 0.1 KAS cells (the user-cell floor) would weigh 800,000 g, above the block
 * limit; at 2.5 KAS each the split's storage stays near its transient floor. The carved cell's KAS returns to the seller in the payout of
 * the sell that absorbs it.
 */

import { kcc0020Fields, makeKcc0020State, type TokenState } from '@kasseal/codec';
import { p2pkScript, type FundingUtxo, type TokenCell, type TxPlan } from '../assemble.ts';
import { changeTo, kasInput, tokenLeaderSignedInput, tokenOutput, type BuilderContext } from '../cells.ts';
import { signedLeaderBudget } from '../mass.ts';
import { BORROW_SCHEME_DISABLED, ZERO32 } from '../program.ts';
import { WITNESS_SIGNED, checkTokenFamily, feeFields, finish, type FeeOptions, type Shaped } from './common.ts';

/** Inputs of `buildSplit`. */
export interface SplitParams extends FeeOptions {
  /** The network's builder context. */
  readonly ctx: BuilderContext;
  /** A key-owned cell (owner scheme 0x00) holding more than `carve`. */
  readonly cell: TokenCell;
  /** Token amount of the carved cell. */
  readonly carve: bigint;
  /** P2PK address of the cell's owner: change. */
  readonly changeAddress: string;
  /** Pays the fee (and any top-up of the two cell values). */
  readonly funding: readonly FundingUtxo[];
  /** KAS value of the carved cell, sompi (default: `splitValues`). */
  readonly carveValue?: bigint;
  /** KAS value of the rest cell, sompi (default: `splitValues`). */
  readonly restValue?: bigint;
}

/** The built split and the two cells' states. */
export interface SplitResult extends Shaped {
  /** The rest cell's state. */
  readonly restNext: TokenState;
  /** The carved cell's state. */
  readonly carvedNext: TokenState;
}

/** The state of a carved cell: the source's owner and extension commitment, borrowing disabled. */
export function carvedState(source: TokenState, amount: bigint): TokenState {
  const f = kcc0020Fields(source);
  return makeKcc0020State({ amount, owner: f.owner, ownerScheme: f.ownerScheme, borrowScheme: BORROW_SCHEME_DISABLED, borrowGuard: ZERO32, extensionCommitment: f.extensionCommitment });
}

/** The source state with a new amount (every other field kept). */
export function withAmount(source: TokenState, amount: bigint): TokenState {
  return makeKcc0020State({ ...kcc0020Fields(source), amount });
}

/** Lowest default value of a split's output cells: keeps the split's storage mass near its transient floor. */
export const SPLIT_MIN_CELL_VALUE = 250_000_000n;

/** Default cell values of a split of a cell worth `value`: halves, each raised to `SPLIT_MIN_CELL_VALUE`; `topUp` comes from funding. */
export function splitValues(value: bigint): { carveValue: bigint; restValue: bigint; topUp: bigint } {
  const half = value / 2n;
  const carveValue = half < SPLIT_MIN_CELL_VALUE ? SPLIT_MIN_CELL_VALUE : half;
  const restValue = value - carveValue < SPLIT_MIN_CELL_VALUE ? SPLIT_MIN_CELL_VALUE : value - carveValue;
  const topUp = carveValue + restValue - value;
  return { carveValue, restValue, topUp: topUp > 0n ? topUp : 0n };
}

/** Carve `carve` tokens out of one key-owned cell into a new cell; refuses a carve outside (0, amount) and missing funding. */
export function buildSplit(params: SplitParams): SplitResult {
  const { ctx, cell, carve, funding } = params;
  const T = cell.covenantId;
  if (cell.state.owner.schemeByte !== 0x00) throw new Error('split: the builder signs only key-owned cells (owner scheme 0x00)');
  if (carve <= 0n || carve >= cell.state.amount) throw new Error(`split: carve ${carve} must be positive and below the cell's ${cell.state.amount}`);
  if (funding.length === 0) throw new Error('split needs a funding input for the fee');
  const defaults = splitValues(cell.value);
  const carveValue = params.carveValue ?? defaults.carveValue;
  const restValue = params.restValue ?? (params.carveValue === undefined ? defaults.restValue : cell.value - carveValue);

  const restNext = withAmount(cell.state, cell.state.amount - carve);
  const carvedNext = carvedState(cell.state, carve);
  checkTokenFamily(T, [cell], [restNext, carvedNext], WITNESS_SIGNED);
  const plan: TxPlan = {
    name: `split ${cell.state.amount} -> ${cell.state.amount - carve} + ${carve}`,
    inputs: [
      tokenLeaderSignedInput(cell, [restNext, carvedNext], 'KCC20 cell (T leader, 00 || sig)', signedLeaderBudget(1, 2)),
      ...funding.map((u) => kasInput(u, 'owner KAS (fee)')),
    ],
    outputs: [
      tokenOutput(ctx, 'rest (owner kept)', restNext, restValue, T, 0),
      tokenOutput(ctx, 'carved cell', carvedNext, carveValue, T, 0),
    ],
    residual: changeTo(p2pkScript(params.changeAddress)),
    genesisGroups: [],
    payload: new Uint8Array(0),
    ...feeFields(params),
  };
  return { ...finish(plan, ['token-user', 'token-user'], 'change'), restNext, carvedNext };
}
