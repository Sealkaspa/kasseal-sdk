/**
 * Mass and fee model of rusty-kaspa v2.1.0, checked exact against the node on
 * accepted and rejected testnet-10 transactions:
 *
 *   bytes      = consensus serialized size
 *   compute    = bytes + 10 * sum_outputs(2 + spk_len) + 100 * sum_inputs(budget)
 *   transient  = 4 * bytes, normalized = ceil(transient / 2)
 *   plurality  p = ceil((63 + spk_len + 32 * has_covenant) / 100)   (2 for P2SH + covenant, 1 for P2PK)
 *   storage    = max(0, sum_outputs C p^2 / v  -  relief),  C = 1e12
 *                relief = relaxed ? sum_inputs C p^2 / v : sum(p_in) * (C / floor(sum(v_in) / sum(p_in)))
 *                relaxed = sum(p_out) == 1 or (|I| <= 2 and (sum(p_in) == 1 or (sum(p_out) == 2 and sum(p_in) == 2)))
 *   fee        = 100 sompi * max(compute, normalized transient, storage)
 *
 * The model works on a plain shape so it can be checked against recorded
 * transactions without the SDK. The Kaspa SDK's mass functions are not used:
 * they ignore `computeBudget` and plurality.
 *
 * Compute budgets are a static table (measured minima + 1, from the contract
 * test harnesses), never searched against the live node.
 */

/** Sompi per KAS. */
export const SOMPI_PER_KAS = 100_000_000n;
/** Default buyer cell funding `V`, sompi (the buy sits at the transient floor). Re-exported by `shapes/common.ts`. */
export const DEFAULT_USER_CELL_VALUE = 5n * SOMPI_PER_KAS;
/** The node's minimum feerate, sompi per gram of mass. */
export const FEERATE_SOMPI_PER_GRAM = 100n;
/**
 * The highest feerate the builder accepts from `GET /fees` (20 times the node's floor). The feerate is the one
 * wire-supplied number the user's SIGHASH_ALL signature binds without any consensus check, so an API answer above
 * this is refused (`FeerateOutOfRange`), never used: at the floor a buy costs 0.025 KAS, at this cap 0.5 KAS.
 */
export const FEERATE_MAX_SOMPI_PER_GRAM = 20n * FEERATE_SOMPI_PER_GRAM;
/**
 * No transaction the assembler builds pays more than `max(FEE_CEILING_MULTIPLE * minFee, FEE_CEILING_FLOOR)`: a
 * fee-margin, a dropped change output or a feerate inside the cap can never turn a surplus into miner fee past this
 * (`FeeAboveCeiling`). The multiple is above the feerate cap (20x) plus the largest dropped change (0.1 KAS on a
 * small shape); the floor keeps tiny shapes from refusing a legitimately dropped change.
 */
export const FEE_CEILING_MULTIPLE = 50n;
/** The fee ceiling's floor, sompi (1 KAS). */
export const FEE_CEILING_FLOOR = SOMPI_PER_KAS;
/** KIP-9 storage mass parameter C. */
export const STORAGE_MASS_PARAMETER = 1_000_000_000_000n;
/** Block storage mass limit, grams. */
export const BLOCK_STORAGE_MASS_LIMIT = 500_000;
/** Block compute mass limit, grams. */
export const BLOCK_COMPUTE_MASS_LIMIT = 500_000;
/** Block transient mass limit, grams. */
export const BLOCK_TRANSIENT_MASS_LIMIT = 1_000_000;
/** Below these an output can never be mined (storage mass above the block limit). */
export const P2PK_OUTPUT_FLOOR = STORAGE_MASS_PARAMETER / BigInt(BLOCK_STORAGE_MASS_LIMIT); // 0.02 KAS
/** The least value of a covenant (P2SH + binding) output, sompi. */
export const COVENANT_OUTPUT_FLOOR = (4n * STORAGE_MASS_PARAMETER) / BigInt(BLOCK_STORAGE_MASS_LIMIT); // 0.08 KAS

/** An input as the mass model sees it. */
export interface ShapeInput {
  /** Signature script length, bytes. */
  readonly sigScriptLength: number;
  /** Compute budget, units of 10,000 script units. */
  readonly computeBudget: number;
  /** The spent output's value, sompi. */
  readonly amount: bigint;
  /** The spent output's script public key length, bytes. */
  readonly spkLength: number;
  /** Whether the spent output is covenant-bound. */
  readonly hasCovenant: boolean;
}

