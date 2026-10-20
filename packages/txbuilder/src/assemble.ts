/**
 * Transaction assembly: a declarative `TxPlan` (inputs with their sigscripts
 * and budgets, fixed outputs, one residual output, genesis groups, payload)
 * becomes a finalized SDK transaction with the exact minimum fee.
 *
 * Conventions: version 1, lockTime 0, native subnetwork, sequence 0 unless an
 * input plan sets one (a covenant that reads its own age), sigOpCount 0; covenant inputs first, funding last;
 * cell outputs before the residual (change or payout); every cell output
 * carries its `CovenantBinding(authorizingInput, covenantId)` and genesis
 * outputs get theirs from `populateGenesisCovenants`.
 *
 * Order of operations: outputs are fixed
 * first, including the fee, then the transaction is finalized (the SDK caches
 * `Transaction.id`), then signatures are spliced into the sigscripts, then
 * budgets may still be patched. The v1 sighash and the txid cover neither
 * sigscripts nor compute budgets, so signing and budget patching never move
 * the txid; the builder asserts this by recomputing the KIP-24 txid itself.
 *
 * The fee is a fixed point: sigscript sizes are known before signing (the
 * signature slots are zero-filled and 65 bytes), only the residual value
 * depends on the fee, and the residual's own storage term depends on its
 * value, so the loop converges in two or three passes.
 */

import { toHex } from '@kasseal/codec';
import { covenantIdKip20 } from './blake2b.ts';
import { plainTxFromSdk, txidV1, type PlainTx } from './kip24.ts';
import { COVENANT_OUTPUT_FLOOR, FEERATE_SOMPI_PER_GRAM, FeeAboveCeiling, P2PK_OUTPUT_FLOOR, assertMinable, boundedFeerate, feeCeiling, masses, type Masses, type TxShape } from './mass.ts';
import type { CellKind, CurveState, PoolCellState, TokenState } from './program.ts';
import { NATIVE_SUBNETWORK_ID } from './kip24.ts';
import { sdk, type SdkPrivateKey, type SdkTransaction, type SdkTransactionInputInit, type SdkUtxoEntryReference } from './sdk.ts';
import { SCHNORR_SIG_LENGTH, signatureFromP2pkSigScript, spliceSignature } from './sigscript.ts';

/** A transaction outpoint. */
export interface Outpoint {
  /** Transaction id, lowercase hex. */
  readonly txid: string;
  /** Output index. */
  readonly index: number;
}

/** `txid:index`, the key outpoints are compared by. */
export const outpointKey = (o: Outpoint): string => `${o.txid}:${o.index}`;

/** A plain KAS UTXO (P2PK) that funds a transaction or authorizes a genesis group. */
export interface FundingUtxo {
  /** The UTXO's outpoint. */
  readonly outpoint: Outpoint;
  /** Value, sompi. */
  readonly amount: bigint;
  /** Script bytes (version 0). */
  readonly spk: Uint8Array;
  /** DAA score of the block that created it. */
  readonly daaScore: bigint;
  /** The P2PK address it pays. */
  readonly address: string;
}

/** A live covenant cell of one of the three lineages. */
export interface CellRef<K extends CellKind, S> {
  /** The lineage kind. */
  readonly kind: K;
  /** The cell's outpoint. */
  readonly outpoint: Outpoint;
  /** KAS value, sompi. */
  readonly value: bigint;
  /** The lineage's covenant id, hex. */
  readonly covenantId: string;
  /** The cell's program `R`. */
  readonly program: Uint8Array;
  /** The decoded state. */
  readonly state: S;
  /** DAA score of the block that created it. */
  readonly daaScore: bigint;
}
/** A verified token cell. */
export type TokenCell = CellRef<'token', TokenState>;
/** A verified curve cell. */
export type CurveCell = CellRef<'curve', CurveState>;
/** A verified pool cell. */
export type PoolCell = CellRef<'pool', PoolCellState>;
/** Any verified cell. */
export type AnyCell = TokenCell | CurveCell | PoolCell;

/** Who signs an input: a P2PK key, or a token cell's owner as leader or delegator. */
export type SignatureKind = 'p2pk' | 'token-leader' | 'token-delegator';

