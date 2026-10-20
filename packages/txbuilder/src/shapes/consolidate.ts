/**
 * consolidate k -> 1, k in {2, 3}:
 *
 *   in0     KCC20 cell (T leader)        transfer([merged], 00 || sig65)   signature slot at 114 (one user-owned record)
 *   in1..   KCC20 cells (T delegators)   transfer_delegator(sig65)         signature slot at 1
 *   [in_k.. owner KAS (P2PK)]
 *   out0    merged  binding (0, T)       the leader's state with the summed amount
 *   [out1   change]
 *
 * Two fee modes, both accepted on chain:
 *   - unfunded: the merged cell is the residual output and pays
 *     the fee out of the cells' KAS (no P2PK input, so the owner's funding
 *     UTXOs stay free and storage mass is zero: the inputs relieve the single
 *     larger output);
 *   - funded: the merged cell carries the sum of the cells' values and a
 *     funding input pays the fee, with change.
 *
 * `max_token_inputs = 3` bounds k; longer merges are chained by the planner
 * (select/planner.ts), each round's merged cell leading the next round.
 */

import { toHex, type TokenState } from '@kasseal/codec';
import { p2pkScript, type FundingUtxo, type TokenCell, type TxPlan } from '../assemble.ts';
import { changeTo, kasInput, tokenDelegatorSignedInput, tokenLeaderSignedInput, tokenOutput, tokenResidual, type BuilderContext } from '../cells.ts';
import { signedLeaderBudget } from '../mass.ts';
import { MIN_USER_CELL_VALUE, WITNESS_SIGNED, checkTokenFamily, feeFields, finish, type FeeOptions, type Shaped } from './common.ts';
import { withAmount } from './split.ts';

/** Inputs of `buildConsolidate`. */
export interface ConsolidateParams extends FeeOptions {
  /** The network's builder context. */
  readonly ctx: BuilderContext;
  /** Two or three cells of one lineage with the same key owner; `cells[0]` is the leader. */
  readonly cells: readonly TokenCell[];
  /** Owner key (checked against every cell) and P2PK address (change in the funded mode). */
  readonly owner: { readonly xOnlyPubkey: Uint8Array; readonly address: string };
  /** Funded mode when given and non-empty; otherwise the merged cell pays the fee. */
  readonly funding?: readonly FundingUtxo[];
}

/** The built merge and the merged cell's state. */
export interface ConsolidateResult extends Shaped {
  /** The merged cell's state. */
  readonly next: TokenState;
}

/** Merge two or three key-owned cells of one lineage into one; refuses mixed owners or lineages and other counts. */
export function buildConsolidate(params: ConsolidateParams): ConsolidateResult {
  const { ctx, cells, owner } = params;
  if (cells.length < 2 || cells.length > 3) throw new Error('consolidate takes 2 or 3 cells (max_token_inputs = 3)');
  const T = cells[0]!.covenantId;
  const ownerHex = toHex(owner.xOnlyPubkey);
  const seen = new Set<string>();
  for (const c of cells) {
    if (c.covenantId !== T) throw new Error('cells are of different lineages');
    if (c.state.owner.schemeByte !== 0x00 || toHex(c.state.owner.identifier) !== ownerHex) throw new Error('every cell must be p2pk-owned by the same key');
    const key = `${c.outpoint.txid}:${c.outpoint.index}`;
    if (seen.has(key)) throw new Error(`cell ${key} appears twice`);
    seen.add(key);
  }
  const total = cells.reduce((a, c) => a + c.state.amount, 0n);
  const next = withAmount(cells[0]!.state, total);
  checkTokenFamily(T, cells, [next], WITNESS_SIGNED);
  const funding = params.funding ?? [];
  const inputs = [
    tokenLeaderSignedInput(cells[0]!, [next], 'KCC20 leader (00 || sig)', signedLeaderBudget(cells.length, 1)),
    ...cells.slice(1).map((c, i) => tokenDelegatorSignedInput(c, `KCC20 delegator ${i + 1} (sig)`)),
    ...funding.map((u) => kasInput(u, 'owner KAS (fee)')),
  ];
  const name = `consolidate ${cells.length}->1`;
  const plan: TxPlan = funding.length === 0
    ? { name, inputs, outputs: [], residual: tokenResidual(ctx, 'consolidated cell', next, T, 0, MIN_USER_CELL_VALUE), genesisGroups: [], payload: new Uint8Array(0), ...feeFields(params) }
    : {
        name,
        inputs,
        outputs: [tokenOutput(ctx, 'consolidated cell', next, cells.reduce((a, c) => a + c.value, 0n), T, 0)],
        residual: changeTo(p2pkScript(owner.address)),
        genesisGroups: [],
        payload: new Uint8Array(0),
        ...feeFields(params),
      };
  const s = funding.length === 0 ? finish(plan, [], 'token-user') : finish(plan, ['token-user'], 'change');
  return { ...s, next };
}
