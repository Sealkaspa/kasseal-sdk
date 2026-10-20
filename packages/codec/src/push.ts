/**
 * KCC1 encoding primitives.
 *
 * Sources (verified against kaspanet/kccs, commit da834af; section numbers
 * are the ones of that commit):
 *   KCC1 sec 3.4.2  data pushes (PushMinimal vs PushExplicit)
 *   KCC1 sec 3.4.3  integers: an `int` STATE payload is eight-byte little-endian
 *                   SIGNED-MAGNITUDE (not two's complement)
 *   KCC1 sec 3.4.4  scalar payloads (bool is exactly 00 or 01)
 *   KCC1 sec 3.7.1  EncodeState = concat of PushExplicit(StatePayload(field))
 *
 * KCC1 sec 3.7.1 is strict: "For a decoded field of type T and value v, the
 * consumed bytes MUST exactly equal PushExplicit(StatePayload(T, v))." So a
 * decoder must reject non-canonical pushes, not merely parse them.
 *
 * Error classes: anything that rejects BYTES we were asked to read is a
 * DecodeError; anything that rejects a VALUE we were asked to write is a
 * ValidationError. Encode-side range failures must never masquerade as
 * malformed input.
 */

import { DecodeError, ValidationError } from './errors.ts';

/** Opcode OP_0 (push empty). */
export const OP_0 = 0x00;
/** Opcode OP_PUSHDATA1 (1-byte length follows). */
export const OP_PUSHDATA1 = 0x4c;
/** Opcode OP_PUSHDATA2 (2-byte little-endian length follows). */
export const OP_PUSHDATA2 = 0x4d;
/** Opcode OP_PUSHDATA4 (4-byte little-endian length follows). */
export const OP_PUSHDATA4 = 0x4e;
/** Opcode OP_1NEGATE (push -1). */
export const OP_1NEGATE = 0x4f;
/** Opcode OP_1 (push 1; OP_2..OP_16 follow). */
export const OP_1 = 0x51;

const MAX_DIRECT_PUSH = 75;

/**
 * PushExplicit(b) -- KCC1 sec 3.4.2. Unlike PushMinimal it never uses the small
 * numeric opcodes (OP_1..OP_16, OP_1NEGATE) for one-byte payloads, so a
 * 1-byte payload always encodes as `01 <byte>`.
 */
export function encodePushExplicit(payload: Uint8Array): Uint8Array {
  const n = payload.length;
  if (n === 0) return Uint8Array.of(OP_0);
  if (n <= MAX_DIRECT_PUSH) return concat(Uint8Array.of(n), payload);
  if (n <= 0xff) return concat(Uint8Array.of(OP_PUSHDATA1, n), payload);
  if (n <= 0xffff) return concat(Uint8Array.of(OP_PUSHDATA2, n & 0xff, n >>> 8), payload);
  if (n <= 0xffff_ffff) {
    return concat(
      Uint8Array.of(OP_PUSHDATA4, n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff),
      payload,
    );
  }
  throw new ValidationError(`payload too large to push: ${n} bytes`);
}

/**
 * PushMinimal(b) -- KCC1 sec 3.4.2, the form invocation arguments use. It
 * differs from PushExplicit only for one-byte payloads `01..10` (OP_1..OP_16)
 * and `81` (OP_1NEGATE).
 */
export function encodePushMinimal(payload: Uint8Array): Uint8Array {
  if (payload.length === 1) {
    const b = payload[0]!;
    if (b >= 0x01 && b <= 0x10) return Uint8Array.of(OP_1 + b - 1);
    if (b === 0x81) return Uint8Array.of(OP_1NEGATE);
  }
  return encodePushExplicit(payload);
}

/** One push read from a buffer. */
export interface ReadPush {
  /** The pushed bytes. */
  readonly payload: Uint8Array;
  /** Absolute offset immediately after the consumed push. */
  readonly next: number;
}

/**
 * Read exactly one PushExplicit at `offset`. Rejects any encoding that is not
 * the canonical PushExplicit form for the payload it carries.
 */