/** Where a signature goes and who must produce it. */
export interface SignatureSlot {
  readonly kind: SignatureKind;
  /** Byte offset of the 65-byte `sig64 || hashtype` slot inside the input's sigscript. */
  readonly offset: number;
  /** Signer hint: a P2PK address, or the x-only owner key (hex) of a token cell. */
  readonly signer: string;
  /** Consensus sighash type byte (SIGHASH_ALL = 1), what a wallet `signPskt` request takes. */
  readonly sighashType: 1;
}

/** One input of a `TxPlan`. */
export interface InputPlan {
  /** Human-readable label for errors. */
  readonly label: string;
  readonly outpoint: Outpoint;
  readonly amount: bigint;
  readonly spk: Uint8Array;
  readonly daaScore: bigint;
  readonly covenantId: string | undefined;
  readonly budget: number;
  /** Complete sigscript with zero-filled signature slots. */
  readonly sigscript: Uint8Array;
  readonly signature: SignatureSlot | undefined;
  /** The lineage kind of a covenant input (absent for P2PK inputs); the shapes derive the optimistic delta from it. */
  readonly cellKind?: InputCellKind;
  /**
   * The input's `sequence` (default 0). A covenant that reads its own age (`this.ageDaa >= N`, compiled to
   * `N OP_CHECKSEQUENCEVERIFY`) needs `sequence >= N` with bit 63 clear, and consensus then requires the UTXO to be at
   * least `sequence` DAA old. Must be below 2^32 (bits 32..63 clear): the relative lock reads the low 32 bits only.
   */
  readonly sequence?: bigint;
}

/** The kind of a program input: the three token-launch lineages, or a companion contract's cell (not built by this SDK's public shapes). */
export type InputCellKind = CellKind | 'vault' | 'deposit' | 'splitter' | 'order' | 'anchor' | 'dist-key';

/** The largest input sequence a plan may carry: bits 32..63 clear (bit 63 would disable the relative lock). */
export const MAX_INPUT_SEQUENCE = 0xffff_ffffn;

/** The state a plan predicts for a covenant output. */
export type PredictedState =
  | { readonly kind: 'token'; readonly state: TokenState }
  | { readonly kind: 'curve'; readonly state: CurveState }
  | { readonly kind: 'pool'; readonly state: PoolCellState };

/** A covenant cell the plan creates; `covenantId` is undefined for a genesis output until derived. */
export interface PredictedCell {
  readonly predicted: PredictedState;
  readonly program: Uint8Array;
  readonly covenantId: string | undefined;
}

/** One fixed output of a `TxPlan`. */
export interface OutputPlan {
  /** Human-readable label for errors. */
  readonly label: string;
  readonly value: bigint;
  readonly spk: Uint8Array;
  readonly binding: { readonly authorizingInput: number; readonly covenantId: string } | undefined;
  readonly cell: PredictedCell | undefined;
}

/** The output that receives whatever the inputs leave after the fixed outputs and the fee. */
export interface ResidualOutput {
  readonly label: string;
  readonly spk: Uint8Array;
  readonly binding: OutputPlan['binding'];
  readonly cell: PredictedCell | undefined;
  /** The value may not fall below this (the output is required, e.g. a payout). */
  readonly minimum: bigint;
  /** When set and the value would be below it, the output is omitted and its value joins the fee (change only). */
  readonly dropBelow: bigint | undefined;
}

/** A KIP-20 genesis group: outputs whose covenant id derives from one authorizing input. */
export interface GenesisGroup {
  /** The authorizing input's index. */
  readonly authorizingInput: number;
  /** The group's output indices. */
  readonly outputs: readonly number[];
}

/** A declarative transaction: inputs, fixed outputs, a residual, genesis groups and payload. */
export interface TxPlan {
  /** Name used in errors. */
  readonly name: string;
  readonly inputs: readonly InputPlan[];
  readonly outputs: readonly OutputPlan[];
  readonly residual: ResidualOutput | undefined;
  readonly genesisGroups: readonly GenesisGroup[];
  readonly payload: Uint8Array;
  /** Sompi added on top of the exact minimum fee. */
  readonly feeMargin: bigint;
  /** Sompi per gram of the binding mass (default and minimum 100, the node's floor; `GET /fees` may ask for more, up to `FEERATE_MAX_SOMPI_PER_GRAM`). */
  readonly feerate?: bigint;
  /**
   * The transaction's lock time (default 0). A covenant with an absolute CLTV lock needs it set to that DAA score;
   * consensus then admits the transaction once the DAA score passes it. Must be
   * a DAA score (below 500,000,000,000), and only with every input's sequence non-final, which the builder's 0 is.
   */
  readonly lockTime?: bigint;
}

