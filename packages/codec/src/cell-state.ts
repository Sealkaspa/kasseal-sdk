/**
 * Curve and pool cell states: the one codec the transaction builder, the API
 * server, the launch-proof verifier and the app share.
 *
 *   C  curve  state 53 B at offset 1 of R:
 *             tokenCovId byte[32] | lotsSold int | feeAccrued int | phase byte
 *   P  pool   state at offset 1 of R, layout 'v3' (139 B, the v1 pool with open liquidity;
 *             the layout keeps the name of the contract generation that introduced it):
 *               tokenCovId | kasScaled | tokenReserve | lpShares | lpCovId | feeAccruedScaled | creatorSpk
 *               with lpCovId byte[32] the id of the LP-share lineage L (0^32 while unbound).
 *
 * Every field is one KCC-1 PushExplicit (section 3.7.1); decoding is strict
 * (exact widths, no trailing bytes) and re-encodes to the input byte for byte.
 * Every failure throws `StateCodecError`, a `DecodeError`.
 *
 * Pure TypeScript, no Node built-ins: servers and the browser share it.
 */
import { DecodeError } from './errors.ts';
import { bytesEqual, concat, decodeIntState, encodeIntState, encodePushExplicit, readPushExplicit } from './push.ts';

/** A curve or pool state that does not encode or decode under its layout. */
export class StateCodecError extends DecodeError {}

/**
 * The committed contract set: v1, the set every token launches on (curve and pool contracts). A v1 pool's state has
 * the 139-byte layout `'v3'`.
 */
export type ContractSet = 'v1';
/** Every contract set this codec knows. */
export const CONTRACT_SETS: readonly ContractSet[] = ['v1'];

/** A pool state layout: `'v3'` (139 B: the v1 pool). */
export type PoolStateLayout = 'v3';

/** The pool state layout of a contract set (v1: `'v3'`), or a layout itself. */
export function poolStateLayoutOf(set: ContractSet | PoolStateLayout): PoolStateLayout {
  switch (set) {
    case 'v3':
      return set;
    case 'v1':
      return 'v3';
    default:
      throw new StateCodecError(`unknown contract set ${String(set)}`);
  }
}

/** Byte offset of the curve state inside the curve program `R`. */
export const CURVE_STATE_OFFSET = 1;
/** Length of the encoded curve state, in bytes. */
export const CURVE_STATE_LENGTH = 53;
/** Byte offset of the pool state inside the pool program `R`. */
export const POOL_STATE_OFFSET = 1;
/** The v1 pool state length (`'v3'`). */
export const POOL_STATE_LENGTH_V3 = 139;
/** Length of a script public key in the constructor form `version(2) || script(34)`. */
export const SPK36_LENGTH = 36;

/** 32 zero bytes: an unset id. */
export const ZERO32: Uint8Array = new Uint8Array(32);
/** KCC-20 owner scheme byte: a Schnorr public key (P2PK). */
export const OWNER_SCHEME_P2PK_SCHNORR = 0x00;
/** KCC-20 owner scheme byte: a covenant id (the cell is owned by a covenant). */
export const OWNER_SCHEME_COVENANT_ID = 0x04;
/** Curve phase byte: not yet initialised. */
export const PHASE_UNINIT = 0x00;
/** Curve phase byte: selling. */
export const PHASE_ACTIVE = 0x01;
/** The pool's share count at genesis (the locked floor). */
export const POOL_LP_SHARES = 1_000_000n;

/** A decoded curve state. */
export interface CurveState {
  /** The token lineage's covenant id (32 bytes). */
  readonly tokenCovId: Uint8Array;
  /** Lots sold so far. */
  readonly lotsSold: bigint;
  /** Fees accrued since the last sweep, in sompi. */
  readonly feeAccrued: bigint;
  /** `PHASE_UNINIT` or `PHASE_ACTIVE`. */
  readonly phase: number;
}

