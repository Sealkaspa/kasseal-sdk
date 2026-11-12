/**
 * The token-lock transactions (`packages/contracts/lock/v1`, README "Creation flow" and "Entries"; `lock.ts` for the
 * state, the arithmetic and the app rules). Every shape is exactly the one the VM harness accepts:
 *
 * prep (the creator signs):
 *   in   creator's KAS (P2PK)
 *   out0 P2SH(LockFactory(LOCK_H, creatorSpk)), a small value (`LOCK_FACTORY_CELL_KAS`)
 *   out1 change (always: the indexer finds a prep by it; a prep that would drop it is refused)
 *
 * create (the creator signs the T cells and the KAS; the factory input carries no signature):
 *   in0  factory create(T, beneficiary, scheme, total, start, cliff, period, N, restAmount, creatorIdx, prefix, suffix)
 *   in1  the creator's T leader (signs)           transfer([locked, rest?], 00 || sig)
 *   in2.. up to 2 more T cells (delegators, sign)
 *   then the creator's KAS (P2PK, SIGHASH_ALL): input creatorIdx pays exactly creatorSpk
 *   out0 lock P2SH(Lock(state)), genesis (in0, [0]) => K, value == N * 1.2 KAS + 1 KAS
 *   out1 the lock's T cell {total, K, 0x04, 0, 0^32, ext} bound (1, T), value >= 1 KAS
 *   [out2 the creator's rest: the leader's own state with restAmount, bound (1, T)]
 *   change to the creator
 *
 * claim (anyone; no signature; lockTime = `now`, a timestamp below the past median time; sequence 0):
 *   in0  lock K claim()                            in1 the lock's T cell (T leader, witness 00)
 *   non-final: out0 K continuation {.., claimed: vested} value == lock - 1 KAS - fee, bound (0, K)
 *              out1 rest {ctx, total - amountAt(vested), K, 0x04, 0, 0^32, ext} value == T cell, bound (1, T)
 *              out2 payout {ctx, amountAt(vested) - amountAt(claimed), beneficiary, scheme, 0, 0^32, ext} 1 KAS, (1, T)
 *   final:     out0 payout (1 KAS, (1, T)); out1 the beneficiary's own script, unbound, lock + T cell - 1 KAS - fee
 *   fee: the model's minimum at the chosen feerate, never above FEE_CAP (0.2 KAS); nothing else in or out.
 *
 * extend (the beneficiary signs, SIGHASH_ALL; a P2SH beneficiary's authority input SIGHASH_ALL too):
 *   in0  lock K extend(start', cliff', period', witness)    witness: sig65 (P2PK) or the authority input's index (P2SH)
 *   in1  the lock's T cell (T leader, witness 00), carried through unchanged
 *   [in2 the authority input P2SH(beneficiary script)]     then the beneficiary's KAS (fee)
 *   out0 K continuation {.., start', cliff', period'} value == lock, bound (0, K)
 *   out1 the T cell, same state and value, bound (1, T)     change
 *
 * Each builder ends with its own pre-sign check (`checkLockCreateTx`, `checkLockClaimTx`, `checkLockExtendTx`), which
 * re-derives every pinned figure from the serialised transaction alone and refuses any other shape: exact outputs, no
 * other covenant output, the deposit, a P2PK or P2SH beneficiary, nothing sent to K but the lock's own T cell, and the
 * app limits (0.05 % of supply, 7 days to 2 years, at most 100 releases). A claimer can run the claim check again on
 * the exact bytes it broadcasts.
 */

import {
  REFERENCE_KCC0020_TEMPLATE_HASH, assertNotSelfOwned, bytesEqual, concat, decodeInvocation, decodeScriptNum, fromHex, kcc0020Fields, makeKcc0020State, parseSigScriptEnvelope, toHex,
  type TokenState,
} from '@kasseal/codec';
import { ResidualBelowMinimum, assemble, estimate, p2pkScript, type FundingUtxo, type InputPlan, type OutputPlan, type TokenCell, type TxPlan } from '../assemble.ts';
import { isXOnlyPubkey } from '../bip340.ts';
import { covenantIdKip20, p2shScript } from '../blake2b.ts';
import { kasInput, tokenDelegatorSignedInput, tokenLeaderCovenantInput, tokenLeaderSignedInput } from '../cells.ts';
import { feeFromBytes, feeOutsideModel } from '../fee-bytes.ts';
import { toBuiltTx } from '../finalize.ts';
import {
  LOCK_FEE_CAP, LOCK_MAX_CREATE_OUTPUTS, LOCK_PAYOUT_CELL_KAS, LOCK_SCHEME_P2PK, LOCK_SCHEME_P2SH, LOCK_TIME_THRESHOLD, LOCK_T_CELL_KAS_MIN, assertLockAppRules,
  assertLockState, lockAmountAt, lockCellOf, lockClaimableAt, lockDeposit, lockEndOf, lockFactoryCreatorOf, lockFactoryProgram, lockGenesisState,
  lockNextUnlock, lockPayeeScript, lockProgram, lockStateProblem, lockTokenCellProblem, type LockCell, type LockState, type LockTerms, type LockV1Set,
} from '../lock.ts';
import { BUDGETS_LOCK_V1, FEERATE_SOMPI_PER_GRAM } from '../mass.ts';
import { BORROW_SCHEME_DISABLED, ZERO32, covenantOwnedToken, defaultRegistry, isP2pkSpk36, scriptHashOf, tokenProgram } from '../program.ts';
import { assertFloors } from '../select/floors.ts';
import { ZERO_SIG65, pushByte, pushInt, pushMinimal } from '../sigscript.ts';
import { noArgSigScript } from '../txscript.ts';
import type { BuiltTx, OutputRole } from '../types.ts';
import { addressOfScript, decodeAddress } from '../wallet/address.ts';
import { WITNESS_COVENANT, WITNESS_SIGNED, checkTokenFamily, deltaOf, type Shaped } from './common.ts';
import { assertSafeRedeem, keyOfLockedRedeem } from './swap.ts';

/* -------------------------------------------------------------------------- */
/* Refusals                                                                    */
/* -------------------------------------------------------------------------- */

/** A lock transaction would break a rule its covenant pins or an app rule; nothing is built (or, from a check, signed or sent). */
export class LockRefused extends Error {
  readonly rule: string;
  constructor(rule: string, detail: string) {
    super(`lock ${rule}: ${detail}`);
    this.name = 'LockRefused';
    this.rule = rule;
  }
}

/** Nothing is claimable at `now`: the next tranche is due at `nextAt` (a claim with a future lockTime is rejected, not held). */
export class LockClaimNotDue extends LockRefused {
  readonly now: bigint;
  readonly nextAt: bigint;
  constructor(now: bigint, nextAt: bigint) {
    super('not-due', `nothing is claimable at ${now}; the next tranche is due at ${nextAt}`);
    this.name = 'LockClaimNotDue';
    this.now = now;
    this.nextAt = nextAt;
  }
}

function refuse(rule: string, detail: string): never {
  throw new LockRefused(rule, detail);
}

/** Fee knobs of the lock shapes (no priority fee: a claim's fee comes from the lock and is capped). */
export interface LockFeeOptions {
  /** Sompi per gram (default and minimum 100; refused above `FEERATE_MAX_SOMPI_PER_GRAM`). */
  readonly feerate?: bigint;
  /** Sompi on top of the model's minimum fee. */
  readonly feeMargin?: bigint;
}

function feeFieldsOf(o: LockFeeOptions): Pick<TxPlan, 'feeMargin' | 'feerate'> {
  return o.feerate === undefined ? { feeMargin: o.feeMargin ?? 0n } : { feeMargin: o.feeMargin ?? 0n, feerate: o.feerate };
}

/** The app rules' `minDurationMs`, when given. */
function minDurationOf(o: { readonly minDurationMs?: bigint }): { minDurationMs?: bigint } {
  return o.minDurationMs === undefined ? {} : { minDurationMs: o.minDurationMs };
}

/** The factory cell's default value (0.2 KAS): a prep storage mass of about 50,000 g, returned to the creator by `create`. */
export const LOCK_FACTORY_CELL_KAS = 20_000_000n;
/** Factory cells below this would weigh 100,000 g or more of storage in the prep (the standard limit). */
export const LOCK_FACTORY_CELL_MIN = 10_000_001n;
/** Factory cells above this are refused: the cell carries nothing the creation needs (the contract README: keep it minimal). */
export const LOCK_FACTORY_CELL_MAX = 100_000_000n;

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                               */
/* -------------------------------------------------------------------------- */

/** A reference token output (`cells.ts` tokenOutput over the lock set's token template). */
function tokenOut(set: LockV1Set, label: string, state: TokenState, value: bigint, lineage: string, authorizingInput: number): OutputPlan {
  assertNotSelfOwned(state, fromHex(lineage), label);
  const program = tokenProgram(set.token, state);
  return { label, value, spk: p2shScript(program), binding: { authorizingInput, covenantId: lineage }, cell: { predicted: { kind: 'token', state }, program, covenantId: lineage } };
}

/** The KCC-20 state of a payout: the claimed tokens, owned by the beneficiary under its scheme, borrowing disabled. */
export function lockPayoutState(s: LockState, amount: bigint, ext: Uint8Array): TokenState {
  return makeKcc0020State({ amount, owner: s.beneficiary, ownerScheme: s.scheme, borrowScheme: BORROW_SCHEME_DISABLED, borrowGuard: ZERO32, extensionCommitment: ext });
}

/** The K-owned T cell state: `{amount, K, 0x04, 0, 0^32, ext}` (the lock's cell, and a claim's rest). */
export function lockCellTokenState(amount: bigint, k: string, ext: Uint8Array): TokenState {
  return covenantOwnedToken(amount, k, ext);
}

function lockInputOf(lock: LockCell, label: string, budget: number, sigscript: Uint8Array, signature: InputPlan['signature']): InputPlan {
  return { label, outpoint: lock.outpoint, amount: lock.value, spk: p2shScript(lock.program), daaScore: lock.daaScore, covenantId: lock.covenantId, budget, sigscript, signature, cellKind: 'lock', sequence: 0n };
}

