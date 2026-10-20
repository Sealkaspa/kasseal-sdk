/**
 * From an assembled transaction to the serialisable `BuiltTx`, and from a
 * wallet's signed transaction back to a final one.
 *
 * `toBuiltTx`: SDK SafeJSON with `utxo.covenantId` patched into every covenant
 * input (the SDK always serialises it as null; Kaspire's prebuilt path needs
 * it), the inputs to sign with their kind and signature slot, the
 * budgets from the table, and the txid, asserted equal to our own KIP-24
 * `txidV1`.
 *
 * `finalize(built, signed)`:
 *   1. the signed transaction must be the built one: same txid (the txid
 *      covers outpoints, outputs, bindings, lock time, subnetwork, gas and
 *      payload, and neither sigscripts nor budgets), recomputed with `txidV1`
 *      and compared with the SDK's;
 *   2. every input the wallet was not asked to sign keeps the builder's
 *      sigscript byte for byte;
 *   3. a `p2pk` input takes the wallet's `41 || sig64 || 01`; a P2SH input
 *      (`p2sh-leader`, `p2sh-delegator`) takes the 65-byte `sig64 || 01`,
 *      extracted from the wallet's P2PK-style answer (Kaspire B1) or from a
 *      returned prebuilt script that equals ours outside the slot (B2), and
 *      spliced at `signatureOffset`; the hashtype byte must be SIGHASH_ALL;
 *   4. the budgets of `built.budgets` are applied after signing, whatever the
 *      wallet returned (budgets are outside the sighash and the txid);
 *   5. every requested signature verifies (BIP-340) against the sighash of the
 *      built transaction and the signer's x-only key: the connected account's
 *      when the caller names it, else the key of a P2PK input's own script
 *      (a wallet's invalid signature is refused here, with
 *      that reason, rather than by the node as a script failure);
 *   6. `finalize()`; the SDK's txid, our `txidV1` and `built.txid` must agree,
 *      and the mass model over the final transaction must equal `built.masses`
 *      (a signature of another length would change the fee).
 *
 * The SDK's `createInputSignature` is never a witness source here: wallet
 * answers go through `signatureFromP2pkSigScript`.
 */

import { bytesEqual, fromHex, toHex, txidV1 } from '@kasseal/codec';
import type { AssembledTx } from './assemble.ts';
import { plainTxFromSdk } from './kip24.ts';
import { masses as massesOf, type Masses, type TxShape } from './mass.ts';
import { schnorrVerify } from './bip340.ts';
import { SCHNORR_SIG_LENGTH, signatureFromP2pkSigScript, spliceSignature } from './sigscript.ts';
import { sighashOfTxJson } from './wallet/sighash.ts';
import { sdk, type SdkPrivateKey, type SdkTransaction } from './sdk.ts';
import type { BuiltTx, InputToSign, OptimisticDelta, OutputRole } from './types.ts';

const SIGHASH_ALL = 0x01;

/** A wallet's answer does not finalize into the built transaction (other txid, changed inputs, a bad signature). */
export class FinalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FinalizeError';
  }
}

interface SafeJsonInput {
  utxo?: { covenantId?: string | null; amount?: string | number; scriptPublicKey?: string } | null;
  signatureScript?: string;
  computeBudget?: number | string;
}

/** SafeJSON of an SDK transaction with `utxo.covenantId` set on the inputs that spend covenant cells. */
export function safeJsonWithCovenantIds(tx: SdkTransaction, covenantIds: readonly (string | undefined)[]): string {
  const j = JSON.parse(tx.serializeToSafeJSON()) as { inputs: SafeJsonInput[] };
  if (j.inputs.length !== covenantIds.length) throw new FinalizeError(`covenant ids for ${covenantIds.length} inputs, transaction has ${j.inputs.length}`);
  j.inputs.forEach((inp, i) => {
    const id = covenantIds[i];
    if (id === undefined) return;
    if (!inp.utxo) throw new FinalizeError(`input ${i} has no UTXO entry to carry its covenant id`);
    inp.utxo.covenantId = id;
  });
  return JSON.stringify(j);
}

