/**
 * Launch presets.
 *
 * v1: every preset sells 800,000 lots
 * of 1,000 tokens (800M, 66.7 %) and holds 400,000 lots (400M, 33.3 %) as the
 * graduation reserve, so a buy can be a few KAS and a sell a fine step. They
 * differ only in P0 and K, re-tuned from the 100,000-token presets to the
 * same raise: the ideal K (the old K / 10,000) is not an integer for
 * Standard (149.375) and Set A (12.5), so K is rounded to the integer with
 * the smaller price deviation and P0 is solved for the raise. tiny's ideal
 * K (0.5) is rounded up to 1 with P0 0, a rising curve that raises about
 * twice as much. The raise figures --
 * 573,540.252 KAS (Standard), 47,995 KAS (Set A), 243,972 KAS (Set B),
 * 3,199.996 KAS (tiny) -- are asserted by computation in the package tests.
 * Mainnet launches use the Standard family only; Set A, Set B and tiny are
 * testnet presets.
 *
 * The factory default is PRESET_STANDARD: it graduates at a
 * market cap of about $69,000 at KAS = $0.0401. The threshold is fixed in
 * KAS, so its USD value drifts with the KAS price. It is the
 * anchor of the Standard family (bands.ts): one Standard-shaped curve per
 * KAS/USD price band, the app picking the band of the launch-day price, so
 * the target holds near $69k without any price on chain. A launched token
 * keeps the parameters it was created with.
 */

import { ParameterError } from './errors.ts';
import { assertBigint, mul } from './int64.ts';
import { type CurveParams, fullRaise, validateCurveParams } from './curve.ts';

/** Sompi per KAS: 1 KAS = 100,000,000 sompi. */
export const SOMPI_PER_KAS = 100_000_000n;
/** `curve.sil` LOT_MAX: tokens per lot, `0 < lot <= 1e12`. */
export const LOT_MAX = 1_000_000_000_000n;
/** `curve.sil` GRAD_RESERVE_MAX: the pool's token reserve at graduation, `0 < gradReserve <= 1.2e9`. */
export const GRAD_RESERVE_MAX = 1_200_000_000n;

/** A launch preset: the curve's pricing constants plus the supply split and fee settings. */
export interface LaunchPreset {
  /** Short identifier, e.g. `'standard'`. */
  readonly name: string;
  /** Human-readable description for preset pickers. */
  readonly label?: string;
  /** The curve's pricing constants (sompi). */
  readonly curve: CurveParams;
  /** Tokens per lot (`LOT`). */
  readonly lotSize: bigint;
  /** `TOTAL_SUPPLY` in whole tokens (decimals 0). */
  readonly totalSupply: bigint;
  /** `GRAD_LOTS`: lots held for the pool at graduation. */
  readonly gradLots: bigint;
  /**
   * Treasury share of every curve fee split, in percent; the creator receives
   * the remainder. 50 (50/50) for every launch (`CURVE_TREASURY_SHARE_PCT`).
   */
  readonly treasurySharePct: bigint;
  /** `SWEEP_MIN`, in sompi: accrued fees below this are not swept. */
  readonly sweepMinSompi: bigint;
  /** `TOKEN_CELL_KAS`, in sompi: minimum KAS value of a curve-owned token cell. */
  readonly tokenCellSompi: bigint;
}

const COMMON = {
  lotSize: 1_000n,
  totalSupply: 1_200_000_000n,
  gradLots: 400_000n,
  treasurySharePct: 50n,
  sweepMinSompi: 10n * SOMPI_PER_KAS,
  tokenCellSompi: 10n * SOMPI_PER_KAS,
} as const;

/**
 * Standard, the factory default: 1,000-token lots, P0 0.12092606 KAS, K 149 sompi per lot,
 * 100 bps. Raise 573,540.252 KAS (+0.002 KAS against the 100,000-token build), graduation market cap
 * 1,720,620.756 KAS; first lot +1.19 % and last lot -0.12 % against the exact rescaling (K = 149.375).
 */
export const PRESET_STANDARD: LaunchPreset = Object.freeze({
  name: 'standard',
  label: 'Standard — graduates ≈ $69k at $0.04 KAS',
  curve: Object.freeze({ p0: 12_092_606n, k: 149n, feeBps: 100n, curveLots: 800_000n }),
  ...COMMON,
});

/** The preset the factory uses when none is chosen. */
export const DEFAULT_PRESET: LaunchPreset = PRESET_STANDARD;

/** KAS/USD reference price the Standard preset was tuned at. */
export const PRESET_STANDARD_REFERENCE_KAS_USD = 0.0401;

/**
 * Set A: 1,000-token lots, P0 0.01199381 KAS, K 12 sompi per lot (exact rescaling 12.5), 100 bps.
 * Raise exactly 47,995 KAS; first lot +19.9 % and last lot -1.8 % against the exact rescaling.
 */
export const PRESET_A: LaunchPreset = Object.freeze({
  name: 'A',
  label: 'Set A — raises 47,995 KAS',
  curve: Object.freeze({ p0: 1_199_381n, k: 12n, feeBps: 100n, curveLots: 800_000n }),
  ...COMMON,
});