/** An output as the mass model sees it. */
export interface ShapeOutput {
  /** Value, sompi. */
  readonly value: bigint;
  /** Script public key length, bytes. */
  readonly spkLength: number;
  /** Whether the output carries a covenant binding. */
  readonly hasCovenant: boolean;
}

/** A transaction as the mass model sees it. */
export interface TxShape {
  readonly inputs: readonly ShapeInput[];
  readonly outputs: readonly ShapeOutput[];
  /** Payload length, bytes. */
  readonly payloadLength: number;
}

/** A transaction's masses, in grams. */
export interface Masses {
  /** Serialized size, bytes. */
  readonly bytes: number;
  /** Compute mass. */
  readonly compute: number;
  /** Transient mass (4 x bytes). */
  readonly transient: number;
  /** `ceil(transient / 2)`. */
  readonly normalizedTransient: number;
  /** KIP-9 storage mass. */
  readonly storage: number;
  /** The largest of compute, normalized transient and storage. */
  readonly max: number;
  /** `100 * max`, sompi. */
  readonly minFee: bigint;
  /** Which bucket binds the fee. */
  readonly binding: 'compute' | 'transient' | 'storage';
}

/** Consensus serialized size of a v1 transaction (`consensus/core/src/mass/mod.rs`). */
export function serializedSize(shape: TxShape): number {
  let size = 2 + 8; // version u16, input count u64
  for (const i of shape.inputs) size += 32 + 4 + 8 + i.sigScriptLength + 8 + 2; // outpoint, sigscript length prefix + bytes, sequence, budget u16
  size += 8; // output count
  for (const o of shape.outputs) size += 8 + 2 + 8 + o.spkLength + (o.hasCovenant ? 2 + 32 : 0); // value, spk version, spk length prefix + bytes, binding
  size += 8 + 20 + 8 + 32 + 8 + shape.payloadLength; // lock time, subnetwork, gas, payload hash, payload length prefix + bytes
  return size;
}

/** Compute mass: serialized size plus 10 per output script byte (plus 2) plus 100 per budget unit. */
export function computeMass(shape: TxShape): number {
  let spk = 0;
  for (const o of shape.outputs) spk += 2 + o.spkLength;
  let budget = 0;
  for (const i of shape.inputs) budget += i.computeBudget;
  return serializedSize(shape) + spk * 10 + budget * 100;
}

/** Transient mass: 4 x the serialized size. */
export const transientMass = (shape: TxShape): number => serializedSize(shape) * 4;

/** KIP-9 UTXO plurality of an output with this script length. */
export function plurality(spkLength: number, hasCovenant: boolean): number {
  return Math.ceil((63 + spkLength + (hasCovenant ? 32 : 0)) / 100);
}

interface Weighted { readonly plurality: bigint; readonly amount: bigint }

/** KIP-9 storage mass with UTXO plurality (`calc_storage_mass`). */
export function storageMass(ins: readonly Weighted[], outs: readonly Weighted[]): bigint {
  const C = STORAGE_MASS_PARAMETER;
  let outsP = 0n;
  let harmOuts = 0n;
  for (const o of outs) {
    if (o.amount <= 0n) throw new Error('storage mass: output value must be positive');
    outsP += o.plurality;
    harmOuts += (C * o.plurality * o.plurality) / o.amount;
  }
  const insP = ins.reduce((a, i) => a + i.plurality, 0n);
  const relaxed = outsP === 1n || (ins.length <= 2 && (insP === 1n || (outsP === 2n && insP === 2n)));
  if (relaxed) {
    const harmIns = ins.reduce((a, i) => a + (C * i.plurality * i.plurality) / i.amount, 0n);
    return harmOuts > harmIns ? harmOuts - harmIns : 0n;
  }
  const sumIns = ins.reduce((a, i) => a + i.amount, 0n);
  let mean = sumIns / insP;
  if (mean < 1n) mean = 1n;
  const arith = insP * (C / mean);
  return harmOuts > arith ? harmOuts - arith : 0n;
}

