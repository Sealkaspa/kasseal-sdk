/**
 * Shared plan fragments: covenant-cell inputs with their sigscripts and
 * budgets, predicted cell outputs with their programs and bindings, and the
 * builder context (the three templates plus the network).
 *
 * Every token output goes through `assertNotSelfOwned` (the self-owned
 * footgun: `owner_scheme 0x04 && owner == own covenant id` is
 * anyone-can-spend) and user outputs are refused above scheme 0x03.
 */

import type { PlatformRounding, PoolLimits } from '@kasseal/curve-math';
import { assertNotSelfOwned, fromHex, toHex, type TokenState } from '@kasseal/codec';
import { p2shScript } from './blake2b.ts';
import { type FundingUtxo, type InputPlan, type OutputPlan, type PredictedCell, type ResidualOutput, type SignatureSlot, type TokenCell, type CurveCell, type PoolCell, fundingInput } from './assemble.ts';
import { BUDGETS, BUDGETS_V1, BUDGETS_V1_COMPOSABLE, budgetsFor, type BudgetRole, type BudgetRoleV3 } from './mass.ts';
import { DEFAULT_CONTRACT_SET, type BuilderContractSet, type ContractSet } from './artifacts.ts';
import {
  OWNER_SCHEME_COVENANT_ID, curveProgram, poolProgram, tokenProgram, type CurveState, type CurveTemplate, type PoolCellState, type PoolTemplate, type TokenTemplate,
  loadCurveTemplate, loadPoolTemplate, loadTokenTemplate, isComposablePool,
} from './program.ts';
import {
  P2PK_PLACEHOLDER_SIGSCRIPT, tokenDelegatorCovenantSigScript, tokenDelegatorSignedSigScript, tokenLeaderCovenantSigScript, tokenLeaderSignedSigScript, type LeaderSigScript,
} from './sigscript.ts';
import { NETWORK_ID } from './sdk.ts';

/** The templates one build works with: a curve preset, its pool, the reference token, and the network. */
export interface BuilderContext {
  /** The curve template (one preset). */
  readonly curve: CurveTemplate;
  /** The pool template the curve graduates into. */
  readonly pool: PoolTemplate;
  /** The reference token template. */
  readonly token: TokenTemplate;
  /** `mainnet` or `testnet-10`. */
  readonly networkId: string;
}

/**
 * Load the committed artifacts for a curve preset of a contract set: v1 (the
 * default, every launch; a frozen v1 revision with `revision`). The context's
 * curve and pool belong to the same set and revision.
 */
export function createContext(preset: string, networkId: string = NETWORK_ID, version: ContractSet = DEFAULT_CONTRACT_SET, revision?: string): BuilderContext {
  const pool = loadPoolTemplate(version, revision);
  const curve = loadCurveTemplate(preset, pool);
  return { curve, pool, token: loadTokenTemplate(), networkId };
}

/** The contract set of a context (its curve and pool always agree). */
export function contextSet(ctx: BuilderContext): BuilderContractSet {
  if (ctx.curve.version !== ctx.pool.version) throw new Error(`context mixes a ${ctx.curve.version} curve with a ${ctx.pool.version} pool`);
  return ctx.curve.version;
}

/** The fee model of a contract set (`@kasseal/codec`): v1 pays 50/50. */
export { feeModelOf } from '@kasseal/codec';

/** The budget table of a context's contract set. */
export function budgetsOf(ctx: BuilderContext): Readonly<Record<BudgetRole, number>> {
  const version = contextSet(ctx);
  return version === 'v1' && isComposablePool(ctx.pool) ? BUDGETS_V1_COMPOSABLE : budgetsFor(version);
}

/**
 * The arithmetic a context's pool program follows (curve-math `PoolLimits`): `'uncapped'` for v1 (no price ceiling:
 * KAS_VALUE_MAX on the cell value, KAS_IN_MAX on a buy, exact products).
 */
export function poolLimitsOf(ctx: BuilderContext): PoolLimits {
  contextSet(ctx);
  return 'uncapped';
}