/** The change output: P2PK, unbound, dropped below 0.1 KAS. */
function changeTo(spk: Uint8Array): NonNullable<TxPlan['residual']> {
  return { label: 'change', spk, binding: undefined, cell: undefined, minimum: 0n, dropBelow: 10_000_000n };
}

/** `toBuiltTx`'s `produces`: each output's role, by index. */
function producesOf(roles: readonly OutputRole[]): { index: number; role: OutputRole }[] {
  return roles.map((role, index) => ({ index, role }));
}

const outpointKey = (o: { readonly txid: string; readonly index: number }): string => `${o.txid}:${o.index}`;

/** The compute budgets of a creation's factory and leader inputs (the same table for the build and its check). */
function createBudgetsOf(delegated: boolean, rest: boolean): { factory: number; leader: number } {
  const b = BUDGETS_LOCK_V1;
  return { factory: rest ? b.factoryCreateRest : b.factoryCreate, leader: delegated ? b.leaderCreateDelegated : rest ? b.leaderCreate2Out : b.leaderCreate1Out };
}

function requireLiveLock(set: LockV1Set, lock: LockCell, tCell: TokenCell): void {
  // Re-derive the lock cell from its program (template, K, well-formed state).
  try {
    lockCellOf(set, { ...lock, state: lock.state });
  } catch (e) {
    refuse('lock', (e as Error).message);
  }
  const p = lockTokenCellProblem(lock, tCell);
  if (p !== undefined) refuse('lock-cell', p);
  if (tCell.program.length !== set.token.bytecode.length || !bytesEqual(tokenProgram(set.token, tCell.state), tCell.program)) refuse('lock-cell', 'the T cell\'s program is not the reference token with its state');
}

/** Plain funding: P2PK, unbound. */
function requireFunding(funding: readonly FundingUtxo[], what: string, spk?: Uint8Array): void {
  for (const u of funding) {
    const at = outpointKey(u.outpoint);
    if (!isP2pkScript(u.spk)) refuse('funding', `${what} ${at} is not a Schnorr P2PK output`);
    if (spk !== undefined && !bytesEqual(u.spk, spk)) refuse('funding', `${what} ${at} does not pay the creator's script`);
  }
}

/* -------------------------------------------------------------------------- */
/* prep                                                                        */
/* -------------------------------------------------------------------------- */

export interface LockPrepParams extends LockFeeOptions {
  readonly set: LockV1Set;
  /** The creator's P2PK address (Schnorr): the factory binds the creation to an input paying exactly this script. */
  readonly creator: string;
  /** The creator's KAS. */
  readonly funding: readonly FundingUtxo[];
  /** The factory cell's value (default `LOCK_FACTORY_CELL_KAS`). */
  readonly factoryValue?: bigint;
  /**
   * Factory cells to fund (default 1, at most `LOCK_PREP_FACTORIES_MAX`): one per lock of a "custom dates" flow,
   * each its own creation (a create spends exactly one factory cell). Outputs 0..count-1.
   */
  readonly count?: number;
}

/** The most factory cells one prep funds: a "custom dates" flow makes at most this many locks. */
export const LOCK_PREP_FACTORIES_MAX = 10;
/**
 * A factory cell's default value when one prep funds several: 0.5 KAS. Small outputs weigh on the storage mass (KIP-9):
 * ten 0.2 KAS cells pass the 500,000 block limit, ten of 0.5 KAS weigh 200,000. Not a cost: each creation spends its
 * factory cell and returns what the lock does not need as change.
 */
export const LOCK_FACTORY_CELL_KAS_MULTI = 50_000_000n;

export interface LockPrepResult extends Shaped {
  /** `version(2) || P2PK script(34)` of the creator: the factory's `creatorSpk`. */
  readonly creatorSpk: Uint8Array;
  /** `LockFactory(LOCK_H, creatorSpk)`. */
  readonly factoryProgram: Uint8Array;
  /** The factory cell this transaction creates (output 0), for `buildLockCreate`. */
  readonly factory: { readonly outpoint: { readonly txid: string; readonly index: number }; readonly value: bigint };
  /** Every factory cell it creates (outputs 0..count-1); `factory` is the first. */
  readonly factories: readonly { readonly outpoint: { readonly txid: string; readonly index: number }; readonly value: bigint }[];
  readonly tx: BuiltTx;
}

/** The factory cell for the creator's address: the creator's 36-byte script and the factory program. */
export function lockFactoryOf(set: LockV1Set, creator: string): { creatorSpk: Uint8Array; program: Uint8Array; script: Uint8Array } {
  const script = p2pkScript(creator);
  const creatorSpk = concat(Uint8Array.of(0, 0), script);
  if (!isP2pkSpk36(creatorSpk)) refuse('creator', 'the creator address is not a Schnorr P2PK address');
  const program = lockFactoryProgram(set, creatorSpk);
  return { creatorSpk, program, script: p2shScript(program) };
}

/** The address of the creator's factory cells (P2SH), on the creator address's own network. */
export function lockFactoryAddressOf(set: LockV1Set, creator: string): string {
  const f = lockFactoryOf(set, creator);
  const a = addressOfScript(f.script, decodeAddress(creator).prefix);
  if (a === undefined) refuse('creator', 'the factory script has no address form');
  return a;
}

/** A factory cell left unspent at the creator's factory address: a create may spend it in place of a new prep's. */
export interface LockFactoryCell {
  readonly outpoint: { readonly txid: string; readonly index: number };
  readonly value: bigint;
  readonly daaScore: bigint;
}

/**
 * The creator's own factory cells among the factory address's UTXOs: cells a prep funded
 * whose create never came (a refused or dropped create, a custom-dates flow stopped part way). The factory has no
 * refund entry, but its `create` entry takes any cell at the creator's factory address: the creator's
 * signed T cells and a P2PK input paying exactly `creatorSpk` must come with it, so only the creator can spend one, and
 * the cell's KAS returns as the create's change. Kept: version-0 scripts equal to this creator's factory script, not
 * coinbase, holding `LOCK_FACTORY_CELL_MIN..MAX` (what `buildLockCreate` accepts); largest first, then by outpoint.
 */
export function lockFactoryCellsOf(
  set: LockV1Set, creator: string,
  utxos: readonly { readonly outpoint: { readonly txid: string; readonly index: number }; readonly amount: bigint; readonly script: Uint8Array; readonly scriptVersion?: number; readonly isCoinbase?: boolean; readonly daaScore: bigint }[],
): LockFactoryCell[] {
  const f = lockFactoryOf(set, creator);
  return utxos
    .filter((u) => (u.scriptVersion ?? 0) === 0 && u.isCoinbase !== true && bytesEqual(u.script, f.script) && u.amount >= LOCK_FACTORY_CELL_MIN && u.amount <= LOCK_FACTORY_CELL_MAX)
    .map((u) => ({ outpoint: { txid: u.outpoint.txid.toLowerCase(), index: u.outpoint.index }, value: u.amount, daaScore: u.daaScore }))
    .sort((a, b) => (a.value !== b.value ? (a.value > b.value ? -1 : 1) : a.outpoint.txid !== b.outpoint.txid ? (a.outpoint.txid < b.outpoint.txid ? -1 : 1) : a.outpoint.index - b.outpoint.index));
}

/**
 * Fund the creator's factory cell (P2SH(LockFactory(LOCK_H, creatorSpk))) with a small value, or `count` of them (one
 * per lock of a custom-dates flow, all at the same factory address); change to the creator, last.
 */
export function buildLockPrep(params: LockPrepParams): LockPrepResult {
  const { set, creator, funding } = params;
  const count = params.count ?? 1;
  const value = params.factoryValue ?? (count > 1 ? LOCK_FACTORY_CELL_KAS_MULTI : LOCK_FACTORY_CELL_KAS);
  if (!Number.isInteger(count) || count < 1 || count > LOCK_PREP_FACTORIES_MAX) refuse('factory', `${count} factory cells, 1 to ${LOCK_PREP_FACTORIES_MAX}`);
  if (value < LOCK_FACTORY_CELL_MIN || value > LOCK_FACTORY_CELL_MAX) refuse('factory', `a factory cell of ${value} sompi is outside ${LOCK_FACTORY_CELL_MIN}..${LOCK_FACTORY_CELL_MAX}`);
  if (funding.length === 0) refuse('funding', 'the prep needs the creator\'s KAS');
  const f = lockFactoryOf(set, creator);
  requireFunding(funding, 'funding');
  const plan: TxPlan = {
    name: 'lock prep',
    inputs: funding.map((u) => kasInput(u, 'creator KAS (P2PK)')),
    outputs: Array.from({ length: count }, () => ({ label: 'lock factory (P2SH)', value, spk: f.script, binding: undefined, cell: undefined })),
    residual: changeTo(p2pkScript(creator)),
    genesisGroups: [],
    payload: new Uint8Array(0),
    ...feeFieldsOf(params),
  };
  const built = assemble(plan);
  assertFloors(built);
  // The indexer finds a prep by its change to the creator: a lock made from a prep without one is never listed.
  if (built.outputs.length <= count) refuse('funding', 'the prep leaves no change to the creator; add KAS so the indexer can find the prep');
  const roles: OutputRole[] = [...Array.from({ length: count }, () => 'lock-factory' as const), 'change'];
  const optimistic = deltaOf(built, roles, { reserveOutputs: Array.from({ length: count }, (_, i) => i) });
  const tx = toBuiltTx(built, { feerate: plan.feerate ?? FEERATE_SOMPI_PER_GRAM, produces: producesOf(roles), optimistic });
  const factories = Array.from({ length: count }, (_, index) => ({ outpoint: { txid: built.txid, index }, value }));
  return { built, roles, optimistic, creatorSpk: f.creatorSpk, factoryProgram: f.program, factory: factories[0]!, factories, tx };
}

/* -------------------------------------------------------------------------- */
/* create                                                                      */
/* -------------------------------------------------------------------------- */

