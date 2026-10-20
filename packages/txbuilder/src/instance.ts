/**
 * The launch rules that depend on the network.
 *
 * Launch rules:
 *   - `assertPresetAllowedOnNetwork`: on mainnet only the Standard family may be launched (`standard` and its price
 *     bands); testnets keep every preset, tiny included.
 *   - `assertBandForPrice`: a Standard-family launch must be on the band of the KAS/USD price the caller supplies
 *     (the price the app showed, `GET /v1/price/kas`), and that price must be at most `KAS_PRICE_MAX_AGE_MS` old.
 *     Mainnet requires the price; a testnet launch without one is not checked here (the Kasseal API still refuses a
 *     launch more than one band off its own price history).
 */

import { checkStandardBand, isStandardBandNameForm, standardFamilyPreset } from '@kasseal/curve-math';
import type { BuilderContext } from './cells.ts';
import type { KasPriceQuote } from './types.ts';

/** The network id of mainnet, as the builder's contexts carry it. */
export const MAINNET_NETWORK_ID = 'mainnet';
/**
 * The anchor of the only preset family that may be launched on mainnet: `standard`,
 * together with its price bands (`isMainnetPreset`).
 */
export const MAINNET_PRESET = 'standard';

/** Whether a preset name may be launched on mainnet: a member of the Standard family (`standard` and its bands). */
export function isMainnetPreset(preset: string): boolean {
  return standardFamilyPreset(preset) !== undefined;
}

/** A preset outside the Standard family was asked on mainnet. */
export class PresetNotAllowedOnNetwork extends Error {
  readonly preset: string;
  readonly networkId: string;
  constructor(preset: string, networkId: string, detail: string) {
    super(`preset ${preset} cannot be launched on ${networkId}: ${detail}`);
    this.name = 'PresetNotAllowedOnNetwork';
    this.preset = preset;
    this.networkId = networkId;
  }
}

/**
 * On mainnet only the Standard family may be launched: the preset's name must be `standard` or one of its committed
 * bands, and its pricing constants (p0, k, fee, lot count, lot size, graduation reserve) exactly that
 * member's in curve-math (`standardFamilyPreset`), so a renamed or re-parameterised curve cannot pass. Every testnet
 * keeps all presets, tiny included.
 */
export function assertPresetAllowedOnNetwork(ctx: BuilderContext): void {
  if (ctx.networkId !== MAINNET_NETWORK_ID) return;
  const c = ctx.curve;
  const s = standardFamilyPreset(c.preset);
  if (s === undefined) throw new PresetNotAllowedOnNetwork(c.preset, ctx.networkId, 'only the Standard family (standard and its price bands) may be launched on mainnet');
  const p = c.params;
  const same = p.p0 === s.curve.p0 && p.k === s.curve.k && p.feeBps === s.curve.feeBps && p.curveLots === s.curve.curveLots && p.lot === s.lotSize && p.gradReserve === s.gradLots * s.lotSize;
  if (!same) throw new PresetNotAllowedOnNetwork(c.preset, ctx.networkId, `its constants are not the ${s.name} preset's`);
}

/** The oldest KAS/USD price a launch may pick its band from: the API's staleness window (15 minutes). */
export const KAS_PRICE_MAX_AGE_MS = 15 * 60_000;
/** A price stamped further than this in the future is refused (clock skew allowance). */
export const KAS_PRICE_MAX_SKEW_MS = 60_000;

/** A Standard-family launch on mainnet was asked without the KAS/USD price its band was picked at. */
export class KasPriceRequired extends Error {
  readonly preset: string;
  constructor(preset: string) {
    super(`preset ${preset}: a Standard-family launch on mainnet needs the KAS/USD price its band was picked at`);
    this.name = 'KasPriceRequired';
    this.preset = preset;
  }
}

/** The supplied KAS/USD price is too old (or stamped in the future) to pick a band from. */
export class KasPriceStale extends Error {
  readonly asOfMs: number;
  readonly nowMs: number;
  constructor(asOfMs: number, nowMs: number) {
    super(`the KAS/USD price is from ${Number.isFinite(asOfMs) ? new Date(asOfMs).toISOString() : String(asOfMs)}, ` +
      `${Math.round((nowMs - asOfMs) / 1000)} s before now: a launch needs a price at most ${KAS_PRICE_MAX_AGE_MS / 60_000} minutes old`);
    this.name = 'KasPriceStale';
    this.asOfMs = asOfMs;
    this.nowMs = nowMs;
  }
}

/** The preset is not the Standard band of the supplied KAS/USD price. */
export class StandardBandMismatch extends Error {
  readonly preset: string;
  readonly kasUsd: number;
  /** The band the price calls for, when the price is inside the family's range. */
  readonly expected: string | undefined;
  constructor(preset: string, kasUsd: number, expected: string | undefined, detail: string) {
    super(`preset ${preset} is not the Standard band for KAS/USD ${kasUsd}${expected === undefined ? '' : ` (that is ${expected})`}: ${detail}`);
    this.name = 'StandardBandMismatch';
    this.preset = preset;
    this.kasUsd = kasUsd;
    this.expected = expected;
  }
}

/**
 * A Standard-family launch must be on exactly the band of the caller's KAS/USD price (`checkStandardBand` with no
 * tolerance: the app picks that band from the same price), and the price must be fresh. Presets outside the family
 * are not price-bound (testnets only: `assertPresetAllowedOnNetwork` keeps them off mainnet), except legacy bands
 * (band-named presets dropped from the family), which are refused everywhere.
 */
export function assertBandForPrice(ctx: BuilderContext, kasPrice: KasPriceQuote | undefined, nowMs: number): void {
  const preset = ctx.curve.preset;
  if (standardFamilyPreset(preset) === undefined) {
    // A legacy band (a band-named preset no longer in the family): never launched again, on any network.
    if (isStandardBandNameForm(preset)) throw new StandardBandMismatch(preset, kasPrice?.usd ?? Number.NaN, undefined, 'it is a legacy band, no longer part of the Standard family');
    return;
  }
  if (kasPrice === undefined) {
    if (ctx.networkId === MAINNET_NETWORK_ID) throw new KasPriceRequired(preset);
    return;
  }
  const { usd, asOfMs } = kasPrice;
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) throw new StandardBandMismatch(preset, usd, undefined, 'the price is not a positive number');
  if (typeof asOfMs !== 'number' || !Number.isFinite(asOfMs) || nowMs - asOfMs > KAS_PRICE_MAX_AGE_MS || asOfMs - nowMs > KAS_PRICE_MAX_SKEW_MS) {
    throw new KasPriceStale(asOfMs, nowMs);
  }
  const v = checkStandardBand(preset, usd, 0);
  if (!v.accepted) throw new StandardBandMismatch(preset, usd, v.expected?.name, v.message);
}