/** An output of an assembled transaction. */
export interface BuiltOutput {
  readonly index: number;
  readonly label: string;
  readonly value: bigint;
  readonly spk: Uint8Array;
  readonly binding: { readonly authorizingInput: number; readonly covenantId: string } | undefined;
  readonly cell: PredictedCell | undefined;
}

/** A genesis group's derived covenant id and its first output. */
export interface DerivedGenesis {
  readonly group: GenesisGroup;
  readonly covenantId: string;
  readonly outpoint: Outpoint;
}

/**
 * A finalized SDK transaction with its plan, as `assemble` produces it. The serialisable result the app and the wallet
 * flow consume is `BuiltTx` (types.ts); `finalize.ts` produces it from this.
 */
export interface AssembledTx {
  readonly plan: TxPlan;
  readonly tx: SdkTransaction;
  /** Finalized txid; unchanged by signing and budget patches. */
  readonly txid: string;
  readonly fee: bigint;
  readonly masses: Masses;
  readonly outputs: readonly BuiltOutput[];
  /** Residual value actually paid, 0 when dropped into the fee. */
  readonly residualValue: bigint;
  readonly inputsToSign: readonly { readonly index: number; readonly slot: SignatureSlot }[];
  readonly genesis: readonly DerivedGenesis[];
  /** Compute budgets as set on the transaction, per input. */
  readonly budgets: readonly number[];
}

/** The inputs cannot cover the fixed outputs and the fee while leaving the required residual (a payout or a merged cell) its minimum. */
export class ResidualBelowMinimum extends Error {
  readonly residual: bigint;
  readonly minimum: bigint;
  constructor(tx: string, label: string, residual: bigint, minimum: bigint) {
    super(`${tx}: residual output "${label}" would be ${residual} sompi, below its minimum ${minimum}`);
    this.name = 'ResidualBelowMinimum';
    this.residual = residual;
    this.minimum = minimum;
  }
}

/** Lowest change value kept; below it the change goes to the fee (its storage term would cost more than it is worth). */
export const MIN_CHANGE = 10_000_000n; // 0.1 KAS

/** The mass model's view of a plan with the given residual value (undefined: no residual output). */
export function shapeOf(plan: TxPlan, residualValue: bigint | undefined): TxShape {
  const outputs = plan.outputs.map((o) => ({ value: o.value, spkLength: o.spk.length, hasCovenant: o.binding !== undefined || o.cell !== undefined }));
  if (plan.residual && residualValue !== undefined && residualValue > 0n) {
    outputs.push({ value: residualValue, spkLength: plan.residual.spk.length, hasCovenant: plan.residual.binding !== undefined || plan.residual.cell !== undefined });
  }
  return {
    inputs: plan.inputs.map((i) => ({ sigScriptLength: i.sigscript.length, computeBudget: i.budget, amount: i.amount, spkLength: i.spk.length, hasCovenant: i.covenantId !== undefined })),
    outputs,
    payloadLength: plan.payload.length,
  };
}