export function readPushExplicit(buf: Uint8Array, offset: number): ReadPush {
  if (offset >= buf.length) {
    throw new DecodeError(`truncated: expected a push at offset ${offset}, buffer is ${buf.length} bytes`);
  }
  const op = buf[offset]!;

  if (op === OP_0) return { payload: new Uint8Array(0), next: offset + 1 };

  let n: number;
  let headerLen: number;
  if (op <= MAX_DIRECT_PUSH) {
    n = op;
    headerLen = 1;
  } else if (op === OP_PUSHDATA1) {
    n = need(buf, offset + 1, 1)[0]!;
    headerLen = 2;
    if (n <= MAX_DIRECT_PUSH) throw nonCanonical(op, n, offset);
  } else if (op === OP_PUSHDATA2) {
    const b = need(buf, offset + 1, 2);
    n = b[0]! | (b[1]! << 8);
    headerLen = 3;
    if (n <= 0xff) throw nonCanonical(op, n, offset);
  } else if (op === OP_PUSHDATA4) {
    const b = need(buf, offset + 1, 4);
    n = (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
    headerLen = 5;
    if (n <= 0xffff) throw nonCanonical(op, n, offset);
  } else {
    // OP_1..OP_16 / OP_1NEGATE and everything else are PushMinimal-only forms.
    throw new DecodeError(
      `offset ${offset}: opcode 0x${op.toString(16).padStart(2, '0')} is not a PushExplicit data push`,
    );
  }

  const start = offset + headerLen;
  const payload = need(buf, start, n);
  return { payload, next: start + n };
}

function nonCanonical(op: number, n: number, offset: number): DecodeError {
  return new DecodeError(
    `offset ${offset}: non-canonical push -- opcode 0x${op.toString(16)} used for a ${n}-byte payload`,
  );
}

function need(buf: Uint8Array, start: number, len: number): Uint8Array {
  if (start + len > buf.length) {
    throw new DecodeError(`truncated: need ${len} bytes at offset ${start}, have ${buf.length - start}`);
  }
  return buf.subarray(start, start + len);
}

/* -------------------------------------------------------------------------- */
/* Scalar payloads (KCC1 sec 3.4.3 / 3.4.4)                                    */
/* -------------------------------------------------------------------------- */

/** Width of an `int` state payload, in bytes. */
export const INT_STATE_WIDTH = 8;
/** KCC1 sec 3.4.3: -(2^63 - 1) <= value <= 2^63 - 1. */
export const INT_MAX = (1n << 63n) - 1n;
/** The smallest KCC-1 int: -(2^63 - 1). */
export const INT_MIN = -INT_MAX;

/** Encode an `int` state payload: 8-byte little-endian signed-magnitude. */
export function encodeIntState(value: bigint): Uint8Array {
  if (typeof value !== 'bigint') {
    throw new ValidationError(`int state value must be a bigint, got ${typeof value}`);
  }
  if (value > INT_MAX || value < INT_MIN) {
    throw new ValidationError(`int out of KCC1 range: ${value}`);
  }
  const negative = value < 0n;
  let magnitude = negative ? -value : value;
  const out = new Uint8Array(INT_STATE_WIDTH);
  for (let i = 0; i < INT_STATE_WIDTH; i++) {
    out[i] = Number(magnitude & 0xffn);
    magnitude >>= 8n;
  }
  if (negative) out[INT_STATE_WIDTH - 1]! |= 0x80;
  return out;
}

/** Decode an `int` state payload. Rejects wrong width and negative zero. */
export function decodeIntState(payload: Uint8Array): bigint {
  if (payload.length !== INT_STATE_WIDTH) {
    throw new DecodeError(`int state payload must be ${INT_STATE_WIDTH} bytes, got ${payload.length}`);
  }
  const negative = (payload[INT_STATE_WIDTH - 1]! & 0x80) !== 0;
  let magnitude = 0n;
  for (let i = INT_STATE_WIDTH - 1; i >= 0; i--) {
    const b = i === INT_STATE_WIDTH - 1 ? payload[i]! & 0x7f : payload[i]!;
    magnitude = (magnitude << 8n) | BigInt(b);
  }
  if (negative && magnitude === 0n) {
    throw new DecodeError('non-canonical int: negative zero');
  }
  return negative ? -magnitude : magnitude;
}

/** KCC1 sec 3.4.4: a bool payload is exactly `00` or `01`. */
export function encodeBoolState(value: boolean): Uint8Array {
  return Uint8Array.of(value ? 1 : 0);
}

/** Decode a bool state payload; throws `DecodeError` unless it is exactly `00` or `01`. */
export function decodeBoolState(payload: Uint8Array): boolean {
  if (payload.length !== 1 || (payload[0] !== 0 && payload[0] !== 1)) {
    throw new DecodeError(`bool payload must be exactly 00 or 01, got ${toHex(payload)}`);
  }
  return payload[0] === 1;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Concatenate byte arrays into a new array. */
export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Lowercase hex of `bytes`. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Bytes of a hex string (an optional `0x` prefix is allowed); throws `DecodeError` on invalid hex. */
export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new DecodeError(`invalid hex string: ${hex.slice(0, 32)}...`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Whether two byte arrays have the same contents. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