/** Every mass of `shape` and the minimum fee at `FEERATE_SOMPI_PER_GRAM`. */
export function masses(shape: TxShape): Masses {
  const ins = shape.inputs.map((i) => ({ plurality: BigInt(plurality(i.spkLength, i.hasCovenant)), amount: i.amount }));
  const outs = shape.outputs.map((o) => ({ plurality: BigInt(plurality(o.spkLength, o.hasCovenant)), amount: o.value }));
  const bytes = serializedSize(shape);
  const compute = computeMass(shape);
  const transient = transientMass(shape);
  const normalizedTransient = Math.ceil(transient / 2);
  const storage = Number(storageMass(ins, outs));
  const max = Math.max(compute, normalizedTransient, storage);
  const binding = max === storage && storage >= normalizedTransient && storage >= compute ? 'storage' : max === normalizedTransient ? 'transient' : 'compute';
  return { bytes, compute, transient, normalizedTransient, storage, max, minFee: BigInt(max) * FEERATE_SOMPI_PER_GRAM, binding };
}

/** A feerate outside `[FEERATE_SOMPI_PER_GRAM, FEERATE_MAX_SOMPI_PER_GRAM]` reached a plan: the API's `GET /fees` answer is not used. */
export class FeerateOutOfRange extends Error {
  readonly feerate: bigint;
  readonly min: bigint = FEERATE_SOMPI_PER_GRAM;
  readonly max: bigint = FEERATE_MAX_SOMPI_PER_GRAM;
  constructor(feerate: bigint, where = 'feerate') {
    super(`${where}: ${feerate} sompi per gram is outside the accepted range ${FEERATE_SOMPI_PER_GRAM}..${FEERATE_MAX_SOMPI_PER_GRAM}`);
    this.name = 'FeerateOutOfRange';
    this.feerate = feerate;
  }
}

/** The floor applied, the cap enforced: the feerate a plan may carry, or `FeerateOutOfRange` above the cap. */
export function boundedFeerate(feerate: bigint, where = 'feerate'): bigint {
  if (feerate > FEERATE_MAX_SOMPI_PER_GRAM) throw new FeerateOutOfRange(feerate, where);
  return feerate < FEERATE_SOMPI_PER_GRAM ? FEERATE_SOMPI_PER_GRAM : feerate;
}

/** The feerate clamped into the accepted range, for displays and estimates that must not throw. */
export function clampFeerate(feerate: bigint): bigint {
  if (feerate > FEERATE_MAX_SOMPI_PER_GRAM) return FEERATE_MAX_SOMPI_PER_GRAM;
  return feerate < FEERATE_SOMPI_PER_GRAM ? FEERATE_SOMPI_PER_GRAM : feerate;
}

/** The most a transaction with model minimum fee `minFee` may pay: `max(50 * minFee, 1 KAS)`. */
export function feeCeiling(minFee: bigint): bigint {
  const byMultiple = FEE_CEILING_MULTIPLE * minFee;
  return byMultiple > FEE_CEILING_FLOOR ? byMultiple : FEE_CEILING_FLOOR;
}

/** The assembler's fee fixed point ended above `feeCeiling`: the plan is refused, nothing is built. */
export class FeeAboveCeiling extends Error {
  readonly fee: bigint;
  readonly ceiling: bigint;
  readonly minFee: bigint;
  constructor(tx: string, fee: bigint, minFee: bigint) {
    const ceiling = feeCeiling(minFee);
    super(`${tx}: fee ${fee} sompi is above the ceiling ${ceiling} (model minimum ${minFee}); refused so no surplus can become miner fee`);
    this.name = 'FeeAboveCeiling';
    this.fee = fee;
    this.ceiling = ceiling;
    this.minFee = minFee;
  }
}

/** Throws when a transaction can never be mined: any bucket above its block limit. */
export function assertMinable(m: Masses): void {
  if (m.storage > BLOCK_STORAGE_MASS_LIMIT) throw new Error(`storage mass ${m.storage} exceeds the block limit ${BLOCK_STORAGE_MASS_LIMIT}: an output is below its floor`);
  if (m.compute > BLOCK_COMPUTE_MASS_LIMIT) throw new Error(`compute mass ${m.compute} exceeds the block limit ${BLOCK_COMPUTE_MASS_LIMIT}`);
  if (m.transient > BLOCK_TRANSIENT_MASS_LIMIT) throw new Error(`transient mass ${m.transient} exceeds the block limit ${BLOCK_TRANSIENT_MASS_LIMIT}`);
}

/**
 * Compute budgets per input role, in units of 10,000 script units (100 grams):
 * measured minimum + 1. This is the base table of an earlier contract generation, which older recorded
 * transactions replay with; `BUDGETS_V1` and `BUDGETS_V1_COMPOSABLE` are the current tables (`budgetsFor`). The
 * token-program rows are shared.
 */