/**
 * How a context's pool program rounds the platform share of a swap (curve-math `PlatformRounding`): the current v1
 * builds (`V1_NEAREST_ROUNDING_REVISIONS`) to the nearest 0.01 KAS unit; earlier revisions down. The builder writes the successor state the program recomputes, so it must match.
 */
export function poolRoundingOf(ctx: BuilderContext): PlatformRounding {
  return poolTemplateRounding(ctx.pool);
}

/**
 * Frozen v1 revisions whose pool rounds the platform share to the nearest unit, including `v1-kasseal-mainnet-2` and
 * its testnet-10 build.
 */
export const V1_NEAREST_ROUNDING_REVISIONS: readonly string[] = Object.freeze(['v1-2026-10-18-final', 'v1-kasseal-mainnet-tn10', 'v1-kasseal-mainnet', 'v1-kasseal-mainnet-2-tn10', 'v1-kasseal-mainnet-2']);

/** How a pool template rounds the platform share: nearest for the current v1 build and `V1_NEAREST_ROUNDING_REVISIONS`, floor otherwise. */
export function poolTemplateRounding(pool: Pick<PoolTemplate, 'version' | 'revision'>): PlatformRounding {
  return pool.version === 'v1' && (pool.revision === undefined || V1_NEAREST_ROUNDING_REVISIONS.includes(pool.revision)) ? 'nearest' : 'floor';
}

