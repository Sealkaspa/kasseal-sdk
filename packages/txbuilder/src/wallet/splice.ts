/**
 * The wallet side of signing: what the builder's `BuiltTx`
 * becomes on the way to Kaspire, and what comes back.
 *
 * `prepareSignRequest(txJson, inputs)` turns `BuiltTx.txJson` (SafeJSON with
 * `utxo.covenantId` patched in) into the string the wallet signs:
 *
 *   - every input to sign must hold the builder's placeholder: the 66-byte
 *     `41 || 0^65` for `p2pk`, or a P2SH sigscript whose 65-byte slot at the
 *     recorded `signatureOffset` is zero and sits exactly where a witness
 *     signature can (`signatureSlotsOf`); the offset is the one the builder
 *     computed for that exact sigscript, never a constant;
 *   - its `signatureScript` is emptied, as Kaspire requires of a selected
 *     input ("selected input is already signed" otherwise);
 *   - a missing `utxo.address` is filled from the entry's script public key,
 *     so every request has the shape verified on testnet-10 (the SDK writes null when
 *     the entry was built without one; neither the txid nor the sighash
 *     covers it);
 *   - every covenant input must carry `utxo.covenantId` (the prebuilt path
 *     fails closed without it);
 *   - `sighashType` is the consensus byte 1 (SIGHASH_ALL), not the SDK enum.
 *
 * For the prebuilt-signature path (B2) it also returns, per P2SH input, the
 * builder's sigscript with the empty slot, its offset and the
 * `expectedSighash` from `sighash.ts`, which Kaspire recomputes and checks.
 *
 * Coming back, `finalizeSigned` (finalize.ts) takes only the signatures: the
 * 66-byte P2PK answer as is; for a P2SH input the 65-byte `sig64 || 01`,
 * either from a P2PK-style answer (B1, what Kaspire 1.2.0 returns) or from
 * the returned prebuilt script, which must equal ours outside the slot (B2),
 * spliced at the recorded offset; then budgets, `finalize()`, and the txid
 * asserted unchanged.
 */

import { bytesEqual, fromHex, parseSigScriptPushes, toHex } from '@kasseal/codec';
import { P2PK_PLACEHOLDER_SIGSCRIPT, SCHNORR_SIG_LENGTH } from '../sigscript.ts';
import type { InputToSign } from '../types.ts';
import { addressOfScript, addressPrefixOf } from './address.ts';
import { SIGHASH_ALL, sighash, splitScriptPublicKey, type SighashTx } from './sighash.ts';

/** A built transaction cannot be turned into a safe sign request, or the wallet's answer does not match it. */
export class SignRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignRequestError';
  }
}

/** One entry of Kaspire's `signInputs`. */
export interface SignInput {
  /** Input index. */
  readonly index: number;
  /** SIGHASH_ALL. */
  readonly sighashType: 1;
}

/** One entry of Kaspire's `scripts[]` for the prebuilt-signature path (B2). */
export interface PrebuiltScript {
  readonly inputIndex: number;
  readonly scriptHex: '';
  readonly prebuiltSignatureScript: string;
  readonly signatureOffsets: readonly number[];
  readonly expectedSighash: string;
}

/** A sign request ready for the wallet, with what the answer is checked against. */
export interface PreparedSignRequest {
  /** The SafeJSON the wallet signs: inputs to sign emptied, UTXO addresses filled. */
  readonly txJson: string;
  /** The built transaction's id; the signed one must keep it. */
  readonly txid: string;
  /** The inputs the wallet signs. */
  readonly signInputs: readonly SignInput[];
  /** One per P2SH input to sign, in input order; used by the B2 request only. */
  readonly prebuilt: readonly PrebuiltScript[];
}

interface JsonInput {
  transactionId: string;
  index: number;
  sequence: string | number;
  signatureScript?: string;
  utxo?: { address?: string | null; amount: string | number; scriptPublicKey: string; covenantId?: string | null; isCoinbase?: boolean } | null;
}

