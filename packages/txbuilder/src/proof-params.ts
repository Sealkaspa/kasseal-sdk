/**
 * The launch proof's `params`, tied to the curve program.
 *
 * `verifyLaunchProof` (in the codec) recomputes the curve programs from `curvePrefix || state || curveSuffix` but
 * reads no constant back out of them unless the caller passes `VerifierTrust.curveTemplate`. Without it a bundle with
 * edited `params` (creator, payees, fee, opening window) still verifies as `bound`. This module is that check for
 * any environment, the browser included: the template must be a committed preset of the builder's contract sets (the
 * structural creator-slot rule, `instantiate.ts`), and its constants, in the launch-proof `params` form, are compared
 * with the bundle's.
 */

import { bytesEqual, toHex, type CurveTemplateCheck } from '@kasseal/codec';
import { BUILDER_CONTRACT_SETS, v1RevisionsOn } from './artifacts.ts';
import { committedPresets } from './builder.ts';
import { createContext, type BuilderContext } from './cells.ts';
import { NETWORK_ID } from './sdk.ts';
import { creatorSlots, instantiateCurve } from './instantiate.ts';
import { SPK36_LENGTH, isP2pkSpk36, type CurveParams } from './program.ts';
import { isTreasuryAllowedOnNetwork } from './treasury.ts';

/** A curve's constructor constants in the launch-proof `params` form (integers as decimal strings, bytes as hex). */
export function curveParamsForProof(p: CurveParams): Record<string, string | number> {
  const out: Record<string, string | number> = {
    p0: p.p0.toString(), k: p.k.toString(), lot: p.lot.toString(), curveLots: p.curveLots.toString(), gradReserve: p.gradReserve.toString(), feeBps: p.feeBps.toString(),
    creatorSpk: toHex(p.creatorSpk), tokenH: p.tokenH, tokenPrefixLen: p.tokenPrefixLen, tokenSuffixLen: p.tokenSuffixLen, poolH: p.poolH,
    tokenCellKas: p.tokenCellKas.toString(), openWindowLots: p.openWindowLots.toString(), openWindowMaxLots: p.openWindowMaxLots.toString(),
  };
  if (p.treasurySpk !== undefined) out['treasurySpk'] = toHex(p.treasurySpk);
  return out;
}

/** The context whose template `(prefix, suffix)` is, among `bases` (a committed preset, creator slots aside), or null. */
export function contextForCurveTemplate(prefix: Uint8Array, suffix: Uint8Array, bases: Iterable<BuilderContext>): BuilderContext | null {
  for (const base of bases) {
    const c = base.curve;
    if (!bytesEqual(prefix, c.prefix) || suffix.length !== c.suffix.length) continue;
    const slot = creatorSlots(c.suffix, c.params.creatorSpk)[0];
    if (slot === undefined) continue;
    const creator = suffix.subarray(slot, slot + SPK36_LENGTH);
    if (!isP2pkSpk36(creator)) continue;
    const inst = instantiateCurve(base, creator);
    if (bytesEqual(inst.curve.suffix, suffix)) return inst;
  }
  return null;
}

/** The committed presets of every contract set the builder trades (the bases a launch instantiates). */
export function committedCurveBases(networkId?: string): BuilderContext[] {
  const out: BuilderContext[] = [];
  for (const version of BUILDER_CONTRACT_SETS) {
    for (const name of committedPresets(version)) out.push(createContext(name, networkId, version));
  }
  // The network's frozen and staged v1 builds the builder trades (`v1RevisionsOn`): a token launched on one keeps its
  // launch proof checkable, with its own build's constants. Without them its proof was `unverified` in the browser and
  // buys paused, although the API accepts the build and the builder trades it.
  for (const revision of v1RevisionsOn(networkId ?? NETWORK_ID)) {
    for (const name of committedPresets('v1', revision)) out.push(createContext(name, networkId, 'v1', revision));
  }
  // Mainnet (`treasury.ts`): only bases whose treasury is a mainnet treasury; a launch on any other template is
  // then unmatched (its params unchecked, never `bound`).
  return out.filter((c) => isTreasuryAllowedOnNetwork(c));
}

/**
 * A `VerifierTrust.curveTemplate` over `bases`: a committed preset's template passes with its constants (the verifier
 * then compares them with the bundle's `params` and fails step 5 on any difference). A template of no committed preset
 * (a frozen revision the builder no longer trades) passes without constants and is reported to `onUnmatched`, so the
 * caller can withhold `bound` from params it could not check.
 */
export function curveTemplateTrust(bases: readonly BuilderContext[], onUnmatched?: (reason: string) => void): (prefix: Uint8Array, suffix: Uint8Array) => CurveTemplateCheck {
  return (prefix, suffix) => {
    const ctx = contextForCurveTemplate(prefix, suffix, bases);
    if (ctx === null) {
      onUnmatched?.('the curve template is not a committed preset of this build: its parameters cannot be checked here');
      return { ok: true };
    }
    return { ok: true, params: curveParamsForProof(ctx.curve.params) };
  };
}
