/**
 * Check a token's launch proof yourself before you trade it, including the graduation check against the public
 * Kaspa REST API. The Kasseal API serves the bundle; nothing in it is trusted: every hash is recomputed here
 * against the reference token program and the curve programs bundled in the SDK.
 */
import { graduationOnChain, launchProofFromJson, verifyLaunchProofJson, type GraduationOnChain, type KassealNetwork, type LaunchProofStatus } from '@kassealhq/sdk/node';
import { get } from './api.ts';

export interface CheckedProof {
  /** Trade only on `bound`. */
  readonly status: LaunchProofStatus | 'malformed';
  readonly reason?: string;
  readonly tokenId?: string;
  /** The curve C the proof names. Pass it as `expectedCurveId`. */
  readonly curveId?: string;
  /** The pool P the graduation created, once graduated. Pass it as `expectedPoolId`. */
  readonly poolId?: string;
  readonly graduation: GraduationOnChain;
}

/** Fetch, verify and (once graduated) confirm the graduation. Never throws on bundle content. */
export async function checkLaunchProof(tokenId: string, network: KassealNetwork): Promise<CheckedProof> {
  const json = await get<unknown>(`/tokens/${tokenId}/launch-proof`);
  // The nine steps, against the reference token program and the curve programs of the network's bundled build.
  const result = verifyLaunchProofJson(json, network);
  if (result.status === 'malformed') return { status: 'malformed', reason: result.reason, graduation: 'none' };
  const bundle = launchProofFromJson(json);
  if (bundle.T.toLowerCase() !== tokenId.toLowerCase()) return { status: 'invalid', reason: 'the bundle is for another token', graduation: 'none' };
  const ids = { tokenId: bundle.T, curveId: bundle.C };

  if (result.status !== 'bound' || bundle.graduation === null || bundle.graduation === undefined) {
    return { status: result.status, ...(result.reason === undefined ? {} : { reason: result.reason }), ...ids, graduation: 'none' };
  }
  // Graduated: confirm the served graduation against the public Kaspa REST API, which Kasseal does not operate.
  const onChain = await graduationOnChain(json, network);
  if (onChain === 'mismatch') {
    return { status: 'invalid', reason: 'the served graduation differs from the one accepted on chain', ...ids, graduation: onChain };
  }
  if (onChain === 'not-found') {
    // Seconds after a graduation the public API may not have it yet. The pool is not proven until it does.
    return { status: 'unverified', reason: 'the graduation is not found on chain yet; ask again', ...ids, graduation: onChain };
  }
  // 'confirmed', or 'unavailable' (the public API could not be read): the proof stands as checked from the served data.
  return { status: 'bound', ...ids, poolId: bundle.graduation.P, graduation: onChain };
}
