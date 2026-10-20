/**
 * Funding selection over the signer's P2PK UTXOs.
 *
 *   1. The optimistic reserved set is excluded: outpoints spent by the
 *      signer's own pending transactions, and outputs a pending flow will
 *      spend (tx01's prep outpoint). `UtxoSources.funding` already subtracts
 *      it; the selector subtracts it again so a stale source cannot cause a
 *      self-conflict.
 *   2. One UTXO is preferred: every extra P2PK input costs ~118 bytes and
 *      1,100 g of compute budget (14 inputs made compute the binding mass in a test).
 *      Among single UTXOs the smallest that leaves at least `preferredChange`
 *      (1 KAS) of change is taken; a smaller change output binds storage
 *      (0.2 KAS of change was measured to cost +0.037 KAS).
 *   3. Otherwise UTXOs are added largest-first, up to `maxInputs`, until the
 *      preferred change is reached, else until the change clears `minChange`
 *      (0.1 KAS, the assembler's drop threshold), else until the need is met
 *      exactly (a sub-0.1 KAS remainder then joins the fee).
 *   4. A wallet whose KAS is spread over many small UTXOs (for example 180 KAS
 *      in 59 UTXOs cannot fund a 30 KAS transaction from 3) is tried again
 *      with up to `escalateTo` inputs (default 8), then with up to
 *      `escalateMax` (default 60). Each input past the first `maxInputs` adds
 *      `FUNDING_INPUT_FEE` to the target (measured ~1,220 g each, so a 60-input
 *      curve buy is ~90,000 g, a pool swap ~107,000 g; testnet-10 accepted 240 inputs
 *      at 309,153 g). If even that is short while the wallet as a whole holds
 *      enough, the error says so (`fragmented`).
 *
 * `required` (the retry pin): every listed
 * outpoint is spent, before anything else is added. A rebuild that spends an
 * input of an earlier attempt can never be accepted together with it, so a
 * click cannot be charged twice. A required outpoint that is no longer
 * available (spent, or reserved) raises `PinnedFundingGone`: nothing is built
 * on other funding.
 *
 * `needed` is the sum of the transaction's fixed outputs minus the value its
 * covenant inputs bring; `feeAllowance` covers the fee the assembler sets
 * exactly afterwards.
 */

import type { FundingUtxo, Outpoint } from '../assemble.ts';
import { MIN_CHANGE, outpointKey } from '../assemble.ts';
import { SOMPI_PER_KAS } from '../mass.ts';

/** The signer's UTXOs cannot fund the transaction (amounts in sompi). */
export class InsufficientFundsError extends Error {
  /** Sompi needed. */
  readonly needed: bigint;
  /** Sompi available in the inputs tried. */
  readonly available: bigint;
  /** The wallet holds enough in total, but spread over more UTXOs than one transaction takes (combine them first). */
  readonly fragmented: boolean;
  /** The wallet's total spendable KAS (sompi), when `fragmented`. */
  readonly total: bigint | undefined;
  constructor(needed: bigint, available: bigint, fragmented = false, total?: bigint) {
    super(fragmented
      ? `insufficient funds in at most the allowed inputs: need ${needed} sompi, ${available} available in the largest UTXOs (${total} in all): combine UTXOs first`
      : `insufficient funds: need ${needed} sompi, ${available} available`);
    this.name = 'InsufficientFundsError';
    this.needed = needed;
    this.available = available;
    this.fragmented = fragmented;
    this.total = total;
  }
}

/** Default fee allowance: above every measured shape's fee (graduate 0.0407 KAS) plus the per-input cost of a few inputs. */
export const DEFAULT_FEE_ALLOWANCE = 5_000_000n;
/** Change at or above this keeps its storage term (1e12 / v) under the transient floor of every trade shape. */
export const PREFERRED_CHANGE = SOMPI_PER_KAS;
/** Funding inputs tried first. */
export const DEFAULT_MAX_FUNDING_INPUTS = 3;
/** The second try of a wallet whose largest `maxInputs` UTXOs fall short (step 4 of the module comment). */
export const ESCALATE_MAX_FUNDING_INPUTS = 8;
/** The last try of a fragmented wallet (step 4): beyond it the error is `fragmented`. */
export const HEAVY_MAX_FUNDING_INPUTS = 60;
/** Fee added to the target for each funding input past `maxInputs`: 1,300 g at 100 sompi/g (measured ~1,220 g). */
export const FUNDING_INPUT_FEE = 130_000n;

/** A `required` funding outpoint is not available: an earlier attempt may have landed; nothing is built on other funding. */
export class PinnedFundingGone extends Error {
  /** The missing outpoints, `txid:index`. */
  readonly outpoints: readonly string[];
  constructor(outpoints: readonly string[]) {
    super(`pinned funding no longer available: ${outpoints.join(', ')}`);
    this.name = 'PinnedFundingGone';
    this.outpoints = outpoints;
  }
}