/** The serialisable form of an assembled transaction. `produces` and `optimistic` come from the shape that built it. */
export function toBuiltTx(
  a: AssembledTx,
  extras: { readonly feerate: bigint; readonly produces: BuiltTx['produces']; readonly optimistic: OptimisticDelta },
): BuiltTx {
  const own = txidV1(plainTxFromSdk(a.tx)).txid;
  if (own !== a.tx.id || own !== a.txid) throw new FinalizeError(`${a.plan.name}: txidV1 ${own}, SDK ${a.tx.id}, assembled ${a.txid}`);
  const inputsToSign: InputToSign[] = a.inputsToSign.map(({ index, slot }) => {
    if (slot.kind === 'p2pk') return { index, kind: 'p2pk', sighashType: 1 };
    return { index, kind: slot.kind === 'token-leader' ? 'p2sh-leader' : 'p2sh-delegator', sighashType: 1, signatureOffset: slot.offset };
  });
  for (const p of extras.produces) {
    if (!Number.isInteger(p.index) || p.index < 0 || p.index >= a.outputs.length) throw new FinalizeError(`${a.plan.name}: produces names output ${p.index} of ${a.outputs.length}`);
  }
  return {
    txJson: safeJsonWithCovenantIds(a.tx, a.plan.inputs.map((i) => i.covenantId)),
    txid: a.txid,
    masses: a.masses,
    feeSompi: a.fee,
    feerate: extras.feerate,
    inputsToSign,
    budgets: [...a.budgets],
    consumes: a.plan.inputs.map((i) => ({ txid: i.outpoint.txid, index: i.outpoint.index })),
    produces: extras.produces,
    optimistic: extras.optimistic,
  };
}

/** The mass-model shape of a SafeJSON transaction (UTXO entries carry amount, script and the patched covenant id). */
export function shapeOfSafeJson(txJson: string): TxShape {
  const j = JSON.parse(txJson) as { inputs: SafeJsonInput[]; outputs: { scriptPublicKey: string; value: string | number; covenant?: unknown }[]; payload?: string };
  return {
    inputs: j.inputs.map((i, k) => {
      if (!i.utxo || i.utxo.amount === undefined || i.utxo.scriptPublicKey === undefined) throw new FinalizeError(`input ${k} has no UTXO entry`);
      return {
        sigScriptLength: (i.signatureScript ?? '').length / 2,
        computeBudget: Number(i.computeBudget ?? 0),
        amount: BigInt(i.utxo.amount),
        spkLength: spkScriptLength(i.utxo.scriptPublicKey),
        hasCovenant: typeof i.utxo.covenantId === 'string' && i.utxo.covenantId.length > 0,
      };
    }),
    outputs: j.outputs.map((o) => ({ value: BigInt(o.value), spkLength: spkScriptLength(o.scriptPublicKey), hasCovenant: o.covenant !== null && o.covenant !== undefined })),
    payloadLength: (j.payload ?? '').length / 2,
  };
}

/** SafeJSON `scriptPublicKey` is `u16 LE version || script`, hex. */
function spkScriptLength(hex: string): number {
  if (hex.length < 4 || hex.length % 2 !== 0) throw new FinalizeError(`malformed scriptPublicKey ${hex.slice(0, 16)}`);
  return hex.length / 2 - 2;
}

/** The 65-byte signature a wallet produced for a P2SH input: from a P2PK-style answer (B1) or a filled prebuilt script (B2). */
function p2shSignature(prebuilt: Uint8Array, returned: Uint8Array, offset: number, index: number): Uint8Array {
  if (returned.length === 66 && returned[0] === 0x41) return signatureFromP2pkSigScript(returned);
  if (returned.length === prebuilt.length) {
    if (!bytesEqual(returned.subarray(0, offset), prebuilt.subarray(0, offset)) || !bytesEqual(returned.subarray(offset + SCHNORR_SIG_LENGTH), prebuilt.subarray(offset + SCHNORR_SIG_LENGTH))) {
      throw new FinalizeError(`input ${index}: the returned script differs from the prebuilt one outside the signature slot`);
    }
    return returned.subarray(offset, offset + SCHNORR_SIG_LENGTH);
  }
  throw new FinalizeError(`input ${index}: unexpected wallet answer of ${returned.length} bytes for a P2SH input`);
}

/** The x-only key of a P2PK script public key in SafeJSON form (`u16 version || 20 <32 bytes> ac`), else undefined. */
function p2pkKeyOf(spkHex: string | undefined): Uint8Array | undefined {
  if (spkHex === undefined || spkHex.length !== 4 + 68) return undefined;
  const script = fromHex(spkHex.slice(4));
  return script[0] === 0x20 && script[33] === 0xac ? script.subarray(1, 33) : undefined;
}