export const BUDGETS = Object.freeze({
  /** P2PK Schnorr funding or prep input (measured 10). */
  p2pk: 11,
  /** Reference token leader, covenant-owned, witness `00`, two outputs (buy / swap rest + user; measured 4). */
  tokenLeaderCovenant2Out: 5,
  /**
   * Reference token leader, covenant-owned, witness `00`, one output, with the empty supply cell as a delegator
   * (graduate reserve). The harness measured 2 units without the delegator; on testnet-10 a graduate needed 5
   * (`used=55072`).
   */
  tokenLeaderCovenant1Out: 6,
  /** Reference token leader, user-signed, one output (sell / swap merged; measured 15). */
  tokenLeaderSigned1Out: 16,
  /** Reference token leader, user-signed, two outputs (measured 14). */
  tokenLeaderSigned2Out: 15,
  /** Reference token leader, user-signed, three outputs (measured 16). */
  tokenLeaderSigned3Out: 17,
  /** Reference token leader, user-signed, 2 -> 1 merge (measured 15). */
  tokenLeaderSignedMerge2: 16,
  /** Reference token leader, user-signed, 3 -> 1 consolidation (measured 18). */
  tokenLeaderSignedMerge3: 19,
  /** Reference token leader, borrowed receive, witness `01` (measured 7). */
  tokenLeaderBorrow: 8,
  /** Reference token delegator, covenant-owned, empty witness (measured 3). */
  tokenDelegatorCovenant: 4,
  /** Reference token delegator, user-signed (measured 13). */
  tokenDelegatorSigned: 14,
  curveInit: 13,
  curveBuy: 16,
  curveSell: 15,
  curveSweep: 5,
  /**
   * `graduate` with the empty supply cell as the second T input: the harness measured 12 for the
   * one-input shape; testnet-10 needed 15 (`used=150546`), the second template read costing ≈ 2 units.
   */
  curveGraduate: 16,
  poolSwapKasForTokens: 14,
  poolSwapTokensForKas: 13,
  poolSweep: 3,
});

/** An input role with a budget row. */
export type BudgetRole = keyof typeof BUDGETS;

/**
 * Budgets of the earlier swap-only contract generation (50/50 split, 108-byte pool state), measured from the contract
 * harness (maximum over the positive cases) plus one unit. Token-program budgets are shared (same program).
 * Measured script units: init 130,810 (13); buy 156,145 (15); sell 143,084 (14); sweep 45,266 (4);
 * graduate with the empty supply cell 160,471 (16); swapKasForTokens 137,842 (13);
 * swapTokensForKas 125,133 (12); pool sweep 27,412 (2).
 */
export const BUDGETS_V2: Readonly<Record<BudgetRole, number>> = Object.freeze({
  ...BUDGETS,
  curveInit: 14,
  curveBuy: 16,
  curveSell: 15,
  curveSweep: 5,
  curveGraduate: 17,
  poolSwapKasForTokens: 14,
  poolSwapTokensForKas: 13,
  poolSweep: 3,
});

/** Pool entries that exist in the v1 pool only (the open-liquidity entries; the type keeps the name of the generation that introduced them). */
export type BudgetRoleV3 = 'poolBindLp' | 'poolAddLiquidity' | 'poolRemoveLiquidity';

/**
 * Budgets of the v1 contract set (open liquidity), measured maximum plus one unit. The v1 curve differs from the
 * earlier curve only in `graduate` (it writes the 139-byte pool state against the larger v1 pool template): `init`,
 * `buy`, `sell`, `sweep` keep the earlier budgets. Maximum script units measured over every case of the pool's test
 * harness (caps included): graduate 260,013 (26), swapKasForTokens 192,870 (19), swapTokensForKas 180,238 (18),
 * sweep 82,192 (8), bindLp 131,064 (13), addLiquidity 291,040 (29), removeLiquidity 291,254 (29). The token-program
 * rows are shared. The liquidity entries sit at the v1 ceiling (30); the builder's own transactions are re-measured
 * in a VM against these rows.
 */
export const BUDGETS_V1: Readonly<Record<BudgetRole | BudgetRoleV3, number>> = Object.freeze({
  ...BUDGETS_V2,
  curveGraduate: 27,
  poolSwapKasForTokens: 20,
  poolSwapTokensForKas: 19,
  poolSweep: 9,
  poolBindLp: 14,
  poolAddLiquidity: 30,
  poolRemoveLiquidity: 30,
});

