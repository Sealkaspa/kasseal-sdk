/**
 * Deposit and withdrawal planning. `addLiquidity` absorbs the user's T
 * cell whole and `removeLiquidity` the user's L cell whole, so before either the holder must own exactly
 * one cell of exactly the amount: `dTok` tokens for a deposit of `shares` shares, `shares` LP shares for a
 * withdrawal. The exact-cell planner (`planner.ts`: use, split, merge, merge then split) produces that cell,
 * and the add or remove is chained on it; everything is built before anything is signed and the chain is
 * returned with its total fee, as `buildExactCellChain` does for sells.
 *
 * Funding is threaded through the chain: the P2PK UTXOs the splits and funded merges spend are removed
 * and their predicted change outputs added, so the final transaction never spends an outpoint an
 * earlier one consumed and may spend their change.
 */

import { poolLimitsOf } from '../cells.ts';
import { outpointKey, p2pkScript, ResidualBelowMinimum, type FundingUtxo, type PoolCell, type TokenCell } from '../assemble.ts';
import type { BuilderContext } from '../cells.ts';
import { POOL_KAS_SCALE } from '../program.ts';
import type { FeeOptions, Shaped } from '../shapes/common.ts';
import {
  DEFAULT_LP_CELL_VALUE, buildAddLiquidity, buildRemoveLiquidity, defaultTokenCellValue, depositQuote, requirePoolInventory, withdrawalNeedsTopUp, withdrawalQuote,
  type AddLiquidityResult, type RemoveLiquidityResult,
} from '../shapes/liquidity.ts';
import { selectFunding, type SelectFundingOptions } from './funding.ts';
import { buildExactCellChain, type ExactCellPlan } from './planner.ts';

interface LiquidityChainBase extends FeeOptions {
  readonly ctx: BuilderContext;
  readonly pool: PoolCell;
  readonly inventory: TokenCell;
  readonly reserve: TokenCell;
  readonly owner: { readonly xOnlyPubkey: Uint8Array; readonly address: string };
  /** The owner's P2PK UTXOs (minus the reserved set). */
  readonly funding: readonly FundingUtxo[];
  readonly fundingOptions?: SelectFundingOptions;
  readonly shares: bigint;
  /** The token lineage of the pool; the pool must name it (`LineageMismatch`). */
  readonly tokenId?: string;
}

/** Inputs of `buildDepositChain`: the owner's cells and funding, the bound pool, its reserve and inventory. */
export interface DepositChainParams extends LiquidityChainBase {
  /** The owner's spendable T cells (key-owned, not reserved). */
  readonly cells: readonly TokenCell[];
  /** Value of the new LP cell, sompi (default 5 KAS). */
  readonly lpCellValue?: bigint;
  /** The caller asserts the Kasseal API's invariant monitor confirms this pool. */
  readonly lpSafe: true;
  /** The most KAS the final deposit may take from the wallet all-in (`NetBoundExceeded`). */
  readonly maxAllIn?: bigint;
}

/** Inputs of `buildWithdrawalChain`: the owner's LP cells and funding, the bound pool, its reserve and inventory. */
export interface WithdrawalChainParams extends LiquidityChainBase {
  /** The owner's spendable L cells (key-owned, not reserved). */
  readonly lpCells: readonly TokenCell[];
  /** Pre-check on the KAS leg, 0.01 KAS units. */
  readonly minKasOut?: bigint;
  /** Pre-check on the token leg, whole tokens. */
  readonly minTokOut?: bigint;
  /** Value of the new token cell, sompi. */
  readonly tokCellValue?: bigint;
  /** The least KAS the final withdrawal may pay the wallet net (`NetBoundExceeded`). */
  readonly minNetOut?: bigint;
}

/** A deposit or withdrawal chain: the exact-cell plan, every transaction and the total fee. */
export interface LiquidityChainResult<R extends AddLiquidityResult | RemoveLiquidityResult> {
  /** How the exact cell is produced (`kind: 'exact'` when it already existed). */
  readonly plan: ExactCellPlan;
  /** The splits and merges, then the add or remove, in submission order. */
  readonly transactions: readonly Shaped[];
  /** Sum of the transactions' fees, sompi. */
  readonly totalFee: bigint;
  /** The deposit or withdrawal itself (the last transaction). */
  readonly final: R;
}

/** The owner's funding after `transactions`: the P2PK outpoints they spend removed, their predicted change added. */
export function remainingFunding(funding: readonly FundingUtxo[], transactions: readonly Shaped[], owner: { readonly address: string }): FundingUtxo[] {
  const spent = new Set<string>();
  for (const s of transactions) for (const i of s.built.plan.inputs) if (i.covenantId === undefined) spent.add(outpointKey(i.outpoint));
  const out = funding.filter((u) => !spent.has(outpointKey(u.outpoint)));
  const spk = p2pkScript(owner.address);
  for (const s of transactions) {
    const change = s.optimistic.funding.change;
    if (change) out.push({ outpoint: change.outpoint, amount: change.amount, spk, daaScore: 0n, address: owner.address });
  }
  return out;
}