/** Options of `finalize` / `finalizeSigned`. */
export interface FinalizeOptions {
  /** The signing account's x-only key (hex): every requested signature must verify against it. */
  readonly signer?: string | undefined;
}

/** Synchronous core of `finalize`; returns the final `BuiltTx` (txJson of the final transaction, budgets applied). */
export function finalizeSigned(built: BuiltTx, signed: string, options: FinalizeOptions = {}): BuiltTx {
  const k = sdk();
  const ours = k.Transaction.deserializeFromSafeJSON(built.txJson);
  let theirs: SdkTransaction;
  try {
    theirs = k.Transaction.deserializeFromSafeJSON(signed);
  } catch (e) {
    throw new FinalizeError(`signed transaction does not parse: ${(e as Error).message}`);
  }
  // 1. Same transaction: the txid covers everything but sigscripts and budgets.
  const signedTxid = txidV1(plainTxFromSdk(theirs)).txid;
  if (signedTxid !== built.txid) throw new FinalizeError(`signed transaction has txid ${signedTxid}, built ${built.txid}: the wallet changed outpoints, outputs, bindings or payload`);
  const ourInputs = ours.inputs;
  const theirInputs = theirs.inputs;
  if (theirInputs.length !== ourInputs.length || theirInputs.length !== built.budgets.length) throw new FinalizeError('input count changed');

  const toSign = new Map(built.inputsToSign.map((s) => [s.index, s]));
  for (const s of built.inputsToSign) if (s.index < 0 || s.index >= ourInputs.length) throw new FinalizeError(`inputsToSign names input ${s.index} of ${ourInputs.length}`);

  const scripts: Uint8Array[] = ourInputs.map((inp, i) => {
    const prebuilt = fromHex(inp.signatureScript ?? '');
    const returned = fromHex(theirInputs[i]!.signatureScript ?? '');
    const req = toSign.get(i);
    // 2. Inputs the wallet was not asked to sign are ours, byte for byte.
    if (req === undefined) {
      if (!bytesEqual(prebuilt, returned)) throw new FinalizeError(`input ${i}: the wallet changed a sigscript it was not asked to sign`);
      return prebuilt;
    }
    // 3. Signed inputs.
    if (req.kind === 'p2pk') {
      if (returned.length !== 66 || returned[0] !== 0x41) throw new FinalizeError(`input ${i}: P2PK signature script must be 41 || sig64 || hashtype, got ${returned.length} bytes`);
      if (returned[65] !== SIGHASH_ALL) throw new FinalizeError(`input ${i}: hashtype 0x${returned[65]!.toString(16)} is not SIGHASH_ALL`);
      if (returned.subarray(1, 65).every((b) => b === 0)) throw new FinalizeError(`input ${i}: unsigned`);
      return returned;
    }
    const offset = req.signatureOffset;
    if (offset === undefined) throw new FinalizeError(`input ${i}: ${req.kind} without a signature offset`);
    if (prebuilt.subarray(offset, offset + SCHNORR_SIG_LENGTH).some((b) => b !== 0)) throw new FinalizeError(`input ${i}: prebuilt slot at ${offset} is not zero-filled`);
    const sig65 = p2shSignature(prebuilt, returned, offset, i);
    if (sig65[64] !== SIGHASH_ALL) throw new FinalizeError(`input ${i}: hashtype 0x${sig65[64]!.toString(16)} is not SIGHASH_ALL`);
    if (sig65.subarray(0, 64).every((b) => b === 0)) throw new FinalizeError(`input ${i}: unsigned`);
    const spliced = spliceSignature(prebuilt, offset, sig65);
    if (!bytesEqual(spliced.subarray(0, offset), prebuilt.subarray(0, offset)) || !bytesEqual(spliced.subarray(offset + SCHNORR_SIG_LENGTH), prebuilt.subarray(offset + SCHNORR_SIG_LENGTH))) {
      throw new FinalizeError(`input ${i}: splice moved bytes outside the slot`);
    }
    return spliced;
  });

  // 5 (before anything is applied). Every requested signature is valid for this transaction and its signer.
  const utxoSpks = (JSON.parse(built.txJson) as { inputs: SafeJsonInput[] }).inputs.map((i) => i.utxo?.scriptPublicKey);
  const signer = options.signer === undefined ? undefined : fromHex(options.signer);
  for (const req of built.inputsToSign) {
    const key = signer ?? (req.kind === 'p2pk' ? p2pkKeyOf(utxoSpks[req.index]) : undefined);
    if (key === undefined) continue;
    const at = req.kind === 'p2pk' ? 1 : req.signatureOffset!;
    const sig64 = scripts[req.index]!.subarray(at, at + 64);
    if (!schnorrVerify(key, fromHex(sighashOfTxJson(built.txJson, req.index)), sig64)) {
      throw new FinalizeError(`input ${req.index}: the wallet returned an invalid signature`);
    }
  }
  // 4. Sigscripts and budgets onto our transaction (never the wallet's object: only signatures are taken from it).
  ourInputs.forEach((inp, i) => {
    inp.signatureScript = toHex(scripts[i]!);
    inp.computeBudget = built.budgets[i]!;
  });
  ours.inputs = ourInputs;
  // 5. Finalize and agree on the txid three ways.
  ours.finalize();
  const own = txidV1(plainTxFromSdk(ours)).txid;
  if (own !== ours.id || own !== built.txid) throw new FinalizeError(`after finalize: txidV1 ${own}, SDK ${ours.id}, built ${built.txid}`);

  const covenantIds = (JSON.parse(built.txJson) as { inputs: SafeJsonInput[] }).inputs.map((i) => (typeof i.utxo?.covenantId === 'string' ? i.utxo.covenantId : undefined));
  const txJson = safeJsonWithCovenantIds(ours, covenantIds);
  const m: Masses = massesOf(shapeOfSafeJson(txJson));
  if (m.max !== built.masses.max || m.bytes !== built.masses.bytes || m.compute !== built.masses.compute || m.storage !== built.masses.storage) {
    throw new FinalizeError(`final masses ${JSON.stringify({ ...m, minFee: String(m.minFee) })} differ from the built masses`);
  }
  return { ...built, txJson, masses: m };
}