/** A decoded pool state. */
export interface PoolCellState {
  /** The token lineage's covenant id (32 bytes). */
  readonly tokenCovId: Uint8Array;
  /** KAS reserve, scaled units of 0.01 KAS. */
  readonly kasScaled: bigint;
  /** Token reserve, whole tokens. */
  readonly tokenReserve: bigint;
  /** The total share count S (locked floor plus issued), `LOCKED_SHARES <= S <= SHARES_MAX`. */
  readonly lpShares: bigint;
  /** Fees accrued for the next sweep, scaled units of 0.01 KAS. */
  readonly feeAccruedScaled: bigint;
  /**
   * The token creator's `version(2) || P2PK script(34)`, written by the curve's
   * `graduate` and never changed; the pool sweep pays it half.
   */
  readonly creatorSpk?: Uint8Array;
  /**
   * The covenant id of L, the LP-share lineage. `0^32` from graduation until the pool's
   * `bindLp` writes it; never rewritten afterwards.
   */
  readonly lpCovId: Uint8Array;
}

/** The pool state length of a set or layout: 139 B (v1, `'v3'`). */
export function poolStateLength(set: ContractSet | PoolStateLayout): number {
  poolStateLayoutOf(set);
  return POOL_STATE_LENGTH_V3;
}

/** The layout whose pool state has `length` bytes, or undefined. */
export function poolStateSetOfLength(length: number): PoolStateLayout | undefined {
  return length === POOL_STATE_LENGTH_V3 ? 'v3' : undefined;
}

/** The layout a pool state is in (`'v3'`). Compare it with a set through `poolStateLayoutOf(set)`. */
export function poolStateSet(_s: PoolCellState): PoolStateLayout {
  return 'v3';
}

/** True for a v1 pool whose `bindLp` has run (`lpCovId != 0^32`); false for an unbound one. */
export function isPoolBound(s: PoolCellState): boolean {
  return !bytesEqual(s.lpCovId, ZERO32);
}

/**
 * A set's fee model: `'v2'` (the 50/50 treasury/creator split, named after the contract generation that introduced it;
 * v1 uses it).
 */
export type FeeModel = 'v2';

/** The fee model of a set (`FeeModel`): `'v2'` for v1. */
export function feeModelOf(set: ContractSet): FeeModel {
  switch (set) {
    case 'v1':
      return 'v2';
    default:
      throw new StateCodecError(`unknown contract set ${String(set)}`);
  }
}

/** A version-0 P2PK script public key in the 36-byte constructor form `0000 20 <x-only key> ac`. */
export function isP2pkSpk36(spk: Uint8Array): boolean {
  return spk.length === SPK36_LENGTH && spk[0] === 0x00 && spk[1] === 0x00 && spk[2] === 0x20 && spk[35] === 0xac;
}

function byteField(v: number, what: string): Uint8Array {
  if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new StateCodecError(`${what} must be a byte`);
  return Uint8Array.of(v);
}

function reader(bytes: Uint8Array): { next(len: number): Uint8Array; end(): void } {
  let at = 0;
  return {
    next(len) {
      let r;
      try {
        r = readPushExplicit(bytes, at);
      } catch (e) {
        throw new StateCodecError((e as Error).message);
      }
      if (r.payload.length !== len) throw new StateCodecError(`field at ${at}: ${r.payload.length} bytes, expected ${len}`);
      at = r.next;
      return r.payload;
    },
    end() {
      if (at !== bytes.length) throw new StateCodecError(`trailing bytes: consumed ${at} of ${bytes.length}`);
    },
  };
}

function intField(b: Uint8Array): bigint {
  try {
    return decodeIntState(b);
  } catch (e) {
    throw new StateCodecError((e as Error).message);
  }
}

function byteOf(b: Uint8Array): number {
  const v = b[0];
  if (v === undefined) throw new StateCodecError('byte field is empty');
  return v;
}