/** The open-liquidity budget table (v1), including the entries only that pool has; refuses any other context. */
export function budgetsV3Of(ctx: BuilderContext): Readonly<Record<BudgetRole | BudgetRoleV3, number>> {
  const version = contextSet(ctx);
  if (version === 'v1') return isComposablePool(ctx.pool) ? BUDGETS_V1_COMPOSABLE : BUDGETS_V1;
  throw new Error(`a ${version} context has no bindLp / addLiquidity / removeLiquidity budgets`);
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

function cellInput(cell: TokenCell | CurveCell | PoolCell, label: string, budget: number, sigscript: Uint8Array, signature: SignatureSlot | undefined): InputPlan {
  return { label, outpoint: cell.outpoint, amount: cell.value, spk: p2shScript(cell.program), daaScore: cell.daaScore, covenantId: cell.covenantId, budget, sigscript, signature, cellKind: cell.kind };
}

/** Token leader owned by a covenant (curve or pool): witness `00`, no signature. */
export function tokenLeaderCovenantInput(cell: TokenCell, nextStates: readonly TokenState[], label: string, budget: number): InputPlan {
  const s = tokenLeaderCovenantSigScript(cell.program, nextStates);
  return cellInput(cell, label, budget, s.bytes, undefined);
}

/** Token leader the user signs (`00 || sig65`). */
export function tokenLeaderSignedInput(cell: TokenCell, nextStates: readonly TokenState[], label: string, budget: number): InputPlan {
  const s = tokenLeaderSignedSigScript(cell.program, nextStates);
  return cellInput(cell, label, budget, s.bytes, slotOf(s, 'token-leader', cell));
}

/** Token delegator owned by a covenant: empty witness, authorized by the covenant's presence. */
export function tokenDelegatorCovenantInput(cell: TokenCell, label: string, budget: number = BUDGETS.tokenDelegatorCovenant): InputPlan {
  return cellInput(cell, label, budget, tokenDelegatorCovenantSigScript(cell.program).bytes, undefined);
}

/** Token delegator the user signs (`sig65`). */
export function tokenDelegatorSignedInput(cell: TokenCell, label: string, budget: number = BUDGETS.tokenDelegatorSigned): InputPlan {
  const s = tokenDelegatorSignedSigScript(cell.program);
  return cellInput(cell, label, budget, s.bytes, slotOf(s, 'token-delegator', cell));
}

function slotOf(s: LeaderSigScript, kind: SignatureSlot['kind'], cell: TokenCell): SignatureSlot {
  if (s.signatureOffset === undefined) throw new Error('sigscript has no signature slot');
  return { kind, offset: s.signatureOffset, signer: toHex(cell.state.owner.identifier), sighashType: 1 };
}

/** The curve as an input, with its entry's sigscript. */
export function curveInput(cell: CurveCell, label: string, budget: number, sigscript: Uint8Array): InputPlan {
  return cellInput(cell, label, budget, sigscript, undefined);
}

/** The pool as an input, with its entry's sigscript. */
export function poolInput(cell: PoolCell, label: string, budget: number, sigscript: Uint8Array): InputPlan {
  return cellInput(cell, label, budget, sigscript, undefined);
}

/** A P2PK funding input (signed by the wallet). */
export function kasInput(utxo: FundingUtxo, label = 'funding (P2PK)'): InputPlan {
  return fundingInput(utxo, label, BUDGETS.p2pk, P2PK_PLACEHOLDER_SIGSCRIPT);
}

/* -------------------------------------------------------------------------- */
/* Outputs                                                                     */
/* -------------------------------------------------------------------------- */

/** A token cell output. `lineage` is T (known) and `authorizingInput` the T leader's index; `undefined` binding marks a genesis output. */
export function tokenOutput(ctx: BuilderContext, label: string, state: TokenState, value: bigint, lineage: string | undefined, authorizingInput: number | undefined): OutputPlan {
  if (lineage !== undefined) assertNotSelfOwned(state, fromHex(lineage), label);
  if (state.owner.schemeByte === OWNER_SCHEME_COVENANT_ID && lineage !== undefined && toHex(state.owner.identifier) === lineage) throw new Error(`${label}: self-owned token output`);
  const program = tokenProgram(ctx.token, state);
  const cell: PredictedCell = { predicted: { kind: 'token', state }, program, covenantId: lineage };
  return { label, value, spk: p2shScript(program), binding: lineage !== undefined && authorizingInput !== undefined ? { authorizingInput, covenantId: lineage } : undefined, cell };
}

/** A curve cell output; an `undefined` binding marks a genesis output. */
export function curveOutput(ctx: BuilderContext, label: string, state: CurveState, value: bigint, lineage: string | undefined, authorizingInput: number | undefined): OutputPlan {
  const program = curveProgram(ctx.curve, state);
  const cell: PredictedCell = { predicted: { kind: 'curve', state }, program, covenantId: lineage };
  return { label, value, spk: p2shScript(program), binding: lineage !== undefined && authorizingInput !== undefined ? { authorizingInput, covenantId: lineage } : undefined, cell };
}

/** A pool cell output; an `undefined` binding marks a genesis output. */
export function poolOutput(ctx: BuilderContext, label: string, state: PoolCellState, value: bigint, lineage: string | undefined, authorizingInput: number | undefined): OutputPlan {
  const program = poolProgram(ctx.pool, state);
  const cell: PredictedCell = { predicted: { kind: 'pool', state }, program, covenantId: lineage };
  return { label, value, spk: p2shScript(program), binding: lineage !== undefined && authorizingInput !== undefined ? { authorizingInput, covenantId: lineage } : undefined, cell };
}

/** A plain output with no covenant binding. */
export function plainOutput(label: string, value: bigint, spk: Uint8Array): OutputPlan {
  return { label, value, spk, binding: undefined, cell: undefined };
}

/** Change back to a P2PK script; dropped into the fee below `MIN_CHANGE`. */
export function changeTo(spk: Uint8Array, label = 'change', dropBelow: bigint = 10_000_000n): ResidualOutput {
  return { label, spk, binding: undefined, cell: undefined, minimum: 0n, dropBelow };
}

/** A required P2PK payout: the residual of the inputs after the fixed outputs and the fee; refused below `minimum`. */
export function payoutTo(spk: Uint8Array, label = 'payout', minimum: bigint = 10_000_000n): ResidualOutput {
  return { label, spk, binding: undefined, cell: undefined, minimum, dropBelow: undefined };
}

/** A token cell as the residual output (its value is whatever the inputs leave; consolidation). */
export function tokenResidual(ctx: BuilderContext, label: string, state: TokenState, lineage: string, authorizingInput: number, minimum: bigint): ResidualOutput {
  assertNotSelfOwned(state, fromHex(lineage), label);
  const program = tokenProgram(ctx.token, state);
  return { label, spk: p2shScript(program), binding: { authorizingInput, covenantId: lineage }, cell: { predicted: { kind: 'token', state }, program, covenantId: lineage }, minimum, dropBelow: undefined };
}