/** Options of `selectFunding`. */
export interface SelectFundingOptions {
  /** Added to the amount the outputs need, for the fee (default 0.05 KAS; the exact fee is set by the assembler). */
  readonly feeAllowance?: bigint;
  /** Outpoints to skip (the optimistic reserved set). */
  readonly reserved?: ReadonlySet<string>;
  /** At most this many UTXOs (default 3). */
  readonly maxInputs?: number;
  /** When the first `maxInputs` fall short, try again with up to this many (default 8; never below `maxInputs`). */
  readonly escalateTo?: number;
  /** When `escalateTo` falls short too, the last try with up to this many (default 60; never below `escalateTo`). */
  readonly escalateMax?: number;
  /** Change the selector aims for (default 1 KAS). */
  readonly preferredChange?: bigint;
  /** Change below this is dropped into the fee by the assembler (default 0.1 KAS). */
  readonly minChange?: bigint;
  /** Outpoints (`txid:index`) that must be spent (the retry pin); `PinnedFundingGone` when one is not available. */
  readonly required?: ReadonlySet<string>;
}

const byAmountDesc = (a: FundingUtxo, b: FundingUtxo): number => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0);
const sum = (us: readonly FundingUtxo[]): bigint => us.reduce((a, u) => a + u.amount, 0n);

/** Select P2PK UTXOs covering `needed + feeAllowance`; see the module comment for the order of preference. */
export function selectFunding(utxos: readonly FundingUtxo[], needed: bigint, options: SelectFundingOptions = {}): FundingUtxo[] {
  if (needed < 0n) throw new Error('needed must be non-negative');
  const allowance = options.feeAllowance ?? DEFAULT_FEE_ALLOWANCE;
  const maxInputs = options.maxInputs ?? DEFAULT_MAX_FUNDING_INPUTS;
  if (!Number.isInteger(maxInputs) || maxInputs < 1) throw new Error('maxInputs must be a positive integer');
  const preferred = options.preferredChange ?? PREFERRED_CHANGE;
  const minChange = options.minChange ?? MIN_CHANGE;
  const reserved = options.reserved ?? new Set<string>();
  const target = needed + allowance;
  const escalateTo = Math.max(maxInputs, options.escalateTo ?? ESCALATE_MAX_FUNDING_INPUTS);
  const escalateMax = Math.max(escalateTo, options.escalateMax ?? HEAVY_MAX_FUNDING_INPUTS);
  const limits = [...new Set([maxInputs, escalateTo, escalateMax])];
  /** What `n` inputs must cover: the target plus the fee of the inputs past `maxInputs`. */
  const need = (n: number): bigint => target + BigInt(Math.max(0, n - maxInputs)) * FUNDING_INPUT_FEE;

  const seen = new Set<string>();
  const candidates = utxos
    .filter((u) => {
      const k = outpointKey(u.outpoint);
      if (reserved.has(k) || seen.has(k)) return false;
      seen.add(k);
      return u.amount > 0n;
    })
    .sort(byAmountDesc);

  // The retry pin: the required outpoints first, all of them, or nothing is built.
  const required = options.required ?? new Set<string>();
  if (required.size > 0) {
    const pinned = candidates.filter((u) => required.has(outpointKey(u.outpoint)));
    const missing = [...required].filter((k) => !pinned.some((u) => outpointKey(u.outpoint) === k));
    if (missing.length > 0) throw new PinnedFundingGone(missing);
    // A retry of an escalated build pins its inputs, so the pin may use as many as the last try allows.
    if (pinned.length > escalateMax) throw new Error(`${pinned.length} required funding inputs exceed ${escalateMax}`);
    const rest = candidates.filter((u) => !required.has(outpointKey(u.outpoint)));
    for (const limit of limits.filter((l) => l >= pinned.length)) {
      for (const floor of [preferred, minChange, 0n]) {
        const chosen = [...pinned];
        for (const u of [undefined, ...rest]) {
          if (u !== undefined) {
            if (chosen.length >= limit) break;
            chosen.push(u);
          }
          if (sum(chosen) >= need(chosen.length) + floor) return chosen;
        }
      }
    }
    throw new InsufficientFundsError(target, sum([...pinned, ...rest].slice(0, escalateMax)));
  }

  // 2. One UTXO with the preferred change: the smallest that qualifies.
  const singles = candidates.filter((u) => u.amount >= target + preferred);
  if (singles.length > 0) return [singles[singles.length - 1]!];

  // 3. Largest-first prefixes, best change class first; 4. the same with more inputs when the wallet is fragmented.
  for (const limit of limits) {
    for (const floor of [preferred, minChange, 0n]) {
      const chosen: FundingUtxo[] = [];
      for (const u of candidates) {
        if (chosen.length >= limit) break;
        chosen.push(u);
        if (sum(chosen) >= need(chosen.length) + floor) return chosen;
      }
    }
  }
  const total = sum(candidates);
  const reach = sum(candidates.slice(0, escalateMax));
  throw total >= target ? new InsufficientFundsError(target, reach, true, total) : new InsufficientFundsError(target, reach);
}

/** Outpoints of a list, as a reservation set. */
export function reserve(outpoints: readonly Outpoint[]): Set<string> {
  return new Set(outpoints.map(outpointKey));
}

/** A funding UTXO predicted by a transaction that is not yet accepted (its change output), for chained builds. */
export function predictedFunding(outpoint: Outpoint, amount: bigint, spk: Uint8Array, address: string): FundingUtxo {
  return { outpoint, amount, spk, daaScore: 0n, address };
}