/** Who receives the releases: a Schnorr key, or a script (its redeem script, so the builder can refuse an unsafe one). */
export type LockBeneficiary =
  | { readonly kind: 'p2pk'; readonly xOnly: Uint8Array }
  /** P2SH: `redeem` is the beneficiary's script (key-locked unless `allowAnyScript`: an anyone-can-spend script could extend the lock and take the releases). */
  | { readonly kind: 'p2sh'; readonly redeem: Uint8Array; readonly allowAnyScript?: boolean };

export interface LockCreateParams extends LockFeeOptions {
  readonly set: LockV1Set;
  /** The creator's P2PK address: owns the T cells, funds the deposit, receives the change. */
  readonly creator: string;
  /** The factory cell: a prep's output, or one an earlier prep left unspent (`lockFactoryCellsOf`). */
  readonly factory: { readonly outpoint: { readonly txid: string; readonly index: number }; readonly value: bigint; readonly daaScore: bigint };
  /** The creator's key-owned T cells, 1..3 (the first is the leader); their sum is at least `total`. */
  readonly tokenCells: readonly TokenCell[];
  readonly beneficiary: LockBeneficiary;
  readonly total: bigint;
  /** Unix ms. */
  readonly start: bigint;
  readonly cliff: bigint;
  readonly period: bigint;
  readonly tranches: bigint;
  /** The creator's KAS (P2PK of `creator`): the deposit, the T cell and the fee. */
  readonly funding: readonly FundingUtxo[];
  /** App rules: the token's supply (0.05 % minimum) and the creation time in Unix ms (7 days to 2 years). */
  readonly supply: bigint;
  readonly now: bigint;
  /** The shortest lock in ms (default the 7-day `LOCK_MIN_DURATION_MS`; a testnet passes `LOCK_MIN_DURATION_MS_TESTNET`). */
  readonly minDurationMs?: bigint;
  /** The lock's T cell value (default and minimum 1 KAS). */
  readonly tCellValue?: bigint;
  /** The creator's rest cell value (default: the leader cell's value). */
  readonly restValue?: bigint;
  /** The page's token id: refused when the cells are of another lineage. */
  readonly tokenId?: string;
}

export interface LockCreateResult extends Shaped {
  /** K, the new lock's covenant id. */
  readonly lockId: string;
  readonly state: LockState;
  readonly lockValue: bigint;
  readonly restAmount: bigint;
  readonly tx: BuiltTx;
  /** The creator's rest cell this creates (output 2), for the next lock of a custom-dates flow; none without a rest. */
  readonly restCell?: TokenCell;
  /** The change this creates (last output), the next creation's funding; none when it was dropped. */
  readonly change?: FundingUtxo;
}

/**
 * The beneficiary's 32 bytes and scheme; refuses an unsafe P2SH script, and a key (P2PK, or a key-locked script's) that
 * is not a valid x-only key on secp256k1: the factory accepts any 32 bytes, but no one could ever sign for such a key,
 * so the lock's releases would be frozen for good.
 */
export function lockBeneficiaryOf(b: LockBeneficiary): { beneficiary: Uint8Array; scheme: number } {
  if (b.kind === 'p2pk') {
    if (b.xOnly.length !== 32) refuse('beneficiary', 'a P2PK beneficiary is a 32-byte x-only key');
    if (!isXOnlyPubkey(b.xOnly)) refuse('beneficiary', 'the P2PK beneficiary is not a valid x-only key on secp256k1: nobody could claim its releases');
    return { beneficiary: Uint8Array.from(b.xOnly), scheme: LOCK_SCHEME_P2PK };
  }
  if (b.kind === 'p2sh') {
    try {
      assertSafeRedeem(b.redeem, { ...(b.allowAnyScript === undefined ? {} : { allowAnyScript: b.allowAnyScript }), programs: [] });
    } catch (e) {
      refuse('beneficiary', (e as Error).message);
    }
    const key = keyOfLockedRedeem(b.redeem);
    if (key !== undefined && !isXOnlyPubkey(key)) refuse('beneficiary', 'the script\'s key is not a valid x-only key on secp256k1: nobody could spend its releases');
    return { beneficiary: scriptHashOf(b.redeem), scheme: LOCK_SCHEME_P2SH };
  }
  return refuse('beneficiary', 'a beneficiary is P2PK or P2SH');
}

/** The factory's `create(...)` sigscript (12 arguments in declaration order, the tag, the factory program). */
export function lockCreateSigScript(set: LockV1Set, factoryProgram: Uint8Array, s: LockState, restAmount: bigint, creatorIdx: number): Uint8Array {
  return concat(
    pushMinimal(s.tokenCovId), pushMinimal(s.beneficiary), pushByte(s.scheme), pushInt(s.total), pushInt(s.start), pushInt(s.cliff), pushInt(s.period), pushInt(s.tranches),
    pushInt(restAmount), pushInt(BigInt(creatorIdx)), pushMinimal(set.lock.prefix), pushMinimal(set.lock.suffix), Uint8Array.of(0x04), fromHex(set.factory.createTag), pushMinimal(factoryProgram),
  );
}

/** Lock tokens: spend the factory cell into the lock genesis and the lock's T cell (README creation flow). */
export function buildLockCreate(params: LockCreateParams): LockCreateResult {
  const { set, creator, factory, tokenCells, total, funding } = params;
  if (tokenCells.length < 1 || tokenCells.length > 3) refuse('cells', `${tokenCells.length} T cells, 1 to 3 (a leader and up to 2 delegators)`);
  if (funding.length === 0) refuse('funding', 'the creation needs the creator\'s KAS');
  const f = lockFactoryOf(set, creator);
  const creatorScript = p2pkScript(creator);
  const creatorKey = creatorScript.subarray(1, 33);
  requireFunding(funding, 'funding', creatorScript);
  const leader = tokenCells[0]!;
  const T = leader.covenantId.toLowerCase();
  if (params.tokenId !== undefined && params.tokenId.toLowerCase() !== T) refuse('cells', `the cells are of lineage ${T}, not ${params.tokenId}`);
  const seen = new Set<string>([outpointKey(factory.outpoint), ...funding.map((u) => outpointKey(u.outpoint))]);
  if (seen.size !== 1 + funding.length) refuse('funding', 'an outpoint appears twice');
  for (const c of tokenCells) {
    const at = outpointKey(c.outpoint);
    if (seen.has(at)) refuse('cells', `outpoint ${at} appears twice`);
    seen.add(at);
    if (c.covenantId.toLowerCase() !== T) refuse('cells', 'every T cell is of the leader\'s lineage');
    if (c.state.owner.schemeByte !== 0x00 || !bytesEqual(c.state.owner.identifier, creatorKey)) refuse('cells', `cell ${at} is not owned by the creator's key (the builder signs only the creator's key-owned cells)`);
    if (!bytesEqual(tokenProgram(set.token, c.state), c.program)) refuse('cells', `cell ${at}'s program is not the reference token with its state`);
  }
  if (factory.value < LOCK_FACTORY_CELL_MIN || factory.value > LOCK_FACTORY_CELL_MAX) refuse('factory', `the factory cell holds ${factory.value} sompi, outside ${LOCK_FACTORY_CELL_MIN}..${LOCK_FACTORY_CELL_MAX}`);
  const sum = tokenCells.reduce((a, c) => a + c.state.amount, 0n);
  if (total <= 0n || total > sum) refuse('amount', `lock ${total} of the cells' ${sum}`);
  const restAmount = sum - total;

  const b = lockBeneficiaryOf(params.beneficiary);
  const terms: LockTerms = { tokenCovId: fromHex(T), beneficiary: b.beneficiary, scheme: b.scheme, total, start: params.start, cliff: params.cliff, period: params.period, tranches: params.tranches };
  try {
    assertLockAppRules(terms, { supply: params.supply, now: params.now, ...minDurationOf(params) });
  } catch (e) {
    refuse('app-rule', (e as Error).message);
  }
  const state = lockGenesisState(terms);
  const lockValue = lockDeposit(state.tranches);
  const lockSpk = p2shScript(lockProgram(set, state));
  const K = covenantIdKip20(factory.outpoint.txid, factory.outpoint.index, [{ index: 0, value: lockValue, scriptVersion: 0, script: lockSpk }]);
  const problem = lockStateProblem(state, K);
  if (problem !== undefined) refuse('state', problem);

  const lf = kcc0020Fields(leader.state);
  const locked = lockCellTokenState(total, K, lf.extensionCommitment);
  const rest = restAmount > 0n ? makeKcc0020State({ ...lf, amount: restAmount }) : undefined;
  const next = rest === undefined ? [locked] : [locked, rest];
  checkTokenFamily(T, tokenCells, next, WITNESS_SIGNED);
  const tValue = params.tCellValue ?? LOCK_T_CELL_KAS_MIN;
  if (tValue < LOCK_T_CELL_KAS_MIN) refuse('t-cell', `the lock's T cell value ${tValue} is below ${LOCK_T_CELL_KAS_MIN}`);
  const restValue = params.restValue ?? leader.value;

  const delegators = tokenCells.slice(1);
  const creatorIdx = 1 + tokenCells.length;
  const budgets = createBudgetsOf(delegators.length > 0, rest !== undefined);
  const plan: TxPlan = {
    name: `lock create(${total} in ${state.tranches})`,
    inputs: [
      {
        label: 'LOCK FACTORY create()', outpoint: factory.outpoint, amount: factory.value, spk: f.script, daaScore: factory.daaScore, covenantId: undefined,
        budget: budgets.factory, sigscript: lockCreateSigScript(set, f.program, state, restAmount, creatorIdx), signature: undefined, cellKind: 'lock-factory',
      },
      tokenLeaderSignedInput(leader, next, 'T creator (leader, 00 || sig)', budgets.leader),
      ...delegators.map((c) => tokenDelegatorSignedInput(c, 'T creator (delegator, sig)', BUDGETS_LOCK_V1.delegatorCreate)),
      ...funding.map((u) => kasInput(u, 'creator KAS (P2PK)')),
    ],
    outputs: [
      { label: 'LOCK (genesis K)', value: lockValue, spk: lockSpk, binding: undefined, cell: undefined },
      tokenOut(set, 'the lock\'s T cell (K, 0x04)', locked, tValue, T, 1),
      ...(rest === undefined ? [] : [tokenOut(set, 'the creator\'s rest', rest, restValue, T, 1)]),
    ],
    residual: changeTo(creatorScript),
    genesisGroups: [{ authorizingInput: 0, outputs: [0] }],
    payload: new Uint8Array(0),
    ...feeFieldsOf(params),
  };
  const available = plan.inputs.reduce((a, i) => a + i.amount, 0n);
  const needed = plan.outputs.reduce((a, o) => a + o.value, 0n);
  if (available <= needed) refuse('funds', `the inputs hold ${available} sompi, the lock's deposit and cells need ${needed} plus the fee`);
  let built;
  try {
    built = assemble(plan);
  } catch (e) {
    if (/below the minimum fee|do not cover/.test((e as Error).message)) refuse('funds', `the inputs hold ${available} sompi, too little for ${needed} and the fee`);
    throw e;
  }
  assertFloors(built);
  if (built.genesis.length !== 1 || built.genesis[0]!.covenantId !== K) refuse('genesis', `the genesis id ${built.genesis[0]?.covenantId} is not K ${K}`);
  if (built.outputs.length > LOCK_MAX_CREATE_OUTPUTS) refuse('layout', `${built.outputs.length} outputs, at most ${LOCK_MAX_CREATE_OUTPUTS}`);
  const roles: OutputRole[] = ['lock', 'token-rest', ...(rest === undefined ? [] : ['token-user' as const]), ...(built.outputs.length > plan.outputs.length ? ['change' as const] : [])];
  const optimistic = deltaOf(built, roles);
  const tx = toBuiltTx(built, { feerate: plan.feerate ?? FEERATE_SOMPI_PER_GRAM, produces: producesOf(roles), optimistic });
  const check = checkLockCreateTx(set, tx, { supply: params.supply, now: params.now, creator, ...minDurationOf(params) }, { ...feeFieldsOf(params), feerate: plan.feerate ?? FEERATE_SOMPI_PER_GRAM });
  if (check.lockId !== K || check.fee !== built.fee || check.restAmount !== restAmount) refuse('self-check', 'the check derived other figures than the build');
  // The next creation of a custom-dates flow spends these before they are accepted (from the mempool).
  const restCell: TokenCell | undefined = rest === undefined ? undefined : {
    kind: 'token', outpoint: { txid: built.txid, index: 2 }, value: restValue, covenantId: T, program: tokenProgram(set.token, rest), state: rest, daaScore: 0n,
  };
  const changeAt = roles.indexOf('change');
  const change: FundingUtxo | undefined = changeAt < 0 ? undefined : {
    outpoint: { txid: built.txid, index: changeAt }, amount: built.outputs[changeAt]!.value, spk: creatorScript, daaScore: 0n, address: creator,
  };
  return { built, roles, optimistic, lockId: K, state, lockValue, restAmount, tx, ...(restCell === undefined ? {} : { restCell }), ...(change === undefined ? {} : { change }) };
}