/**
 * Budgets of `v1-kasseal-mainnet-2` and its testnet-10 build (the v1 pool with composable swaps, 15,197 B), the
 * measured maximum plus one unit over the pool's test harness (every preset) and the curve suites on that build:
 * graduate 282,262 (28), swapKasForTokens 220,701 (22; a buy reading two P2SH-owned extra T inputs, the canonical buy
 * 163,384), swapTokensForKas 220,745 (22; a sell reading two P2SH-owned extra T inputs, the canonical
 * sell 191,815), sweep 93,556 (9),
 * bindLp 142,394 (14), addLiquidity 302,405 (30), removeLiquidity 302,795 (30). The 1,617 more bytes of pool program
 * cost every pool entry about 10,000 units, and the graduate input (whose sigscript carries the pool program) the same.
 * The liquidity rows are one above the v1 ceiling (`BUDGET_CEILING_COMPOSABLE`).
 */
export const BUDGETS_V1_COMPOSABLE: Readonly<Record<BudgetRole | BudgetRoleV3, number>> = Object.freeze({
  ...BUDGETS_V1,
  curveGraduate: 29,
  poolSwapKasForTokens: 23,
  poolSwapTokensForKas: 23,
  poolSweep: 10,
  poolBindLp: 15,
  poolAddLiquidity: 31,
  poolRemoveLiquidity: 31,
});

/** Input roles of companion contracts that are not part of this SDK. */
export type BudgetRoleV1Companion = 'vaultBuy' | 'depositWithVault' | 'depositMerge' | 'splitterSplit' | 'splitterMerge';

/**
 * Budgets of the companion contracts' inputs (`BudgetRoleV1Companion`), measured maximum plus one. Not used by the
 * builders in this SDK.
 */
export const BUDGETS_V1_COMPANION: Readonly<Record<BudgetRoleV1Companion, number>> = Object.freeze({
  vaultBuy: 19,
  depositWithVault: 1,
  depositMerge: 1,
  splitterSplit: 1,
  splitterMerge: 1,
});

/** The budget table of a contract set: `BUDGETS_V1` for v1. */
export function budgetsFor(version: 'v1'): Readonly<Record<BudgetRole, number>> {
  if (version === 'v1') return BUDGETS_V1;
  throw new Error(`no budget table for contract version ${String(version)}`);
}

/** Highest budget the builder sets on a token-program input; a measured minimum above this means the template changed. */
export const BUDGET_CEILING = 20;
/** The v1 ceiling (named after the generation it was set for): the liquidity entries measure 29 units. */
export const BUDGET_CEILING_V3 = 30;

/**
 * The ceiling of the `v1-kasseal-mainnet-2` table: the liquidity entries measure 30 units there (one more than on
 * the earlier v1 builds, the larger program), so the maximum-plus-one rows are 31. A budget unit is 100 grams of mass:
 * 0.0001 KAS at 100 sompi per gram.
 */
export const BUDGET_CEILING_COMPOSABLE = 31;

/** The budget ceiling of a contract set (v1: `BUDGET_CEILING_V3`). */
export function budgetCeilingFor(version: 'v1'): number {
  if (version === 'v1') return BUDGET_CEILING_V3;
  throw new Error(`no budget ceiling for contract version ${String(version)}`);
}

/** Budget for a user-signed leader by its continuation count (1..3 outputs, or a merge of `inputs` cells into one). */
export function signedLeaderBudget(tokenInputs: number, tokenOutputs: number): number {
  if (tokenOutputs === 1 && tokenInputs === 3) return BUDGETS.tokenLeaderSignedMerge3;
  if (tokenOutputs === 1 && tokenInputs === 2) return BUDGETS.tokenLeaderSignedMerge2;
  if (tokenOutputs === 1) return BUDGETS.tokenLeaderSigned1Out;
  if (tokenOutputs === 2) return BUDGETS.tokenLeaderSigned2Out;
  if (tokenOutputs === 3) return BUDGETS.tokenLeaderSigned3Out;
  throw new Error(`no budget for a signed leader with ${tokenOutputs} outputs`);
}

/** The budget implied by a node `script units exceeded ... used=N` message: the smallest budget whose limit covers `used`. */
export function budgetCovering(usedScriptUnits: number): number {
  return Math.ceil(Math.max(0, usedScriptUnits - 9999) / 10000);
}

/** `limit = budget * 10000 + 9999` identifies the input a budget rejection refers to. */
export function budgetFromLimit(limit: number): number | undefined {
  return (limit - 9999) % 10000 === 0 ? (limit - 9999) / 10000 : undefined;
}

