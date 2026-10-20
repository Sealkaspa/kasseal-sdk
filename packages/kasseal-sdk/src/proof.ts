/**
 * Launch-proof verification against the bundled contract build of a network: the reference KCC-20 program comes from
 * the bundled artifact (checked against its pinned template hash), the curve template must instantiate a committed
 * preset of the network's build, and the constants read from the program must equal the bundle's `params`.
 */
import { fromHex } from '../../codec/src/push.ts';
import { templateHash } from '../../codec/src/template-hash.ts';
import { REFERENCE_KCC0020_TEMPLATE_HASH } from '../../codec/src/templates.ts';
import { launchProofFromJson, verifyLaunchProof, type LaunchProofResult } from '../../codec/src/kcc0023.ts';
import { readArtifactJson, TOKEN_REFERENCE } from '../../txbuilder/src/artifacts.ts';
import { committedCurveBases, curveTemplateTrust } from '../../txbuilder/src/proof-params.ts';
import type { BuilderContext } from '../../txbuilder/src/cells.ts';
import { assertNetwork, type KassealNetwork } from './networks.ts';

const STATE_END = 146;

/** The reference KCC-20 program's suffix (after its state), checked against the pinned template hash. */
export function referenceTokenSuffix(): Uint8Array {
  const fixture = readArtifactJson<{ contracts: { KCC20: { bytecode_hex: string } } }>(TOKEN_REFERENCE);
  const suffix = fromHex(fixture.contracts.KCC20.bytecode_hex).subarray(STATE_END);
  if (templateHash(Uint8Array.of(0x6b), suffix) !== REFERENCE_KCC0020_TEMPLATE_HASH) throw new Error('the bundled reference program does not hash to the KCC-20 reference template');
  return suffix;
}

/** The committed curve presets of a network's build (the templates a launch may instantiate). */
export function curveBasesOf(networkId: KassealNetwork): BuilderContext[] {
  assertNetwork(networkId);
  return committedCurveBases(networkId).filter((c) => c.networkId === networkId);
}

export type LaunchProofReport = LaunchProofResult | { readonly status: 'malformed'; readonly reason: string };

/**
 * Verify a launch-proof bundle as served by `GET /tokens/{id}/launch-proof`. Never throws for a bad bundle: one that
 * does not parse is `malformed`. Only `status === 'bound'` means the token is the program it claims; a curve template
 * whose constants could not be checked is reported `unverified`.
 */
export function verifyLaunchProofJson(json: unknown, networkId: KassealNetwork, bases: readonly BuilderContext[] = curveBasesOf(networkId)): LaunchProofReport {
  assertNetwork(networkId);
  let bundle;
  try {
    bundle = launchProofFromJson(json);
  } catch (e) {
    return { status: 'malformed', reason: e instanceof Error ? e.message : String(e) };
  }
  let unmatched: string | undefined;
  const r = verifyLaunchProof(bundle, { referenceSuffix: referenceTokenSuffix(), curveTemplate: curveTemplateTrust(bases, (why) => { unmatched = why; }) });
  return r.status === 'bound' && unmatched !== undefined ? { ...r, status: 'unverified', reason: unmatched } : r;
}