/* -------------------------------------------------------------------------- */
/* claim                                                                       */
/* -------------------------------------------------------------------------- */

export interface LockClaimParams extends LockFeeOptions {
  readonly set: LockV1Set;
  readonly lock: LockCell;
  /** The lock's own T cell (created by the lock cell's transaction). */
  readonly tCell: TokenCell;
  /**
   * The claim's lockTime and the lock's `now`, Unix ms. Consensus admits the claim only once the past median time is
   * above it (a claim with a future lockTime is rejected, not held): pass at most the node's past median time - 1.
   */
  readonly now: bigint;
}

export interface LockClaimResult extends Shaped {
  readonly final: boolean;
  /** Tranches vested at `now` (the continuation's `claimed`). */
  readonly vested: bigint;
  /** Tokens paid to the beneficiary. */
  readonly amount: bigint;
  /** The continuation's state (non-final). */
  readonly next?: LockState;
  readonly feeSompi: bigint;
  readonly tx: BuiltTx;
}

function claimPlanBase(set: LockV1Set, lock: LockCell, tCell: TokenCell, now: bigint, next: readonly TokenState[], final: boolean, opts: LockFeeOptions): Omit<TxPlan, 'outputs' | 'residual' | 'name'> {
  const b = BUDGETS_LOCK_V1;
  return {
    inputs: [
      lockInputOf(lock, 'LOCK claim()', final ? b.lockClaimFinal : b.lockClaim, noArgSigScript(set.lock.claimTag, lock.program), undefined),
      tokenLeaderCovenantInput(tCell, next, 'the lock\'s T cell (T leader, 00)', final ? b.cellClaimFinal : b.cellClaim),
    ],
    genesisGroups: [],
    payload: new Uint8Array(0),
    lockTime: now,
    lockTimeDomain: 'timestamp',
    ...feeFieldsOf(opts),
  };
}

/**
 * Claim every tranche vested at `now` (permissionless, unsigned). Refuses (`LockClaimNotDue`) when nothing is due, a
 * cell that is not the lock's own, and a fee above FEE_CAP at the chosen feerate. The fee is the model's minimum at
 * that feerate (plus `feeMargin`): the lock keeps the rest.
 */
export function buildLockClaim(params: LockClaimParams): LockClaimResult {
  const { set, lock, tCell, now } = params;
  requireLiveLock(set, lock, tCell);
  if (typeof now !== 'bigint' || now < LOCK_TIME_THRESHOLD) refuse('time', `now ${String(now)} is not a timestamp (Unix ms at or above ${LOCK_TIME_THRESHOLD})`);
  const s = lock.state;
  const c = lockClaimableAt(s, now);
  if (c.tranches === 0n) throw new LockClaimNotDue(now, lockNextUnlock(s)!.at);
  const K = lock.covenantId;
  const T = toHex(s.tokenCovId);
  const ext = kcc0020Fields(tCell.state).extensionCommitment;
  const payout = lockPayoutState(s, c.amount, ext);
  let built;
  let next: LockState | undefined;
  try {
    if (c.final) {
      const base = claimPlanBase(set, lock, tCell, now, [payout], true, params);
      const plan: TxPlan = {
        ...base,
        name: `lock claim ${s.claimed} -> ${c.vested} of ${s.tranches} (final)`,
        outputs: [tokenOut(set, 'payout (beneficiary)', payout, LOCK_PAYOUT_CELL_KAS, T, 1)],
        residual: { label: 'the lock\'s KAS (beneficiary)', spk: lockPayeeScript(s), binding: undefined, cell: undefined, minimum: lock.value + tCell.value - LOCK_PAYOUT_CELL_KAS - LOCK_FEE_CAP, dropBelow: undefined },
      };
      built = assemble(plan);
    } else {
      next = { ...s, claimed: c.vested };
      const rest = lockCellTokenState(s.total - lockAmountAt(s, c.vested), K, ext);
      const base = claimPlanBase(set, lock, tCell, now, [rest, payout], false, params);
      const contSpk = p2shScript(lockProgram(set, next));
      const name = `lock claim ${s.claimed} -> ${c.vested} of ${s.tranches}`;
      const restOut = tokenOut(set, 'rest (K, 0x04)', rest, tCell.value, T, 1);
      const payoutOut = tokenOut(set, 'payout (beneficiary)', payout, LOCK_PAYOUT_CELL_KAS, T, 1);
      // The fee first, with the continuation as the residual (its position does not change the masses); then the
      // continuation as output 0, the harness's order, carrying exactly lock - 1 KAS - fee.
      const sizing: TxPlan = {
        ...base, name, outputs: [restOut, payoutOut],
        residual: { label: "LOCK'", spk: contSpk, binding: { authorizingInput: 0, covenantId: K }, cell: undefined, minimum: lock.value - LOCK_PAYOUT_CELL_KAS - LOCK_FEE_CAP, dropBelow: undefined },
      };
      const fee = estimate(sizing).fee;
      const plan: TxPlan = {
        ...base, name,
        outputs: [{ label: "LOCK'", value: lock.value - LOCK_PAYOUT_CELL_KAS - fee, spk: contSpk, binding: { authorizingInput: 0, covenantId: K }, cell: undefined }, restOut, payoutOut],
        residual: undefined,
      };
      built = assemble(plan);
      if (built.fee !== fee) refuse('fee', `the fee moved from ${fee} to ${built.fee} between sizing and assembly`);
    }
  } catch (e) {
    if (e instanceof ResidualBelowMinimum) refuse('fee', `the claim's fee would be above the lock's cap ${LOCK_FEE_CAP} at feerate ${params.feerate ?? FEERATE_SOMPI_PER_GRAM}`);
    throw e;
  }
  if (built.fee > LOCK_FEE_CAP) refuse('fee', `the fee ${built.fee} sompi is above the lock's cap ${LOCK_FEE_CAP}`);
  if (built.inputsToSign.length !== 0) refuse('signature', 'a claim has no signature slot');
  assertFloors(built);
  const roles: OutputRole[] = c.final ? ['token-user', 'beneficiary'] : ['lock', 'token-rest', 'token-user'];
  const optimistic = deltaOf(built, roles);
  const feerate = params.feerate ?? FEERATE_SOMPI_PER_GRAM;
  const tx = toBuiltTx(built, { feerate, produces: producesOf(roles), optimistic });
  const check = checkLockClaimTx(set, tx, { feerate, feeMargin: params.feeMargin ?? 0n });
  if (check.vested !== c.vested || check.fee !== built.fee || check.final !== c.final || check.lockId !== K) refuse('self-check', 'the check derived other figures than the build');
  return { built, roles, optimistic, final: c.final, vested: c.vested, amount: c.amount, ...(next === undefined ? {} : { next }), feeSompi: built.fee, tx };
}

/* -------------------------------------------------------------------------- */
/* extend                                                                      */
/* -------------------------------------------------------------------------- */

export interface LockExtendParams extends LockFeeOptions {
  readonly set: LockV1Set;
  readonly lock: LockCell;
  readonly tCell: TokenCell;
  /** The new schedule: each at least the current value; the new end at most `endCap`. */
  readonly start: bigint;
  readonly cliff: bigint;
  readonly period: bigint;
  /** The beneficiary's KAS (P2PK): the fee. */
  readonly funding: readonly FundingUtxo[];
  /** Change (P2PK). */
  readonly changeAddress: string;
  /**
   * A P2SH beneficiary (scheme 0x03): the input spending P2SH(redeem), the beneficiary's script, signed SIGHASH_ALL by
   * `signerXOnly`. Key-locked scripts only unless `allowAnyScript`.
   */
  readonly scriptAuthority?: { readonly redeem: Uint8Array; readonly utxo: FundingUtxo; readonly signerXOnly: string; readonly allowAnyScript?: boolean };
}