/** The fee and residual value of a plan without building an SDK transaction. */
export function estimate(plan: TxPlan): { fee: bigint; residualValue: bigint; masses: Masses } {
  const feerate = feerateOf(plan);
  const totalIn = plan.inputs.reduce((a, i) => a + i.amount, 0n);
  const fixedOut = plan.outputs.reduce((a, o) => a + o.value, 0n);
  let fee = 0n;
  let residualValue = 0n;
  let m: Masses | undefined;
  for (let pass = 0; pass < 10; pass++) {
    let residual = totalIn - fixedOut - fee;
    if (plan.residual === undefined) {
      if (residual < 0n) throw new Error(`${plan.name}: inputs ${totalIn} do not cover outputs ${fixedOut} + fee ${fee}`);
      residualValue = 0n;
    } else if (plan.residual.dropBelow !== undefined && residual < plan.residual.dropBelow) {
      residualValue = 0n;
      residual = 0n;
    } else {
      if (residual < plan.residual.minimum) throw new ResidualBelowMinimum(plan.name, plan.residual.label, residual, plan.residual.minimum);
      residualValue = residual;
    }
    m = masses(shapeOf(plan, residualValue));
    const wanted = BigInt(m.max) * feerate + plan.feeMargin;
    if (plan.residual === undefined) {
      // No residual: the whole surplus is the fee, which must at least cover the minimum.
      const surplus = totalIn - fixedOut;
      if (surplus < wanted) throw new Error(`${plan.name}: surplus ${surplus} is below the minimum fee ${wanted}`);
      fee = surplus;
      break;
    }
    if (residualValue === 0n) {
      // Residual dropped: whatever is left is the fee.
      fee = totalIn - fixedOut;
      if (fee < wanted) throw new Error(`${plan.name}: residual dropped but the remaining ${fee} sompi is below the minimum fee ${wanted}`);
      break;
    }
    if (wanted === fee) break;
    fee = wanted;
  }
  if (!m) throw new Error('unreachable');
  assertMinable(m);
  // Defence in depth: whatever the feerate, the margin or a dropped change did, the fee stays under the ceiling.
  if (fee > feeCeiling(m.minFee)) throw new FeeAboveCeiling(plan.name, fee, m.minFee);
  for (const o of plan.outputs) assertOutputFloor(plan.name, o.label, o.value, o.binding !== undefined || o.cell !== undefined);
  if (residualValue > 0n && plan.residual) assertOutputFloor(plan.name, plan.residual.label, residualValue, plan.residual.binding !== undefined || plan.residual.cell !== undefined);
  return { fee, residualValue, masses: m };
}

/** The plan's feerate in sompi per gram: never below the node's floor, refused (`FeerateOutOfRange`) above the cap. */
export function feerateOf(plan: TxPlan): bigint {
  const f = plan.feerate ?? FEERATE_SOMPI_PER_GRAM;
  if (f < FEERATE_SOMPI_PER_GRAM) throw new Error(`${plan.name}: feerate ${f} is below the node's floor of ${FEERATE_SOMPI_PER_GRAM} sompi per gram`);
  return boundedFeerate(f, plan.name);
}

function assertOutputFloor(tx: string, label: string, value: bigint, covenant: boolean): void {
  const floor = covenant ? COVENANT_OUTPUT_FLOOR : P2PK_OUTPUT_FLOOR;
  if (value < floor) throw new Error(`${tx}: output "${label}" of ${value} sompi is below the ${covenant ? 'covenant' : 'P2PK'} output floor ${floor} (unminable)`);
}