interface JsonTx {
  id?: string;
  inputs: JsonInput[];
}

/**
 * Offsets at which a 65-byte signature can sit in a push-only sigscript: the payload of a 65-byte push (a P2PK
 * signature, a signed delegator's witness) or the payload after the path byte `00` of a 66-byte push (a signed
 * leader's witness `00 || sig65`).
 */
export function signatureSlotsOf(script: Uint8Array): number[] {
  const slots: number[] = [];
  for (const p of parseSigScriptPushes(script)) {
    if (p.payload.length === SCHNORR_SIG_LENGTH) slots.push(p.dataOffset);
    else if (p.payload.length === SCHNORR_SIG_LENGTH + 1 && p.payload[0] === 0x00) slots.push(p.dataOffset + 1);
  }
  return slots;
}

/** Asserts that `offset` is a signature slot of `script` and that the slot is empty (65 zero bytes). */
export function assertEmptySignatureSlot(script: Uint8Array, offset: number, index: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset + SCHNORR_SIG_LENGTH > script.length) {
    throw new SignRequestError(`input ${index}: signature offset ${offset} outside the ${script.length}-byte sigscript`);
  }
  let slots: number[];
  try {
    slots = signatureSlotsOf(script);
  } catch (e) {
    throw new SignRequestError(`input ${index}: sigscript is not push-only: ${(e as Error).message}`);
  }
  if (!slots.includes(offset)) throw new SignRequestError(`input ${index}: offset ${offset} is not a signature slot of the sigscript (slots ${slots.join(', ') || 'none'})`);
  if (script.subarray(offset, offset + SCHNORR_SIG_LENGTH).some((b) => b !== 0)) throw new SignRequestError(`input ${index}: signature slot at ${offset} is not empty`);
}

/** The request the wallet signs for `inputs` of a built SafeJSON transaction (see the module comment). */
export function prepareSignRequest(txJson: string, inputs: readonly InputToSign[], { networkId }: { networkId: string }): PreparedSignRequest {
  let tx: JsonTx;
  try {
    tx = JSON.parse(txJson) as JsonTx;
  } catch (e) {
    throw new SignRequestError(`transaction JSON does not parse: ${(e as Error).message}`);
  }
  if (!Array.isArray(tx.inputs)) throw new SignRequestError('transaction JSON has no inputs');
  if (typeof tx.id !== 'string' || !/^[0-9a-f]{64}$/.test(tx.id)) throw new SignRequestError('transaction JSON has no transaction id');
  if (inputs.length === 0) throw new SignRequestError('no inputs to sign');
  const prefix = addressPrefixOf(networkId);

  const seen = new Set<number>();
  const prebuilt: PrebuiltScript[] = [];
  const unsigned = JSON.parse(txJson) as JsonTx;
  for (const req of [...inputs].sort((a, b) => a.index - b.index)) {
    const i = req.index;
    const input = unsigned.inputs[i];
    if (!Number.isInteger(i) || input === undefined) throw new SignRequestError(`input ${i} does not exist (${unsigned.inputs.length} inputs)`);
    if (seen.has(i)) throw new SignRequestError(`input ${i} listed twice`);
    seen.add(i);
    if (req.sighashType !== SIGHASH_ALL) throw new SignRequestError(`input ${i}: sighash type ${String(req.sighashType)} is not SIGHASH_ALL (1)`);
    if (!input.utxo) throw new SignRequestError(`input ${i} has no UTXO entry`);
    if (input.utxo.isCoinbase === true) throw new SignRequestError(`input ${i} spends a coinbase output`);
    const script = fromHex(input.signatureScript ?? '');
    if (req.kind === 'p2pk') {
      if (script.length !== 0 && !bytesEqual(script, P2PK_PLACEHOLDER_SIGSCRIPT)) throw new SignRequestError(`input ${i}: P2PK input does not hold the builder placeholder`);
      if (req.signatureOffset !== undefined && req.signatureOffset !== 1) throw new SignRequestError(`input ${i}: P2PK signature offset ${req.signatureOffset}`);
    } else {
      if (req.signatureOffset === undefined) throw new SignRequestError(`input ${i}: ${req.kind} without a signature offset`);
      if (typeof input.utxo.covenantId !== 'string' || !/^[0-9a-f]{64}$/.test(input.utxo.covenantId)) throw new SignRequestError(`input ${i}: covenant input without utxo.covenantId`);
      assertEmptySignatureSlot(script, req.signatureOffset, i);
      prebuilt.push({ inputIndex: i, scriptHex: '', prebuiltSignatureScript: toHex(script), signatureOffsets: [req.signatureOffset], expectedSighash: '' });
    }
    input.signatureScript = '';
  }
  for (const [k, input] of unsigned.inputs.entries()) {
    if (input.utxo && (input.utxo.address === null || input.utxo.address === undefined)) {
      const address = addressOfScript(splitScriptPublicKey(input.utxo.scriptPublicKey).script, prefix);
      if (address === undefined) throw new SignRequestError(`input ${k}: UTXO script has no address form`);
      input.utxo.address = address;
    }
  }
  const requestJson = JSON.stringify(unsigned);
  const forSighash = unsigned as unknown as SighashTx;
  return {
    txJson: requestJson,
    txid: tx.id,
    signInputs: [...seen].sort((a, b) => a - b).map((index) => ({ index, sighashType: SIGHASH_ALL })),
    prebuilt: prebuilt.map((p) => ({ ...p, expectedSighash: sighash(forSighash, p.inputIndex, SIGHASH_ALL) })),
  };
}