export interface LockExtendResult extends Shaped {
  readonly next: LockState;
  readonly tx: BuiltTx;
}

/** The index of the P2SH authority input in an extend (after the lock and its T cell). */
export const LOCK_EXTEND_AUTHORITY_INDEX = 2;

/** `extend(start, cliff, period, witness)` sigscript and the signature slot's offset (P2PK) or undefined (P2SH). */
export function lockExtendSigScript(set: LockV1Set, program: Uint8Array, start: bigint, cliff: bigint, period: bigint, witness: Uint8Array): { bytes: Uint8Array; signatureOffset: number | undefined } {
  const head = concat(pushInt(start), pushInt(cliff), pushInt(period));
  const bytes = concat(head, pushMinimal(witness), Uint8Array.of(0x04), fromHex(set.lock.extendTag), pushMinimal(program));
  return { bytes, signatureOffset: witness.length === 65 ? head.length + 1 : undefined };
}

/** Move the schedule later (the beneficiary signs; the T cell is carried through; the lock's KAS is kept exactly). */
export function buildLockExtend(params: LockExtendParams): LockExtendResult {
  const { set, lock, tCell } = params;
  requireLiveLock(set, lock, tCell);
  const s = lock.state;
  if (params.start < s.start || params.cliff < s.cliff || params.period < s.period) refuse('extend', 'start, cliff and period may only grow');
  const next: LockState = { ...s, start: params.start, cliff: params.cliff, period: params.period };
  const p = lockStateProblem(next, lock.covenantId);
  if (p !== undefined) refuse('extend', p);
  if (params.funding.length === 0) refuse('funding', 'the extend needs the beneficiary\'s KAS for the fee');
  requireFunding(params.funding, 'funding');
  const auth = params.scriptAuthority;
  const K = lock.covenantId;
  const T = toHex(s.tokenCovId);
  let witness: Uint8Array;
  let authority: InputPlan[] = [];
  let signer: string;
  if (s.scheme === LOCK_SCHEME_P2PK) {
    if (auth !== undefined) refuse('beneficiary', 'a P2PK beneficiary signs the lock input; no authority script');
    witness = ZERO_SIG65;
    signer = toHex(s.beneficiary);
  } else {
    if (auth === undefined) refuse('beneficiary', 'a P2SH beneficiary extends through its script: scriptAuthority is required');
    if (!bytesEqual(scriptHashOf(auth.redeem), s.beneficiary)) refuse('beneficiary', 'the authority script is not the beneficiary\'s');
    try {
      assertSafeRedeem(auth.redeem, { ...(auth.allowAnyScript === undefined ? {} : { allowAnyScript: auth.allowAnyScript }), programs: [lock.program, tCell.program] });
    } catch (e) {
      refuse('beneficiary', (e as Error).message);
    }
    const key = keyOfLockedRedeem(auth.redeem);
    if (key !== undefined && toHex(key) !== auth.signerXOnly.toLowerCase()) refuse('beneficiary', 'the authority script is locked to another key than the signer');
    witness = Uint8Array.of(LOCK_EXTEND_AUTHORITY_INDEX);
    signer = auth.signerXOnly.toLowerCase();
    authority = [{
      label: 'beneficiary script (P2SH authority, SIGHASH_ALL)', outpoint: auth.utxo.outpoint, amount: auth.utxo.amount, spk: p2shScript(auth.redeem), daaScore: auth.utxo.daaScore,
      covenantId: undefined, budget: BUDGETS_LOCK_V1.p2pk, sigscript: concat(Uint8Array.of(0x41), ZERO_SIG65, pushMinimal(auth.redeem)),
      signature: { kind: 'lock-beneficiary', offset: 1, signer, sighashType: 1 },
    }];
  }
  const sig = lockExtendSigScript(set, lock.program, params.start, params.cliff, params.period, witness);
  const ext = kcc0020Fields(tCell.state).extensionCommitment;
  const carried = lockCellTokenState(tCell.state.amount, K, ext);
  checkTokenFamily(T, [tCell], [carried], WITNESS_COVENANT);
  const plan: TxPlan = {
    name: `lock extend(${params.start}, ${params.cliff}, ${params.period})`,
    inputs: [
      lockInputOf(lock, 'LOCK extend()', BUDGETS_LOCK_V1.lockExtend, sig.bytes, sig.signatureOffset === undefined ? undefined : { kind: 'lock-beneficiary', offset: sig.signatureOffset, signer, sighashType: 1 }),
      tokenLeaderCovenantInput(tCell, [carried], 'the lock\'s T cell (T leader, 00)', BUDGETS_LOCK_V1.cellExtend),
      ...authority,
      ...params.funding.map((u) => kasInput(u, 'beneficiary KAS (fee)')),
    ],
    outputs: [
      { label: "LOCK'", value: lock.value, spk: p2shScript(lockProgram(set, next)), binding: { authorizingInput: 0, covenantId: K }, cell: undefined },
      tokenOut(set, 'the lock\'s T cell (carried)', carried, tCell.value, T, 1),
    ],
    residual: changeTo(p2pkScript(params.changeAddress)),
    genesisGroups: [],
    payload: new Uint8Array(0),
    ...feeFieldsOf(params),
  };
  const built = assemble(plan);
  assertFloors(built);
  const roles: OutputRole[] = ['lock', 'token-rest', ...(built.outputs.length > 2 ? ['change' as const] : [])];
  const optimistic = deltaOf(built, roles);
  const feerate = params.feerate ?? FEERATE_SOMPI_PER_GRAM;
  const tx = toBuiltTx(built, { feerate, produces: producesOf(roles), optimistic });
  checkLockExtendTx(set, tx, { feerate, feeMargin: params.feeMargin ?? 0n, changeAddress: params.changeAddress });
  return { built, roles, optimistic, next, tx };
}

/* -------------------------------------------------------------------------- */
/* Pre-sign checks                                                             */
/* -------------------------------------------------------------------------- */

interface JsonInput {
  readonly transactionId?: string;
  readonly index?: number;
  readonly previousOutpoint?: { readonly transactionId?: string; readonly index?: number };
  readonly signatureScript?: string;
  readonly sequence?: string | number;
  readonly computeBudget?: string | number;
  readonly utxo?: { readonly amount?: string | number; readonly scriptPublicKey?: string; readonly covenantId?: string | null } | null;
}
interface JsonOutput {
  readonly value?: string | number;
  readonly scriptPublicKey?: string;
  readonly covenant?: { readonly authorizingInput?: number; readonly covenantId?: string } | null;
}
interface JsonTx {
  readonly version?: number;
  readonly inputs?: JsonInput[];
  readonly outputs?: JsonOutput[];
  readonly lockTime?: string | number;
  readonly subnetworkId?: string;
  readonly gas?: string | number;
  readonly payload?: string;
}

/** One input of a serialised transaction, as the checks read it. */
export interface CheckedInput {
  readonly outpoint: { readonly txid: string; readonly index: number };
  readonly sigscript: Uint8Array;
  readonly sequence: bigint;
  readonly amount: bigint;
  readonly script: Uint8Array;
  readonly covenantId: string | undefined;
}

/** One output of a serialised transaction, as the checks read it. */
export interface CheckedOutput {
  readonly value: bigint;
  readonly script: Uint8Array;
  readonly binding: { readonly authorizingInput: number; readonly covenantId: string } | undefined;
}

function big(v: string | number | undefined, what: string): bigint {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) return BigInt(v);
  return refuse('self-check', `${what} is not a decimal amount`);
}

function scriptOf(spk: string | undefined, what: string): Uint8Array {
  if (typeof spk !== 'string' || !/^0000([0-9a-f]{2})+$/.test(spk)) return refuse('self-check', `${what} is not a version-0 script`);
  return fromHex(spk.slice(4));
}

/** The inputs, outputs and header of a SafeJSON transaction; refuses a payload, gas, another version or subnetwork. */
export function parseLockTx(tx: BuiltTx): { inputs: CheckedInput[]; outputs: CheckedOutput[]; lockTime: bigint } {
  let raw: JsonTx;
  try {
    raw = JSON.parse(tx.txJson) as JsonTx;
  } catch {
    return refuse('self-check', 'the transaction JSON does not parse');
  }
  if (raw.version !== undefined && raw.version !== 1) refuse('self-check', `version ${raw.version}`);
  if (raw.payload !== undefined && raw.payload !== '') refuse('self-check', 'the transaction carries a payload');
  if (raw.gas !== undefined && big(raw.gas, 'gas') !== 0n) refuse('self-check', 'gas is not 0');
  if (raw.subnetworkId !== undefined && !/^0+$/.test(raw.subnetworkId)) refuse('self-check', 'not the native subnetwork');
  const inputs = (raw.inputs ?? []).map((i, k): CheckedInput => {
    const txid = (i.previousOutpoint?.transactionId ?? i.transactionId ?? '').toLowerCase();
    const index = i.previousOutpoint?.index ?? i.index;
    if (!/^[0-9a-f]{64}$/.test(txid) || typeof index !== 'number') refuse('self-check', `input ${k} has no outpoint`);
    if (typeof i.signatureScript !== 'string' || !/^([0-9a-f]{2})*$/.test(i.signatureScript)) refuse('self-check', `input ${k} has no sigscript`);
    const id = i.utxo?.covenantId ?? undefined;
    return {
      outpoint: { txid, index: index! }, sigscript: fromHex(i.signatureScript!), sequence: i.sequence === undefined ? 0n : big(i.sequence, `input ${k} sequence`),
      amount: big(i.utxo?.amount, `input ${k} amount`), script: scriptOf(i.utxo?.scriptPublicKey, `input ${k} script`), covenantId: id === undefined || /^0*$/.test(id) ? undefined : id.toLowerCase(),
    };
  });
  const outputs = (raw.outputs ?? []).map((o, k): CheckedOutput => {
    const c = o.covenant;
    let binding: CheckedOutput['binding'];
    if (c !== null && c !== undefined) {
      if (typeof c.authorizingInput !== 'number' || typeof c.covenantId !== 'string') refuse('self-check', `output ${k} binding is malformed`);
      binding = { authorizingInput: c.authorizingInput!, covenantId: c.covenantId!.toLowerCase() };
    }
    return { value: big(o.value, `output ${k} value`), script: scriptOf(o.scriptPublicKey, `output ${k} script`), binding };
  });
  return { inputs, outputs, lockTime: raw.lockTime === undefined ? 0n : big(raw.lockTime, 'lockTime') };
}

