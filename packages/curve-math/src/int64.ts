/**
 * Checked 64-bit arithmetic. The covenant VM computes in KCC-1 `int`, so every intermediate the contract will form is
 * computed here through `checked`, and an overflow raises instead of
 * producing a value the chain could never produce.
 */

import { ArgumentError, OverflowError } from './errors.ts';

/** KCC-1 sec 3.4.3: -(2^63 - 1) <= value <= 2^63 - 1. */
export const INT_MAX = (1n << 63n) - 1n;
/** The smallest KCC-1 int: -(2^63 - 1). */
export const INT_MIN = -INT_MAX;

/** Throw `ArgumentError` unless `value` is a bigint; `what` names it in the message. */
export function assertBigint(value: unknown, what: string): asserts value is bigint {
  if (typeof value !== 'bigint') throw new ArgumentError(`${what} must be a bigint, got ${typeof value}`);
}

/** Return `value` if it is inside the int range, else throw. */
export function checked(value: bigint, what: string): bigint {
  if (value > INT_MAX || value < INT_MIN) throw new OverflowError(`${what} = ${value} leaves the KCC-1 int range`);
  return value;
}

/** `a + b`, throwing `OverflowError` outside the KCC-1 int range. */
export function add(a: bigint, b: bigint, what: string): bigint {
  return checked(a + b, what);
}

/** `a - b`, throwing `OverflowError` outside the KCC-1 int range. */
export function sub(a: bigint, b: bigint, what: string): bigint {
  return checked(a - b, what);
}

/** `a * b`, throwing `OverflowError` outside the KCC-1 int range. */
export function mul(a: bigint, b: bigint, what: string): bigint {
  return checked(a * b, what);
}

/** floor(a / b) for a >= 0, b > 0. */
export function floorDiv(a: bigint, b: bigint): bigint {
  assertBigint(a, 'dividend');
  assertBigint(b, 'divisor');
  if (a < 0n) throw new ArgumentError(`floorDiv dividend must be non-negative, got ${a}`);
  if (b <= 0n) throw new ArgumentError(`floorDiv divisor must be positive, got ${b}`);
  return a / b;
}

/** ceil(a / b) for a >= 0, b > 0: the curve's fee rounding. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  assertBigint(a, 'dividend');
  assertBigint(b, 'divisor');
  if (a < 0n) throw new ArgumentError(`ceilDiv dividend must be non-negative, got ${a}`);
  if (b <= 0n) throw new ArgumentError(`ceilDiv divisor must be positive, got ${b}`);
  return (a + b - 1n) / b;
}