/** `TxBuilder.finalize`: see the module comment. */
export async function finalize(built: BuiltTx, signed: string, options: FinalizeOptions = {}): Promise<BuiltTx> {
  return finalizeSigned(built, signed, options);
}

/**
 * `TxBuilder.estimate`: the mass model over the built transaction with its table budgets (pure; no SDK). `feeSompi`
 * is the model's minimum fee, the number `assemble` pays before any margin.
 */
export function estimateBuilt(built: BuiltTx): { masses: Masses; feeSompi: bigint } {
  const shape = shapeOfSafeJson(built.txJson);
  if (shape.inputs.length !== built.budgets.length) throw new FinalizeError('budgets do not match the inputs');
  const m = massesOf({ ...shape, inputs: shape.inputs.map((i, k) => ({ ...i, computeBudget: built.budgets[k]! })) });
  return { masses: m, feeSompi: m.minFee };
}

/** The role list of a built transaction, for `toBuiltTx` callers that label outputs positionally. */
export function rolesByIndex(roles: readonly (OutputRole | undefined)[]): BuiltTx['produces'] {
  return roles.flatMap((role, index) => (role === undefined ? [] : [{ index, role }]));
}

/**
 * Sign a built transaction's wallet inputs with one local key (for server-side signers that hold their own funding
 * key): every `inputsToSign` slot must be a plain P2PK input of that key, signed `SIGHASH_ALL` as the SDK's
 * `createInputSignature` computes it; the result goes through `finalizeSigned`, so the txid, every other input and
 * the budgets are checked unchanged. Refuses a P2SH slot (a covenant leader belongs to a wallet, never to a service key).
 */
export function signBuiltWithKey(built: BuiltTx, key: SdkPrivateKey): BuiltTx {
  const k = sdk();
  const tx = k.Transaction.deserializeFromSafeJSON(built.txJson);
  const ins = tx.inputs;
  for (const s of built.inputsToSign) {
    if (s.kind !== 'p2pk') throw new FinalizeError(`input ${s.index} is a ${s.kind} slot: a service key signs P2PK funding inputs only`);
    // The P2PK sigscript is one 65-byte push (sig64 || hashtype); its layout is checked before it is set.
    const sig = signatureFromP2pkSigScript(k.createInputSignature(tx, s.index, key, k.SighashType.All));
    ins[s.index]!.signatureScript = toHex(Uint8Array.of(0x41, ...sig));
  }
  tx.inputs = ins;
  return finalizeSigned(built, tx.serializeToSafeJSON());
}