/** The fee of a lock transaction from its bytes: `in - out`, inside the model at `opts.feerate`, budgets the roles'. */
function feeChecked(tx: BuiltTx, budgets: readonly number[], opts: { readonly feerate?: bigint; readonly feeMargin?: bigint }): bigint {
  const b = feeFromBytes(tx.txJson);
  if (b.budgets.length !== budgets.length || b.budgets.some((v, k) => v !== budgets[k])) refuse('fee', `the compute budgets ${b.budgets.join(',')} are not the roles' ${budgets.join(',')}`);
  const why = feeOutsideModel(b, opts.feerate, opts.feeMargin ?? 0n);
  if (why !== undefined) refuse('fee', why);
  if (b.fee !== tx.feeSompi) refuse('fee', `the transaction pays ${b.fee} sompi, the build said ${tx.feeSompi}`);
  return b.fee;
}

/** The token state of a reference token program (template identified, byte round trip asserted). */
function tokenStateOf(program: Uint8Array, what: string): TokenState {
  const registry = defaultRegistry();
  try {
    if (registry.identifyTemplate(program).templateHash !== REFERENCE_KCC0020_TEMPLATE_HASH) refuse('cells', `${what} is not the reference token template`);
    return registry.assertRoundTrip(program, REFERENCE_KCC0020_TEMPLATE_HASH);
  } catch (e) {
    if (e instanceof LockRefused) throw e;
    return refuse('cells', `${what}: ${(e as Error).message}`);
  }
}

/** A token input's invocation: `transfer(next, witness)` (leader) or `transferDelegator(witness)`. */
function tokenInvocationOf(i: CheckedInput, k: number): { program: Uint8Array; state: TokenState; entry: 'transfer' | 'transferDelegator'; next: readonly TokenState[]; witness: Uint8Array } {
  let d;
  try {
    d = decodeInvocation(i.sigscript, 'token');
  } catch (e) {
    return refuse('cells', `input ${k} is not a token invocation: ${(e as Error).message}`);
  }
  if (!bytesEqual(p2shScript(d.program), i.script)) refuse('cells', `input ${k}'s program does not hash to its script`);
  const state = tokenStateOf(d.program, `input ${k}`);
  const inv = d.invocation;
  if (inv.contract !== 'token') return refuse('cells', `input ${k} is not a token invocation`);
  return inv.entry === 'transfer' ? { program: d.program, state, entry: 'transfer', next: inv.nextStates, witness: inv.witness } : { program: d.program, state, entry: 'transferDelegator', next: [], witness: inv.witness };
}

const sameToken = (set: LockV1Set, a: TokenState, b: TokenState): boolean => bytesEqual(tokenProgram(set.token, a), tokenProgram(set.token, b));

/** True when the output is bound `(authorizingInput, covenantId)`. */
const bound = (o: CheckedOutput | undefined, auth: number, id: string): boolean => o?.binding?.authorizingInput === auth && o.binding.covenantId === id;

/** Input 0's sigscript envelope; refuses (`rule`) one that does not parse. */
function envelopeOf(sigscript: Uint8Array, rule: string): ReturnType<typeof parseSigScriptEnvelope> {
  try {
    return parseSigScriptEnvelope(sigscript);
  } catch (e) {
    return refuse(rule, `input 0: ${(e as Error).message}`);
  }
}

/** The lock cell input 0 of a claim or an extend spends, re-derived from `program` (`lockCellOf`). */
function lockCellOfInput(set: LockV1Set, li: CheckedInput, program: Uint8Array): LockCell {
  if (li.covenantId === undefined) refuse('lock', 'input 0 carries no covenant id');
  try {
    return lockCellOf(set, { outpoint: li.outpoint, value: li.amount, covenantId: li.covenantId!, program, daaScore: 0n });
  } catch (e) {
    return refuse('lock', (e as Error).message);
  }
}

/** Input 1 of a claim or an extend: the lock's own T cell (lineage T, `lockTokenCellProblem`), as T leader with witness 00. */
function lockTCellInvocationOf(lock: LockCell, ti: CheckedInput, T: string): ReturnType<typeof tokenInvocationOf> {
  if (ti.covenantId !== T) refuse('lock-cell', `input 1 is of lineage ${ti.covenantId}, the lock holds ${T}`);
  const tok = tokenInvocationOf(ti, 1);
  const p = lockTokenCellProblem(lock, { outpoint: ti.outpoint, covenantId: ti.covenantId!, state: tok.state });
  if (p !== undefined) refuse('lock-cell', p);
  if (tok.entry !== 'transfer' || tok.witness.length !== 1 || tok.witness[0] !== 0x00) refuse('lock-cell', 'input 1 is not the T leader with witness 00');
  return tok;
}

function isP2pkScript(s: Uint8Array): boolean {
  return s.length === 34 && s[0] === 0x20 && s[33] === 0xac;
}
function isP2shScript(s: Uint8Array): boolean {
  return s.length === 35 && s[0] === 0xaa && s[1] === 0x20 && s[34] === 0x87;
}

/** The app rules a creation is checked against. */
export interface LockCreateRules {
  /** The token's supply (0.05 % minimum). */
  readonly supply: bigint;
  /** The creation time, Unix ms (7 days to 2 years). */
  readonly now: bigint;
  /** The shortest lock in ms (default the 7-day `LOCK_MIN_DURATION_MS`; a testnet passes `LOCK_MIN_DURATION_MS_TESTNET`). */
  readonly minDurationMs?: bigint;
  /** When given, the creator's P2PK address: the factory's creatorSpk must be its script. */
  readonly creator?: string;
}

/** What `checkLockCreateTx` derived. */
export interface LockCreateCheck {
  readonly lockId: string;
  readonly state: LockState;
  readonly lockValue: bigint;
  readonly tCellValue: bigint;
  readonly restAmount: bigint;
  readonly creatorSpk: Uint8Array;
  readonly fee: bigint;
}

/**
 * Throws `LockRefused` unless the serialised transaction is exactly a lock creation of this build:
 *  - in0 spends P2SH(LockFactory(LOCK_H, creatorSpk)) with `create(...)`; creatorSpk a Schnorr P2PK script (the
 *    creator's, when `rules.creator` is given); no signature slot on it;
 *  - in1..in(n) are 1..3 cells of T: the leader `transfer` and the rest `transferDelegator`, all owned by the creator's
 *    key; every later input is plain, unbound and pays creatorSpk; `creatorIdx` is the first of them;
 *  - out0 is P2SH(Lock(genesis state)) bound by the genesis (0, [0]) with K = KIP-20(in0, out0), value exactly the
 *    deposit; the state well formed for K (claimed 0, version 1, endCap = E + 5 years) and within the app rules;
 *  - out1 is the lock's T cell {total, K, 0x04, 0, 0^32, the leader's ext}, bound (1, T), value >= 1 KAS; out2, when the
 *    cells hold more than `total`, is the leader's own state with the rest, bound (1, T); the leader's next states are
 *    exactly these; every remaining output is unbound and pays creatorSpk (change) - nothing else reaches K, no other
 *    covenant output, at most 6 outputs;
 *  - the fee is in - out, inside the model, and the compute budgets are the roles'.
 */