/** Set B: 1,000-token lots, P0 0.02496535 KAS, K 70 sompi per lot (exact), 100 bps; raise exactly 243,972 KAS. */
export const PRESET_B: LaunchPreset = Object.freeze({
  name: 'B',
  label: 'Set B — raises 243,972 KAS',
  curve: Object.freeze({ p0: 2_496_535n, k: 70n, feeBps: 100n, curveLots: 800_000n }),
  ...COMMON,
});

/**
 * tiny (a testnet preset, not offered by the factory): 1,000-token
 * lots, P0 0, K 1 sompi per lot (the smallest integer slope), 100 bps. A rising price from 0 to 0.00799999 KAS per
 * 1,000 tokens; raise 3,199.996 KAS (the K-only minimum: the exact rescaling K = 0.5 is not an integer). The pool
 * opens exactly at the last lot's price (raise / 400,000 lots = 799,999 sompi), so there is no jump at graduation.
 * It passes the final-tranche fee rule (the final 10,000,000 tokens pay 0.7949995 KAS), but the factory does not offer it.
 */
export const PRESET_TINY: LaunchPreset = Object.freeze({
  name: 'tiny',
  label: 'tiny — raises 3,200 KAS (testnet)',
  curve: Object.freeze({ p0: 0n, k: 1n, feeBps: 100n, curveLots: 800_000n }),
  ...COMMON,
});

/** The factory's presets (v1). */
export const PRESETS: readonly LaunchPreset[] = Object.freeze([PRESET_A, PRESET_B, PRESET_STANDARD]);


/** Curve supply and reserve supply must add up to the total supply exactly. */
export function validatePreset(preset: LaunchPreset): void {
  if (preset === null || typeof preset !== 'object') throw new ParameterError('preset must be an object');
  validateCurveParams(preset.curve);
  for (const key of ['lotSize', 'totalSupply', 'gradLots', 'treasurySharePct', 'sweepMinSompi', 'tokenCellSompi'] as const) {
    assertBigint(preset[key], key);
    if (preset[key] < 0n) throw new ParameterError(`${key} must be non-negative, got ${preset[key]}`);
  }
  if (preset.lotSize <= 0n) throw new ParameterError(`lotSize must be positive, got ${preset.lotSize}`);
  if (preset.lotSize > LOT_MAX) throw new ParameterError(`lotSize ${preset.lotSize} exceeds the cap ${LOT_MAX}`);
  if (preset.gradLots <= 0n) throw new ParameterError(`gradLots must be positive, got ${preset.gradLots}`);
  if (preset.tokenCellSompi <= 0n) throw new ParameterError(`tokenCellSompi must be positive, got ${preset.tokenCellSompi}`);
  if (preset.treasurySharePct > 100n) throw new ParameterError(`treasurySharePct ${preset.treasurySharePct} exceeds 100`);
  const curveSupply = mul(preset.curve.curveLots, preset.lotSize, 'CURVE_SUPPLY');
  const gradReserve = mul(preset.gradLots, preset.lotSize, 'GRAD_RESERVE');
  if (gradReserve > GRAD_RESERVE_MAX) throw new ParameterError(`GRAD_RESERVE ${gradReserve} exceeds the cap ${GRAD_RESERVE_MAX}`);
  if (curveSupply + gradReserve !== preset.totalSupply) {
    throw new ParameterError(`CURVE_SUPPLY ${curveSupply} + GRAD_RESERVE ${gradReserve} != TOTAL_SUPPLY ${preset.totalSupply}`);
  }
}

/** Tokens sold on the curve (`curveLots * lotSize`), whole tokens. */
export function curveSupply(preset: LaunchPreset): bigint {
  validatePreset(preset);
  return preset.curve.curveLots * preset.lotSize;
}

/** Tokens held back for the pool at graduation (`gradLots * lotSize`), whole tokens. */
export function gradReserve(preset: LaunchPreset): bigint {
  validatePreset(preset);
  return preset.gradLots * preset.lotSize;
}

/**
 * Fully diluted market cap at graduation, in sompi, floored: every token
 * priced at the pool's opening price, `raise / GRAD_RESERVE` per token, so
 * `raise * TOTAL_SUPPLY / GRAD_RESERVE` (3 x the raise for the 1.2B / 400M
 * split).
 */
export function graduationMarketCapSompi(preset: LaunchPreset): bigint {
  validatePreset(preset);
  // Off-chain figure: plain bigint, no int64 range applies (raise * 1.2e9 exceeds it).
  return (fullRaise(preset.curve) * preset.totalSupply) / gradReserve(preset);
}

/**
 * The graduation market cap in USD at a given KAS/USD price. Indicative
 * only: the threshold is fixed in KAS, so its USD value moves with KAS.
 */
export function graduationMarketCapUsd(preset: LaunchPreset, kasUsd: number): number {
  if (typeof kasUsd !== 'number' || !Number.isFinite(kasUsd) || kasUsd < 0) {
    throw new ParameterError(`kasUsd must be a finite non-negative number, got ${String(kasUsd)}`);
  }
  const sompi = graduationMarketCapSompi(preset);
  const whole = sompi / SOMPI_PER_KAS;
  const frac = sompi % SOMPI_PER_KAS;
  return (Number(whole) + Number(frac) / Number(SOMPI_PER_KAS)) * kasUsd;
}