/** Encode a curve state (53 bytes); throws `StateCodecError` on a malformed state. */
export function encodeCurveState(s: CurveState): Uint8Array {
  if (s.tokenCovId.length !== 32) throw new StateCodecError('curve state: tokenCovId must be 32 bytes');
  const phase = byteField(s.phase, 'curve state: phase');
  if (s.lotsSold < 0n || s.feeAccrued < 0n) throw new StateCodecError('curve state: lotsSold and feeAccrued must be non-negative');
  const out = concat(encodePushExplicit(s.tokenCovId), encodePushExplicit(encodeIntState(s.lotsSold)), encodePushExplicit(encodeIntState(s.feeAccrued)), encodePushExplicit(phase));
  if (out.length !== CURVE_STATE_LENGTH) throw new StateCodecError(`curve state encodes to ${out.length} B`);
  return out;
}

/** Decode a curve state strictly (exact widths, byte-for-byte round trip); throws `StateCodecError`. */
export function decodeCurveState(bytes: Uint8Array): CurveState {
  if (bytes.length !== CURVE_STATE_LENGTH) throw new StateCodecError(`curve state must be ${CURVE_STATE_LENGTH} B, got ${bytes.length}`);
  const r = reader(bytes);
  const s: CurveState = { tokenCovId: Uint8Array.from(r.next(32)), lotsSold: intField(r.next(8)), feeAccrued: intField(r.next(8)), phase: byteOf(r.next(1)) };
  r.end();
  if (!bytesEqual(encodeCurveState(s), bytes)) throw new StateCodecError('curve state does not round-trip');
  return s;
}

/**
 * KCC-1 encoding of a pool state in `pool.sil` field order (one PushExplicit per field):
 *   v3  20|tokenCovId 08|kasScaled 08|tokenReserve 08|lpShares 20|lpCovId 08|feeAccruedScaled 24|creatorSpk  (139 B)
 */
export function encodePoolState(s: PoolCellState): Uint8Array {
  if (s.tokenCovId.length !== 32) throw new StateCodecError('pool state: tokenCovId must be 32 bytes');
  if (s.creatorSpk === undefined) throw new StateCodecError('pool state: creatorSpk is required');
  if (s.creatorSpk.length !== SPK36_LENGTH) throw new StateCodecError(`pool state: creatorSpk must be ${SPK36_LENGTH} bytes`);
  if (s.lpCovId === undefined || s.lpCovId.length !== 32) throw new StateCodecError('pool state: lpCovId must be 32 bytes');
  const out = concat(
    encodePushExplicit(s.tokenCovId), encodePushExplicit(encodeIntState(s.kasScaled)), encodePushExplicit(encodeIntState(s.tokenReserve)),
    encodePushExplicit(encodeIntState(s.lpShares)), encodePushExplicit(s.lpCovId), encodePushExplicit(encodeIntState(s.feeAccruedScaled)),
    encodePushExplicit(s.creatorSpk),
  );
  if (out.length !== POOL_STATE_LENGTH_V3) throw new StateCodecError(`pool state encodes to ${out.length} B, expected ${POOL_STATE_LENGTH_V3}`);
  return out;
}

/** Decodes a pool state (`set`, when given, names the layout: v1 or `'v3'`). */
export function decodePoolState(bytes: Uint8Array, set?: ContractSet | PoolStateLayout): PoolCellState {
  if (set !== undefined) poolStateLayoutOf(set);
  if (bytes.length !== POOL_STATE_LENGTH_V3) throw new StateCodecError(`pool state must be ${POOL_STATE_LENGTH_V3} B, got ${bytes.length}`);
  const r = reader(bytes);
  const head = { tokenCovId: Uint8Array.from(r.next(32)), kasScaled: intField(r.next(8)), tokenReserve: intField(r.next(8)), lpShares: intField(r.next(8)) };
  const lpCovId = Uint8Array.from(r.next(32));
  const s: PoolCellState = { ...head, lpCovId, feeAccruedScaled: intField(r.next(8)), creatorSpk: Uint8Array.from(r.next(SPK36_LENGTH)) };
  r.end();
  if (!bytesEqual(encodePoolState(s), bytes)) throw new StateCodecError('pool state does not round-trip');
  return s;
}