export function checkLockCreateTx(set: LockV1Set, tx: BuiltTx, rules: LockCreateRules, opts: LockFeeOptions = {}): LockCreateCheck {
  const { inputs, outputs, lockTime } = parseLockTx(tx);
  if (lockTime !== 0n) refuse('self-check', 'a creation has lockTime 0');
  if (outputs.length < 2 || outputs.length > LOCK_MAX_CREATE_OUTPUTS) refuse('layout', `${outputs.length} outputs, a creation has 2 to ${LOCK_MAX_CREATE_OUTPUTS}`);
  if (inputs.length < 3) refuse('layout', 'a creation has the factory, a T cell and the creator\'s KAS');
  const signed = new Set(tx.inputsToSign.map((s) => s.index));
  if (signed.has(0)) refuse('factory', 'the factory input carries no signature');

  // in0: the factory.
  const f = inputs[0]!;
  if (f.covenantId !== undefined) refuse('factory', 'the factory input is bound to a covenant');
  const env = envelopeOf(f.sigscript, 'factory');
  if (env.tag !== set.factory.createTag) refuse('factory', 'input 0 does not invoke the factory\'s create()');
  let creatorSpk: Uint8Array;
  try {
    creatorSpk = lockFactoryCreatorOf(set, env.program);
  } catch (e) {
    return refuse('factory', (e as Error).message);
  }
  if (!bytesEqual(p2shScript(env.program), f.script)) refuse('factory', 'the factory program does not hash to its input\'s script');
  const creatorScript = creatorSpk.subarray(2);
  if (rules.creator !== undefined && !bytesEqual(p2pkScript(rules.creator), creatorScript)) refuse('factory', 'the factory is not the creator\'s');
  const a = env.argumentPushes.map((p) => p.payload);
  if (a.length !== 12) refuse('factory', `create() takes 12 arguments, got ${a.length}`);
  const int = (b: Uint8Array, what: string): bigint => {
    try {
      return decodeScriptNum(b);
    } catch (e) {
      return refuse('factory', `${what}: ${(e as Error).message}`);
    }
  };
  if (a[0]!.length !== 32 || a[1]!.length !== 32 || a[2]!.length !== 1) refuse('factory', 'create() arguments are malformed');
  const terms: LockTerms = {
    tokenCovId: Uint8Array.from(a[0]!), beneficiary: Uint8Array.from(a[1]!), scheme: a[2]![0]!, total: int(a[3]!, 'total'), start: int(a[4]!, 'start'), cliff: int(a[5]!, 'cliff'),
    period: int(a[6]!, 'period'), tranches: int(a[7]!, 'tranches'),
  };
  if (terms.scheme === LOCK_SCHEME_P2PK && !isXOnlyPubkey(terms.beneficiary)) refuse('beneficiary', 'the P2PK beneficiary is not a valid x-only key on secp256k1');
  const restAmount = int(a[8]!, 'restAmount');
  const creatorIdx = int(a[9]!, 'creatorIdx');
  if (!bytesEqual(a[10]!, set.lock.prefix) || !bytesEqual(a[11]!, set.lock.suffix)) refuse('factory', 'create() does not carry the lock template');
  try {
    assertLockAppRules(terms, { supply: rules.supply, now: rules.now, ...minDurationOf(rules) });
  } catch (e) {
    refuse('app-rule', (e as Error).message);
  }
  // The genesis state the factory writes: claimed 0, the current version, endCap = E + five years.
  const state = lockGenesisState(terms);
  const T = toHex(terms.tokenCovId);

  // The T inputs, then the creator's KAS.
  let n = 0;
  while (1 + n < inputs.length && inputs[1 + n]!.covenantId !== undefined) n++;
  if (n < 1 || n > 3) refuse('cells', `${n} T inputs, 1 to 3`);
  const tIns = inputs.slice(1, 1 + n).map((i, j) => {
    if (i.covenantId !== T) refuse('cells', `input ${1 + j} is of lineage ${i.covenantId}, the lock is of ${T}`);
    return tokenInvocationOf(i, 1 + j);
  });
  const leader = tIns[0]!;
  if (leader.entry !== 'transfer') refuse('cells', 'input 1 is not the T leader');
  for (const [j, d] of tIns.entries()) {
    if (j > 0 && d.entry !== 'transferDelegator') refuse('cells', `input ${1 + j} is not a T delegator`);
    const ff = kcc0020Fields(d.state);
    if (ff.ownerScheme !== 0x00 || !bytesEqual(ff.owner, creatorScript.subarray(1, 33))) refuse('cells', `input ${1 + j} is not owned by the creator's key`);
  }
  for (let k = 1 + n; k < inputs.length; k++) {
    const i = inputs[k]!;
    if (i.covenantId !== undefined || !bytesEqual(i.script, creatorScript)) refuse('funding', `input ${k} is not the creator's plain P2PK KAS`);
  }
  if (creatorIdx !== BigInt(1 + n)) refuse('factory', `creatorIdx ${creatorIdx} is not the creator's first KAS input ${1 + n}`);
  const sum = tIns.reduce((s, d) => s + d.state.amount, 0n);
  if (restAmount !== sum - terms.total || restAmount < 0n) refuse('amount', `restAmount ${restAmount}, the cells hold ${sum} and the lock takes ${terms.total}`);

  // out0: the lock genesis.
  const lockValue = lockDeposit(state.tranches);
  const o0 = outputs[0]!;
  const lockSpk = p2shScript(lockProgram(set, state));
  if (!bytesEqual(o0.script, lockSpk)) refuse('lock', 'output 0 is not the lock with the create() state');
  if (o0.value !== lockValue) refuse('deposit', `the lock holds ${o0.value}, the deposit is exactly ${lockValue}`);
  const K = covenantIdKip20(f.outpoint.txid, f.outpoint.index, [{ index: 0, value: o0.value, scriptVersion: 0, script: o0.script }]);
  if (!bound(o0, 0, K)) refuse('lock', `output 0 is not the genesis of K ${K} authorised by the factory`);
  try {
    assertLockState(state, K);
  } catch (e) {
    refuse('state', (e as Error).message);
  }

  // out1, out2: T.
  const lf = kcc0020Fields(leader.state);
  const locked = lockCellTokenState(terms.total, K, lf.extensionCommitment);
  const rest = restAmount > 0n ? makeKcc0020State({ ...lf, amount: restAmount }) : undefined;
  const expected = rest === undefined ? [locked] : [locked, rest];
  if (leader.next.length !== expected.length || leader.next.some((s, j) => !sameToken(set, s, expected[j]!))) refuse('cells', 'the leader does not transfer exactly [the lock\'s cell, the rest]');
  const o1 = outputs[1]!;
  if (!bytesEqual(o1.script, p2shScript(tokenProgram(set.token, locked))) || !bound(o1, 1, T)) refuse('t-cell', 'output 1 is not the lock\'s T cell bound (1, T)');
  if (o1.value < LOCK_T_CELL_KAS_MIN) refuse('t-cell', `the lock's T cell holds ${o1.value}, at least ${LOCK_T_CELL_KAS_MIN}`);
  let at = 2;
  if (rest !== undefined) {
    const o2 = outputs[2];
    if (o2 === undefined || !bytesEqual(o2.script, p2shScript(tokenProgram(set.token, rest))) || !bound(o2, 1, T)) refuse('rest', 'output 2 is not the creator\'s rest bound (1, T)');
    at = 3;
  }
  for (let k = at; k < outputs.length; k++) {
    const o = outputs[k]!;
    if (o.binding !== undefined) refuse('layout', `output ${k} is bound to ${o.binding.covenantId}: a creation has no other covenant output`);
    if (!bytesEqual(o.script, creatorScript)) refuse('layout', `output ${k} does not pay the creator (only change follows the T cells)`);
  }
  if (outputs.length - at > 1) refuse('layout', 'at most one change output');

  const b = BUDGETS_LOCK_V1;
  const create = createBudgetsOf(n > 1, rest !== undefined);
  const budgets = [create.factory, create.leader, ...Array.from({ length: n - 1 }, () => b.delegatorCreate), ...Array.from({ length: inputs.length - 1 - n }, () => b.p2pk)];
  const fee = feeChecked(tx, budgets, opts);
  // The exact sigscript the builder writes (no alternative encoding of the same arguments).
  if (!bytesEqual(f.sigscript, lockCreateSigScript(set, env.program, state, restAmount, Number(creatorIdx)))) refuse('factory', 'the create() sigscript is not the canonical encoding');
  return { lockId: K, state, lockValue, tCellValue: o1.value, restAmount, creatorSpk, fee };
}

/** What `checkLockClaimTx` derived. */
export interface LockClaimCheck {
  readonly lockId: string;
  readonly state: LockState;
  readonly now: bigint;
  readonly vested: bigint;
  readonly final: boolean;
  readonly amount: bigint;
  readonly fee: bigint;
}

/**
 * Throws `LockRefused` unless the serialised transaction is exactly a valid claim:
 *  - lockTime a timestamp (and below `opts.pastMedianTime` when given: a later one is rejected by the node); no
 *    signature slot; exactly two inputs, both sequence 0;
 *  - in0 a lock cell (K, LOCK_H) invoking `claim()`, its state well formed for K;
 *  - in1 the lock's own T cell: lineage T, the same creating txid, {total - amountAt(claimed), K, 0x04, 0, 0^32}, as T
 *    leader with witness 00 and exactly the expected next states;
 *  - vested(lockTime) > claimed;
 *  - non-final: exactly 3 outputs, the continuation {.., claimed: vested} bound (0, K) with value >= lock - 1 KAS - FEE_CAP,
 *    the rest bound (1, T) with value >= the T cell's, the payout bound (1, T) holding exactly 1 KAS;
 *    final: exactly 2 outputs, the payout, then the beneficiary's own script unbound with >= lock + T - 1 KAS - FEE_CAP;
 *  - fee in - out <= FEE_CAP, inside the model.
 */