/* -------------------------------------------------------------------------- */
/* Batch orders (companion contracts, not part of this SDK)                    */
/* -------------------------------------------------------------------------- */

/**
 * Budgets of the batch-order inputs (measured in the batch contract's harness), minimum + 1:
 * `Order.fill` 1,081 script units (0), `cancel` and `refundExpired` below 2,000 (0); the pot's token leader under the
 * 0x03 owner with the key as authority input (`00 01`), 2 or 3 outputs: 62,912 script units (6) at most, so 7, set to
 * 8 for the two-output and three-output shapes alike. `Dist.split` and `BatchBuy.fill` grow with their size:
 * `distSplitBudget`, `batchBuyBudget`.
 */
export const BUDGETS_BATCH = Object.freeze({
  orderFill: 1,
  orderCancel: 1,
  orderRefund: 1,
  potLeader: 8,
});

/**
 * The BatchBuy ceiling: 30. With the start bound and the delivery fee the cap-31 build measures at most 293,684 script
 * units (29) at 31 orders and the builder's bound gives it 30; 32 orders measure up to 299,845, which leaves the bound no margin
 * under 30, so the large build takes 31. Every other batch input stays within `BUDGET_CEILING`.
 */
export const BUDGET_CEILING_BATCH = 30;

/**
 * BatchBuy script units, bounded from above (harness measurements over every preset, the curve's start and end,
 * every order with a separate refund and 8-byte limits and values; worst cases
 * cap 8 at m = 1, 2, 8: 109,837 / 122,204 / 152,030; cap 31 at m = 9, 30, 31: 184,191 / 288,705 / 293,684): about
 * 4,975 per order over a fixed part, plus the pot, key and root hash from two orders on. The bound adds 5,000 per order
 * and a margin of at least 3,000 over every measurement (the harness asserts it against its own copy).
 */
export function batchBuyScriptUnitsBound(cap: 8 | 31, m: number): number {
  if (!Number.isInteger(m) || m < 1 || m > cap) throw new RangeError(`BatchBuy cap ${cap} takes 1..${cap} orders, not ${m}`);
  return (cap === 8 ? 108_000 : 135_000) + 5_000 * m + (m >= 2 ? 7_500 : 0);
}

/** The BatchBuy input's budget for a fill of m orders with the cap-`cap` build; refused above `BUDGET_CEILING_BATCH`. */
export function batchBuyBudget(cap: 8 | 31, m: number): number {
  const b = budgetCovering(batchBuyScriptUnitsBound(cap, m)) + 1;
  if (b > BUDGET_CEILING_BATCH) throw new Error(`BatchBuy budget ${b} at m = ${m} is above the ceiling ${BUDGET_CEILING_BATCH}`);
  return b;
}

/**
 * Dist.split script units, bounded from above. A split validates each part's token output and hashes the revealed
 * leaves (the node check) and each child node's leaves again (its key script). Measured through the builder's own
 * splits: n = 2 (two leaves) 85,351; n = 3 (three leaves) 104,060; n = 4 (a child and a
 * leaf) 96,933; n = 5 (a child, two leaves) 115,643; n = 9, 10, 11 (three children) 138,804 / 139,991 / 141,180;
 * n = 32 (three children) 166,171. The bound is 52,000 + 19,000 per leaf part + 30,000 per child node + 1,000 per
 * leaf: at least 7,000 above every measurement.
 */
export function distSplitScriptUnitsBound(n: number): number {
  if (!Number.isInteger(n) || n < 2 || n > 64) throw new RangeError(`a node holds 2..64 leaves, not ${n}`);
  // Dist's split rule (batch.ts splitParts): a = ceil(n / 3) rounded up to odd, b = ceil((n - a) / 2) rounded up to odd.
  let a = Math.floor((n + 2) / 3);
  a = a + 1 - (a % 2);
  let b = Math.floor((n - a + 1) / 2);
  b = b + 1 - (b % 2);
  const parts = [a, b, n - a - b].filter((x) => x > 0);
  const children = parts.filter((x) => x > 1).length;
  return 52_000 + 19_000 * (parts.length - children) + 30_000 * children + 1_000 * n;
}

/** The key input's budget for a split of a node of n leaves; refused above `BUDGET_CEILING`. */
export function distSplitBudget(n: number): number {
  const b = budgetCovering(distSplitScriptUnitsBound(n)) + 1;
  if (b > BUDGET_CEILING) throw new Error(`Dist budget ${b} at n = ${n} is above the ceiling ${BUDGET_CEILING}`);
  return b;
}