const feeOf = (p: FeeOptions): FeeOptions => ({ ...(p.feeMargin === undefined ? {} : { feeMargin: p.feeMargin }), ...(p.feerate === undefined ? {} : { feerate: p.feerate }) });

/**
 * Plan and build a deposit of `shares`: the chain that leaves exactly one T cell of `dTok`, then the
 * `addLiquidity` absorbing it. The KAS leg, the LP cell's funding beyond the absorbed cell's value and
 * the fee come from the owner's remaining funding. Nothing is signed.
 */
export function buildDepositChain(params: DepositChainParams): LiquidityChainResult<AddLiquidityResult> {
  const { ctx, pool, inventory, reserve, owner, shares } = params;
  requirePoolInventory(pool, inventory, poolLimitsOf(ctx));
  const q = depositQuote(pool, shares, poolLimitsOf(ctx));
  const fee = feeOf(params);
  const chain = buildExactCellChain({ ctx, cells: params.cells, owner, funding: params.funding, target: q.dTok, ...(params.fundingOptions === undefined ? {} : { fundingOptions: params.fundingOptions }), ...fee });
  const left = remainingFunding(params.funding, chain.transactions, owner);
  const V = params.lpCellValue ?? DEFAULT_LP_CELL_VALUE;
  const topUp = V > chain.cell.value ? V - chain.cell.value : 0n;
  const used = selectFunding(left, q.dKasScaled * POOL_KAS_SCALE + topUp, params.fundingOptions);
  const add = buildAddLiquidity({
    ctx, pool, inventory, reserve, userCell: chain.cell, funding: used, changeAddress: owner.address, shares, lpSafe: params.lpSafe,
    ...(params.lpCellValue === undefined ? {} : { lpCellValue: params.lpCellValue }), ...fee,
    ...(params.tokenId === undefined ? {} : { tokenId: params.tokenId }), ...(params.maxAllIn === undefined ? {} : { maxAllIn: params.maxAllIn }),
  });
  const transactions = [...chain.transactions, add];
  return { plan: chain.plan as ExactCellPlan, transactions, totalFee: transactions.reduce((a, s) => a + s.built.fee, 0n), final: add };
}

/**
 * Plan and build a withdrawal of `shares`: the chain that leaves exactly one L cell of `shares`, then the
 * `removeLiquidity` absorbing it. The remove is unfunded when the payout (the L cell's value beyond the token
 * cell's plus the KAS leg) is comfortably above the floor (`WITHDRAWAL_PAYOUT_COMFORT`); otherwise, or when the fee
 * still leaves too little, one funding selection tops it up. Nothing is signed.
 */
export function buildWithdrawalChain(params: WithdrawalChainParams): LiquidityChainResult<RemoveLiquidityResult> {
  const { ctx, pool, inventory, reserve, owner, shares } = params;
  const L = requirePoolInventory(pool, inventory, poolLimitsOf(ctx));
  const q = withdrawalQuote(pool, shares, params.minKasOut, params.minTokOut, poolLimitsOf(ctx));
  for (const c of params.lpCells) if (c.covenantId !== L) throw new Error(`cell ${outpointKey(c.outpoint)} is not of the pool's L ${L}`);
  const fee = feeOf(params);
  const chain = buildExactCellChain({ ctx, cells: params.lpCells, owner, funding: params.funding, target: shares, ...(params.fundingOptions === undefined ? {} : { fundingOptions: params.fundingOptions }), ...fee });
  const V = params.tokCellValue ?? defaultTokenCellValue(chain.cell.value);
  const base = {
    ctx, pool, inventory, reserve, userLpCell: chain.cell, changeAddress: owner.address, shares, tokCellValue: V,
    ...(params.minKasOut === undefined ? {} : { minKasOut: params.minKasOut }), ...(params.minTokOut === undefined ? {} : { minTokOut: params.minTokOut }), ...fee,
    ...(params.tokenId === undefined ? {} : { tokenId: params.tokenId }), ...(params.minNetOut === undefined ? {} : { minNetOut: params.minNetOut }),
  };
  let remove: RemoveLiquidityResult | undefined;
  if (!withdrawalNeedsTopUp(chain.cell.value, V, q.dKasScaled)) {
    try {
      remove = buildRemoveLiquidity(base);
    } catch (e) {
      if (!(e instanceof ResidualBelowMinimum)) throw e;
    }
  }
  if (remove === undefined) {
    const left = remainingFunding(params.funding, chain.transactions, owner);
    remove = buildRemoveLiquidity({ ...base, funding: selectFunding(left, 0n, params.fundingOptions) });
  }
  const transactions = [...chain.transactions, remove];
  return { plan: chain.plan as ExactCellPlan, transactions, totalFee: transactions.reduce((a, s) => a + s.built.fee, 0n), final: remove };
}