export function checkLockClaimTx(set: LockV1Set, tx: BuiltTx, opts: LockFeeOptions & { readonly pastMedianTime?: bigint } = {}): LockClaimCheck {
  const { inputs, outputs, lockTime: now } = parseLockTx(tx);
  if (tx.inputsToSign.length !== 0) refuse('signature', 'a claim has no input to sign');
  if (now < LOCK_TIME_THRESHOLD) refuse('time', `lockTime ${now} is not a timestamp`);
  if (opts.pastMedianTime !== undefined && now >= opts.pastMedianTime) refuse('time', `lockTime ${now} is not below the past median time ${opts.pastMedianTime}: the node would reject the claim`);
  if (inputs.length !== 2) refuse('layout', `${inputs.length} inputs, a claim has exactly the lock and its T cell`);
  const [li, ti] = [inputs[0]!, inputs[1]!];
  if (li.sequence !== 0n || ti.sequence !== 0n) refuse('layout', 'a claim\'s inputs have sequence 0');
  const env = envelopeOf(li.sigscript, 'lock');
  if (env.tag !== set.lock.claimTag || env.argumentPushes.length !== 0) refuse('lock', 'input 0 does not invoke claim()');
  if (!bytesEqual(li.sigscript, noArgSigScript(set.lock.claimTag, env.program))) refuse('lock', 'the claim() sigscript is not canonical');
  if (!bytesEqual(p2shScript(env.program), li.script)) refuse('lock', 'the lock program does not hash to its input\'s script');
  const lock = lockCellOfInput(set, li, env.program);
  const s = lock.state;
  const K = lock.covenantId;
  const T = toHex(s.tokenCovId);
  const tok = lockTCellInvocationOf(lock, ti, T);

  const c = lockClaimableAt(s, now);
  if (c.tranches === 0n) refuse('not-due', `nothing is claimable at ${now}`);
  const ext = kcc0020Fields(tok.state).extensionCommitment;
  const payout = lockPayoutState(s, c.amount, ext);
  const payoutScript = p2shScript(tokenProgram(set.token, payout));
  if (c.final) {
    if (outputs.length !== 2) refuse('layout', `${outputs.length} outputs, a final claim has exactly 2`);
    if (tok.next.length !== 1 || !sameToken(set, tok.next[0]!, payout)) refuse('payout', 'the T leader does not transfer exactly the payout');
    const [o0, o1] = [outputs[0]!, outputs[1]!];
    if (!bytesEqual(o0.script, payoutScript) || !bound(o0, 1, T)) refuse('payout', 'output 0 is not the payout bound (1, T)');
    if (o0.value !== LOCK_PAYOUT_CELL_KAS) refuse('payout', `the payout cell holds ${o0.value}, exactly ${LOCK_PAYOUT_CELL_KAS}`);
    if (!bytesEqual(o1.script, lockPayeeScript(s)) || o1.binding !== undefined) refuse('final', 'output 1 is not the beneficiary\'s own script, unbound');
    if (o1.value < li.amount + ti.amount - LOCK_PAYOUT_CELL_KAS - LOCK_FEE_CAP) refuse('final', 'the beneficiary\'s KAS output is below lock + T cell - 1 KAS - FEE_CAP');
  } else {
    if (outputs.length !== 3) refuse('layout', `${outputs.length} outputs, a claim has exactly 3`);
    const next: LockState = { ...s, claimed: c.vested };
    const rest = lockCellTokenState(s.total - lockAmountAt(s, c.vested), K, ext);
    if (tok.next.length !== 2 || !sameToken(set, tok.next[0]!, rest) || !sameToken(set, tok.next[1]!, payout)) refuse('payout', 'the T leader does not transfer exactly [rest, payout]');
    const [o0, o1, o2] = [outputs[0]!, outputs[1]!, outputs[2]!];
    if (!bytesEqual(o0.script, p2shScript(lockProgram(set, next))) || !bound(o0, 0, K)) refuse('lock', 'output 0 is not the continuation {.., claimed: vested} bound (0, K)');
    if (o0.value < li.amount - LOCK_PAYOUT_CELL_KAS - LOCK_FEE_CAP) refuse('lock', 'the continuation is below lock - 1 KAS - FEE_CAP');
    if (!bytesEqual(o1.script, p2shScript(tokenProgram(set.token, rest))) || !bound(o1, 1, T)) refuse('rest', 'output 1 is not the K-owned rest bound (1, T)');
    if (o1.value < ti.amount) refuse('rest', 'the rest holds less KAS than the lock\'s T cell');
    if (!bytesEqual(o2.script, payoutScript) || !bound(o2, 1, T)) refuse('payout', 'output 2 is not the payout bound (1, T)');
    if (o2.value !== LOCK_PAYOUT_CELL_KAS) refuse('payout', `the payout cell holds ${o2.value}, exactly ${LOCK_PAYOUT_CELL_KAS}`);
  }
  const fee = inputs.reduce((a, i) => a + i.amount, 0n) - outputs.reduce((a, o) => a + o.value, 0n);
  if (fee < 0n || fee > LOCK_FEE_CAP) refuse('fee', `the claim pays a fee of ${fee} sompi, the lock allows 0..${LOCK_FEE_CAP}`);
  const b = BUDGETS_LOCK_V1;
  if (feeChecked(tx, c.final ? [b.lockClaimFinal, b.cellClaimFinal] : [b.lockClaim, b.cellClaim], opts) !== fee) refuse('fee', 'the fee from the bytes differs from the outputs\' arithmetic');
  return { lockId: K, state: s, now, vested: c.vested, final: c.final, amount: c.amount, fee };
}

/** What `checkLockExtendTx` derived. */
export interface LockExtendCheck {
  readonly lockId: string;
  readonly state: LockState;
  readonly next: LockState;
  readonly fee: bigint;
}

/**
 * Throws `LockRefused` unless the serialised transaction is exactly a valid extend:
 *  - lockTime 0; in0 a lock cell invoking `extend(start', cliff', period', witness)`; in1 its own T cell (as in a claim)
 *    carried through with witness 00 to exactly the same state;
 *  - P2PK beneficiary: the witness is a 65-byte slot (zero-filled and listed for the wallet with SIGHASH_ALL, or
 *    signed with hash type 0x01); P2SH: the witness is one byte naming an input (not 0, not 1) whose script is
 *    P2SH(beneficiary), listed for signing SIGHASH_ALL;
 *  - start', cliff', period' each >= the old value; the new state well formed (E <= endCap);
 *  - out0 the continuation with the new schedule bound (0, K), value == the lock's; out1 the T cell, same state, bound
 *    (1, T), value >= the T input's; every other output unbound (change), at most one, and with `changeAddress` paying
 *    exactly that address (the builder passes it, so a builder bug or a tampered bundle
 *    cannot send the beneficiary's KAS elsewhere);
 *  - every other input plain and unbound (the authority input excepted); the fee inside the model.
 */
export function checkLockExtendTx(set: LockV1Set, tx: BuiltTx, opts: LockFeeOptions & { readonly changeAddress?: string } = {}): LockExtendCheck {
  const { inputs, outputs, lockTime } = parseLockTx(tx);
  if (lockTime !== 0n) refuse('self-check', 'an extend has lockTime 0');
  if (inputs.length < 3) refuse('layout', 'an extend has the lock, its T cell and the beneficiary\'s KAS');
  if (outputs.length < 2 || outputs.length > 3) refuse('layout', `${outputs.length} outputs, an extend has 2 or 3`);
  const [li, ti] = [inputs[0]!, inputs[1]!];
  const env = envelopeOf(li.sigscript, 'lock');
  if (env.tag !== set.lock.extendTag || env.argumentPushes.length !== 4) refuse('lock', 'input 0 does not invoke extend(start, cliff, period, witness)');
  if (!bytesEqual(p2shScript(env.program), li.script)) refuse('lock', 'the lock program does not hash to its input\'s script');
  const lock = lockCellOfInput(set, li, env.program);
  const s = lock.state;
  const K = lock.covenantId;
  const T = toHex(s.tokenCovId);
  const args = env.argumentPushes.map((p) => p.payload);
  let start: bigint, cliff: bigint, period: bigint;
  try {
    [start, cliff, period] = [decodeScriptNum(args[0]!), decodeScriptNum(args[1]!), decodeScriptNum(args[2]!)];
  } catch (e) {
    return refuse('extend', (e as Error).message);
  }
  const witness = args[3]!;
  const canonical = lockExtendSigScript(set, env.program, start, cliff, period, witness);
  if (!bytesEqual(li.sigscript, canonical.bytes)) refuse('lock', 'the extend() sigscript is not canonical');
  const slots = new Map(tx.inputsToSign.map((x) => [x.index, x]));
  let authIdx: number | undefined;
  if (s.scheme === LOCK_SCHEME_P2PK) {
    if (witness.length !== 65) refuse('signature', 'a P2PK beneficiary\'s witness is a 65-byte signature');
    const slot = slots.get(0);
    const zero = witness.every((x) => x === 0);
    if (zero) {
      if (slot === undefined || slot.sighashType !== 1 || slot.signatureOffset !== canonical.signatureOffset) refuse('signature', 'the lock input\'s signature slot is not listed for the beneficiary with SIGHASH_ALL');
    } else if (witness[64] !== 0x01) refuse('signature', `the beneficiary's signature has hash type 0x${witness[64]!.toString(16)}, not SIGHASH_ALL`);
  } else {
    if (witness.length !== 1) refuse('signature', 'a P2SH beneficiary\'s witness is one byte, the authority input');
    authIdx = witness[0]!;
    if (authIdx === 0 || authIdx === 1 || authIdx >= inputs.length) refuse('signature', `the authority input ${authIdx} is the lock, its T cell or missing`);
    const a = inputs[authIdx]!;
    if (!isP2shScript(a.script) || !bytesEqual(a.script.subarray(2, 34), s.beneficiary)) refuse('signature', `input ${authIdx} does not pay P2SH(beneficiary)`);
    if (a.covenantId !== undefined) refuse('signature', `input ${authIdx} is bound to a covenant`);
    if (slots.get(authIdx)?.sighashType !== 1) refuse('signature', `the authority input ${authIdx} is not signed SIGHASH_ALL`);
  }
  if (start < s.start || cliff < s.cliff || period < s.period) refuse('extend', 'start, cliff and period may only grow');
  const next: LockState = { ...s, start, cliff, period };
  const problem = lockStateProblem(next, K);
  if (problem !== undefined) refuse('extend', problem);
  if (lockEndOf(next) > s.endCap) refuse('extend', 'the new end is past endCap');

  const tok = lockTCellInvocationOf(lock, ti, T);
  const carried = lockCellTokenState(tok.state.amount, K, kcc0020Fields(tok.state).extensionCommitment);
  if (tok.next.length !== 1 || !sameToken(set, tok.next[0]!, carried)) refuse('lock-cell', 'the T cell is not carried through unchanged');
  for (let k = 2; k < inputs.length; k++) {
    if (k === authIdx) continue;
    const i = inputs[k]!;
    if (i.covenantId !== undefined || !isP2pkScript(i.script)) refuse('funding', `input ${k} is not plain P2PK KAS`);
  }

  const [o0, o1] = [outputs[0]!, outputs[1]!];
  if (!bytesEqual(o0.script, p2shScript(lockProgram(set, next))) || !bound(o0, 0, K)) refuse('lock', 'output 0 is not the continuation with the new schedule bound (0, K)');
  if (o0.value !== li.amount) refuse('lock', 'the lock\'s KAS is not kept exactly');
  if (!bytesEqual(o1.script, p2shScript(tokenProgram(set.token, carried))) || !bound(o1, 1, T)) refuse('lock-cell', 'output 1 is not the T cell bound (1, T)');
  if (o1.value < ti.amount) refuse('lock-cell', 'the T cell holds less KAS than before');
  for (let k = 2; k < outputs.length; k++) if (outputs[k]!.binding !== undefined) refuse('layout', `output ${k} is bound to a covenant: an extend has no other covenant output`);
  if (opts.changeAddress !== undefined) {
    const change = p2pkScript(opts.changeAddress);
    for (let k = 2; k < outputs.length; k++) if (!bytesEqual(outputs[k]!.script, change)) refuse('funding', `output ${k}, the change, does not pay ${opts.changeAddress}`);
  }

  const b = BUDGETS_LOCK_V1;
  const budgets = inputs.map((_, k) => (k === 0 ? b.lockExtend : k === 1 ? b.cellExtend : b.p2pk));
  const fee = feeChecked(tx, budgets, opts);
  return { lockId: K, state: s, next, fee };
}