/** The wallet's answer as a SafeJSON string: the legacy shape returns the string, the normalized `{ psktTransactionJson }`. */
export function signedTxJsonOf(response: unknown): string {
  if (typeof response === 'string') return response;
  if (response !== null && typeof response === 'object' && 'psktTransactionJson' in response) {
    const v = (response as { psktTransactionJson: unknown }).psktTransactionJson;
    if (typeof v === 'string') return v;
    if (v !== null && typeof v === 'object') return JSON.stringify(v);
  }
  throw new SignRequestError('wallet returned neither a SafeJSON string nor { psktTransactionJson }');
}

/**
 * Checks that a signed answer is the requested transaction with only the requested inputs' signature scripts set: the
 * same id, input count and outpoints, and every other input's script unchanged. `finalizeSigned` re-checks the txid
 * from the bytes; this check runs first so a wrong answer is reported against the request.
 */
export function assertAnswerMatchesRequest(request: PreparedSignRequest, signedJson: string): void {
  let signed: JsonTx;
  try {
    signed = JSON.parse(signedJson) as JsonTx;
  } catch (e) {
    throw new SignRequestError(`signed transaction does not parse: ${(e as Error).message}`);
  }
  const req = JSON.parse(request.txJson) as JsonTx;
  if (signed.id !== request.txid) throw new SignRequestError(`signed transaction id ${String(signed.id)} is not the requested ${request.txid}`);
  if (!Array.isArray(signed.inputs) || signed.inputs.length !== req.inputs.length) throw new SignRequestError('signed transaction has another input count');
  const selected = new Set(request.signInputs.map((s) => s.index));
  req.inputs.forEach((r, i) => {
    const s = signed.inputs[i]!;
    if (s.transactionId !== r.transactionId || Number(s.index) !== Number(r.index)) throw new SignRequestError(`signed input ${i} spends another outpoint`);
    if (!selected.has(i) && (s.signatureScript ?? '') !== (r.signatureScript ?? '')) throw new SignRequestError(`the wallet changed the sigscript of input ${i}, which it was not asked to sign`);
    if (selected.has(i) && (s.signatureScript ?? '') === '') throw new SignRequestError(`the wallet did not sign input ${i}`);
  });
}
