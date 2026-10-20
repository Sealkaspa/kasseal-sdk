/**
 * The fee and masses of a serialised transaction, from its bytes alone.
 *
 * A pre-broadcast checker that compares the fee with `BuiltTx.feeSompi` or bounds it with `BuiltTx.masses` trusts two
 * fields of the object it is meant to check: a serialisation with a cut change output and edited figures passes. These
 * helpers read only `txJson`: the fee is `sum(utxo amounts) - sum(output values)`, the masses come from the mass
 * model over the serialised shape (sigscripts, compute budgets, scripts, bindings, payload), and the bound is the model
 * fee at a feerate the caller chooses (its own, never the object's).
 */

import { shapeOfSafeJson } from './finalize.ts';
import { FEERATE_MAX_SOMPI_PER_GRAM, feeCeiling, masses as massesOf, type Masses } from './mass.ts';

/** A serialised transaction's fee and masses, computed from its bytes alone. */
export interface BytesFee {
  /** `totalIn - totalOut`, from the UTXO entries and outputs of the serialisation. */
  readonly fee: bigint;
  /** Sum of the spent UTXOs' amounts, sompi. */
  readonly totalIn: bigint;
  /** Sum of the outputs' values, sompi. */
  readonly totalOut: bigint;
  /** The mass model over the serialised shape (its own compute budgets). */
  readonly masses: Masses;
  /** The compute budget of each input, as serialised. */
  readonly budgets: readonly number[];
}

/** The fee and masses of `txJson` (Kaspa SDK SafeJSON), from its bytes alone. */
export function feeFromBytes(txJson: string): BytesFee {
  const shape = shapeOfSafeJson(txJson);
  const totalIn = shape.inputs.reduce((a, i) => a + i.amount, 0n);
  const totalOut = shape.outputs.reduce((a, o) => a + o.value, 0n);
  return { fee: totalIn - totalOut, totalIn, totalOut, masses: massesOf(shape), budgets: shape.inputs.map((i) => i.computeBudget) };
}

/**
 * Why the fee of `b` is outside the model, or undefined when it is inside: at least the model's minimum fee (100
 * sompi/g of the largest mass), at most `maxFeerate` sompi/g of it plus `margin`, and never above `feeCeiling`.
 * `maxFeerate` defaults to the builder's cap (`FEERATE_MAX_SOMPI_PER_GRAM`); a caller that knows the feerate it built
 * with passes that.
 */
export function feeOutsideModel(b: BytesFee, maxFeerate: bigint = FEERATE_MAX_SOMPI_PER_GRAM, margin = 0n): string | undefined {
  if (b.fee < b.masses.minFee) return `the fee ${b.fee} sompi is below the model minimum ${b.masses.minFee} for mass ${b.masses.max}`;
  const most = BigInt(b.masses.max) * maxFeerate + margin;
  if (b.fee > most) return `the fee ${b.fee} sompi is above ${most} (mass ${b.masses.max} at ${maxFeerate} sompi/g${margin > 0n ? ` + ${margin}` : ''})`;
  if (b.fee > feeCeiling(b.masses.minFee)) return `the fee ${b.fee} sompi is above the builder's ceiling ${feeCeiling(b.masses.minFee)}`;
  return undefined;
}