/** Build the SDK transaction for a plan: fee fixed point, bindings, genesis ids, `finalize()`, txid self-check. */
export function assemble(plan: TxPlan): AssembledTx {
  const k = sdk();
  const { fee, residualValue, masses: m } = estimate(plan);

  // The SDK accepts a plain UTXO entry object here; its typings name the wrapper class.
  const sdkInputs: SdkTransactionInputInit[] = plan.inputs.map((i) => ({
    previousOutpoint: { transactionId: i.outpoint.txid, index: i.outpoint.index },
    signatureScript: toHex(i.sigscript),
    sequence: sequenceOf(plan.name, i),
    sigOpCount: 0,
    computeBudget: i.budget,
    utxo: {
      outpoint: { transactionId: i.outpoint.txid, index: i.outpoint.index },
      amount: i.amount,
      scriptPublicKey: new k.ScriptPublicKey(0, toHex(i.spk)),
      blockDaaScore: i.daaScore,
      isCoinbase: false,
    } as unknown as SdkUtxoEntryReference,
  }));
  const outputs: BuiltOutput[] = plan.outputs.map((o, index) => ({ index, label: o.label, value: o.value, spk: o.spk, binding: o.binding, cell: o.cell }));
  if (plan.residual && residualValue > 0n) {
    outputs.push({ index: outputs.length, label: plan.residual.label, value: residualValue, spk: plan.residual.spk, binding: plan.residual.binding, cell: plan.residual.cell });
  }
  const sdkOutputs = outputs.map((o) => new k.TransactionOutput(o.value, new k.ScriptPublicKey(0, toHex(o.spk))));

  const tx = new k.Transaction({
    version: 1,
    inputs: sdkInputs,
    outputs: sdkOutputs,
    lockTime: lockTimeOf(plan),
    subnetworkId: NATIVE_SUBNETWORK_ID,
    gas: 0n,
    payload: toHex(plan.payload),
  });
  if (plan.genesisGroups.length > 0) tx.populateGenesisCovenants(plan.genesisGroups.map((g) => new k.GenesisCovenantGroup(g.authorizingInput, [...g.outputs])));
  const outs = tx.outputs;
  outputs.forEach((o, i) => {
    if (o.binding) outs[i]!.covenant = new k.CovenantBinding(o.binding.authorizingInput, new k.Hash(o.binding.covenantId));
  });
  tx.outputs = outs;
  tx.finalize();

  // Genesis ids: SDK binding == own KIP-20 recomputation.
  const genesis: DerivedGenesis[] = plan.genesisGroups.map((g) => {
    const auth = plan.inputs[g.authorizingInput];
    if (!auth) throw new Error(`${plan.name}: genesis group names input ${g.authorizingInput}, which does not exist`);
    const own = covenantIdKip20(auth.outpoint.txid, auth.outpoint.index, g.outputs.map((i) => ({ index: i, value: outputs[i]!.value, scriptVersion: 0, script: outputs[i]!.spk })));
    for (const i of g.outputs) {
      const bound = tx.outputs[i]?.covenant;
      if (!bound || bound.covenantId.toString() !== own || bound.authorizingInput !== g.authorizingInput) {
        throw new Error(`${plan.name}: genesis output ${i} bound to ${bound?.covenantId.toString()} (auth ${bound?.authorizingInput}), expected ${own} (auth ${g.authorizingInput})`);
      }
    }
    return { group: g, covenantId: own, outpoint: auth.outpoint };
  });
  const finalOutputs = outputs.map((o) => {
    const bound = tx.outputs[o.index]!.covenant;
    const binding = bound ? { authorizingInput: bound.authorizingInput, covenantId: bound.covenantId.toString() } : undefined;
    const cell = o.cell && o.cell.covenantId === undefined && binding ? { ...o.cell, covenantId: binding.covenantId } : o.cell;
    return { ...o, binding, cell };
  });

  // Our KIP-24 txid must equal the SDK's.
  const own = txidV1(plainTxFromSdk(tx)).txid;
  if (own !== tx.id) throw new Error(`${plan.name}: KIP-24 txid ${own} != SDK txid ${tx.id}`);

  const inputsToSign = plan.inputs.flatMap((i, index) => (i.signature ? [{ index, slot: i.signature }] : []));
  return { plan, tx, txid: tx.id, fee, masses: m, outputs: finalOutputs, residualValue, inputsToSign, genesis, budgets: plan.inputs.map((i) => i.budget) };
}

/** The largest lock time a plan may carry: a DAA score (timestamps start at 500,000,000,000). */
export const MAX_LOCK_TIME_DAA = 499_999_999_999n;

/** A plan's lock time: 0 unless set; refused outside `0 .. MAX_LOCK_TIME_DAA`. */
export function lockTimeOf(plan: TxPlan): bigint {
  const t = plan.lockTime ?? 0n;
  if (typeof t !== 'bigint' || t < 0n || t > MAX_LOCK_TIME_DAA) throw new Error(`${plan.name}: lock time ${String(t)} is not a DAA score in 0..${MAX_LOCK_TIME_DAA}`);
  return t;
}

/** An input's sequence: 0 unless the plan sets one; refused outside `0 .. MAX_INPUT_SEQUENCE`. */
export function sequenceOf(tx: string, input: InputPlan): bigint {
  const s = input.sequence ?? 0n;
  if (typeof s !== 'bigint' || s < 0n || s > MAX_INPUT_SEQUENCE) throw new Error(`${tx}: input "${input.label}" sequence ${String(s)} is outside 0..${MAX_INPUT_SEQUENCE}`);
  return s;
}

/** Splice a 65-byte signature into one input's sigscript slot. */
export function applySignature(built: AssembledTx, index: number, sig65: Uint8Array): void {
  const req = built.inputsToSign.find((s) => s.index === index);
  if (!req) throw new Error(`input ${index} has no signature slot`);
  const ins = built.tx.inputs;
  const current = ins[index]!.signatureScript ?? '';
  const bytes = spliceSignature(hexToBytes(current), req.slot.offset, sig65);
  ins[index]!.signatureScript = toHex(bytes);
  built.tx.inputs = ins;
}

/**
 * Sign every slot with a local key (`SIGHASH_ALL` over the v1 sighash, as the
 * SDK's `createInputSignature` computes it for P2PK and P2SH inputs alike).
 * `keyFor` returns the key for a slot or undefined to leave it for a wallet.
 */
