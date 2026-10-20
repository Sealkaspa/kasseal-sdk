/**
 * The mainnet treasury rule: on mainnet the builder uses only curve and pool templates whose compiled treasury
 * constant is a mainnet treasury:
 *
 *   - the mainnet company wallet's version-0 P2PK script, derived here from the address
 *     (`MAINNET_COMPANY_ADDRESS`, checksum verified by the address codec), never configured;
 *   - a P2SH treasury script recomputed from a companion contract's artifacts, only when those artifacts are
 *     installed and their constructor names the mainnet company script. Without them the company script is the
 *     only one.
 *
 * Testnets have no rule here (their builds carry testnet keys). A launch is refused
 * (`assertTreasuryAllowedOnNetwork` in `buildCreate`), and `createTxBuilder` and `committedCurveBases` leave out
 * every base that breaks the rule, so a testnet artifact in a mainnet build is never launched, traded or graduated.
 */

import { toHex } from '@kasseal/codec';
import { ArtifactMissing } from './artifacts.ts';
import type { BuilderContext } from './cells.ts';
import { MAINNET_NETWORK_ID } from './instance.ts';
import { splitterOfArtifacts } from './vault.ts';
import { ADDRESS_VERSION_PUBKEY, decodeAddress } from './wallet/address.ts';

/** The mainnet company wallet: the treasury of the mainnet builds (a public on-chain address). */
export const MAINNET_COMPANY_ADDRESS = 'kaspa:qrt0p8sd5g8k383mzxgqtyl7ehkdez8ds8cpxqcuwjdaayke9rjhg9pqnr3zx';

/** The companion-contract instance name checked on mainnet (absent unless its artifacts are installed). */
export const MAINNET_COMPANION_INSTANCE = 'mainnet';

/** A template's treasury is not one the network allows. */
export class TreasuryNotAllowedOnNetwork extends Error {
  /** The network. */
  readonly networkId: string;
  /** The refused treasury script, hex. */
  readonly treasurySpk: string | undefined;
  constructor(networkId: string, treasurySpk: string | undefined, detail: string) {
    super(`treasury ${treasurySpk ?? '(none)'} is not allowed on ${networkId}: ${detail}`);
    this.name = 'TreasuryNotAllowedOnNetwork';
    this.networkId = networkId;
    this.treasurySpk = treasurySpk;
  }
}

/** The 36-byte treasury constructor form `0000 20 <x-only key> ac` of a version-0 (Schnorr P2PK) address. */
export function p2pkTreasurySpkOfAddress(address: string, prefix: string): Uint8Array {
  const a = decodeAddress(address);
  if (a.prefix !== prefix) throw new Error(`${address} is not a ${prefix} address`);
  if (a.version !== ADDRESS_VERSION_PUBKEY) throw new Error(`${address} is not a Schnorr P2PK address`);
  return Uint8Array.from([0, 0, 0x20, ...a.payload, 0xac]);
}

/** The mainnet company script in the treasury constructor form (hex). */
export function mainnetCompanySpk(): string {
  return toHex(p2pkTreasurySpkOfAddress(MAINNET_COMPANY_ADDRESS, 'kaspa'));
}

/**
 * The treasury scripts a mainnet template may carry (hex): the company P2PK, and the companion contract's P2SH when its
 * artifacts are installed (recomputed; refused when its constructor names another company script).
 */
export function mainnetTreasurySpks(): readonly string[] {
  const company = mainnetCompanySpk();
  let splitter: ReturnType<typeof splitterOfArtifacts>;
  try {
    splitter = splitterOfArtifacts(MAINNET_COMPANION_INSTANCE);
  } catch (err) {
    if (err instanceof ArtifactMissing) return [company];
    throw err;
  }
  if (toHex(splitter.companySpk) !== company) {
    throw new TreasuryNotAllowedOnNetwork(MAINNET_NETWORK_ID, toHex(splitter.spk), `the mainnet Splitter pays company script ${toHex(splitter.companySpk)}, not ${company} (${MAINNET_COMPANY_ADDRESS})`);
  }
  return [company, toHex(splitter.spk)];
}

let mainnetAllowed: readonly string[] | undefined;

/**
 * The treasury scripts a network's templates may carry, or undefined when the network has no rule (testnets).
 * `mainnetTreasurySpks` is read once per process.
 */
export function allowedTreasurySpks(networkId: string): readonly string[] | undefined {
  if (networkId !== MAINNET_NETWORK_ID) return undefined;
  mainnetAllowed ??= mainnetTreasurySpks();
  return mainnetAllowed;
}

/** Why a context breaks its network's treasury rule, or undefined when it keeps it. */
export function treasuryProblemOf(ctx: BuilderContext, allowed: readonly string[] | undefined = allowedTreasurySpks(ctx.networkId)): string | undefined {
  if (allowed === undefined) return undefined;
  const curve = ctx.curve.params.treasurySpk;
  const pool = ctx.pool.treasurySpk;
  const label = `${ctx.curve.version}:${ctx.curve.preset}${ctx.pool.revision === undefined ? '' : `@${ctx.pool.revision}`}`;
  if (curve === undefined || pool === undefined) return `${label}: the curve or its pool names no treasury`;
  if (toHex(curve) !== toHex(pool)) return `${label}: the curve's treasury ${toHex(curve)} is not its pool's ${toHex(pool)}`;
  if (!allowed.includes(toHex(curve))) return `${label}: its treasury is not one of ${allowed.join(', ')}`;
  return undefined;
}

/** Whether a context keeps its network's treasury rule. */
export function isTreasuryAllowedOnNetwork(ctx: BuilderContext, allowed?: readonly string[]): boolean {
  return treasuryProblemOf(ctx, allowed ?? allowedTreasurySpks(ctx.networkId)) === undefined;
}

/** Throws `TreasuryNotAllowedOnNetwork` when a context breaks its network's treasury rule. */
export function assertTreasuryAllowedOnNetwork(ctx: BuilderContext, allowed?: readonly string[]): void {
  const problem = treasuryProblemOf(ctx, allowed ?? allowedTreasurySpks(ctx.networkId));
  if (problem !== undefined) {
    const t = ctx.curve.params.treasurySpk;
    throw new TreasuryNotAllowedOnNetwork(ctx.networkId, t === undefined ? undefined : toHex(t), problem);
  }
}