export function signWithKeys(built: AssembledTx, keyFor: (slot: SignatureSlot, index: number) => SdkPrivateKey | undefined): number[] {
  const k = sdk();
  const signed: number[] = [];
  for (const { index, slot } of built.inputsToSign) {
    const key = keyFor(slot, index);
    if (!key) continue;
    applySignature(built, index, signatureFromP2pkSigScript(k.createInputSignature(built.tx, index, key, k.SighashType.All)));
    signed.push(index);
  }
  if (plainTxFromSdk(built.tx).inputs.length !== built.plan.inputs.length) throw new Error('input count changed while signing');
  if (built.tx.id !== built.txid) throw new Error(`txid changed while signing: ${built.tx.id} != ${built.txid}`);
  return signed;
}

/** True when every signature slot holds a non-zero signature. */
export function isFullySigned(built: AssembledTx): boolean {
  const ins = built.tx.inputs;
  return built.inputsToSign.every(({ index, slot }) => {
    const bytes = hexToBytes(ins[index]!.signatureScript ?? '');
    return bytes.subarray(slot.offset, slot.offset + SCHNORR_SIG_LENGTH).some((b) => b !== 0);
  });
}

/** Set one input's compute budget on the built transaction (allowed after signing; not part of the sighash or txid). */
export function patchBudget(built: AssembledTx, index: number, budget: number): AssembledTx {
  const ins = built.tx.inputs;
  if (!ins[index]) throw new Error(`no input ${index}`);
  ins[index].computeBudget = budget;
  built.tx.inputs = ins;
  const budgets = built.budgets.map((b, i) => (i === index ? budget : b));
  const m = masses(shapeOf({ ...built.plan, inputs: built.plan.inputs.map((inp, i) => ({ ...inp, budget: budgets[i]! })) }, built.residualValue));
  return { ...built, budgets, masses: m };
}

/** The plan with budgets replaced, for a rebuild after a budget rejection that made compute the binding bucket. */
export function withBudgets(plan: TxPlan, budgets: readonly number[]): TxPlan {
  if (budgets.length !== plan.inputs.length) throw new Error('budgets length mismatch');
  return { ...plan, inputs: plan.inputs.map((i, idx) => ({ ...i, budget: budgets[idx]! })) };
}

/** The SDK-independent form of an assembled transaction. */
export function plainTx(built: AssembledTx): PlainTx {
  return plainTxFromSdk(built.tx);
}

/** P2PK script bytes of an address. */
export function p2pkScript(address: string): Uint8Array {
  return hexToBytes(sdk().payToAddressScript(address).script);
}

/** `version(2, big-endian) || script`: the `byte[36]` form the contracts compare `tx.outputs[i].scriptPubKey` against. */
export function versionedSpk(spk: Uint8Array, version = 0): Uint8Array {
  const out = new Uint8Array(2 + spk.length);
  out[0] = (version >> 8) & 0xff;
  out[1] = version & 0xff;
  out.set(spk, 2);
  return out;
}

/** Strip the 2-byte version of a `byte[36]` constructor script to the 34-byte P2PK script. */
export function scriptOfVersionedSpk(versioned: Uint8Array): { version: number; script: Uint8Array } {
  if (versioned.length < 2) throw new Error('versioned spk too short');
  return { version: (versioned[0]! << 8) | versioned[1]!, script: versioned.subarray(2) };
}

/** Bytes of an even-length hex string (no validation; use the codec's `fromHex` for untrusted input). */
export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Address of a P2SH script public key on the configured network. */
export function addressOfSpk(spk: Uint8Array, networkId: string): string {
  const k = sdk();
  const a = k.addressFromScriptPublicKey(new k.ScriptPublicKey(0, toHex(spk)), networkId);
  if (!a) throw new Error('script public key has no address form');
  return a.toString();
}

/** Plain funding input plan (P2PK Schnorr, budget from the table). */
export function fundingInput(utxo: FundingUtxo, label: string, budget: number, placeholder: Uint8Array): InputPlan {
  return {
    label,
    outpoint: utxo.outpoint,
    amount: utxo.amount,
    spk: utxo.spk,
    daaScore: utxo.daaScore,
    covenantId: undefined,
    budget,
    sigscript: placeholder,
    signature: { kind: 'p2pk', offset: 1, signer: utxo.address, sighashType: 1 },
  };
}
