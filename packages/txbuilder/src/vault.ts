/**
 * Companion-contract artifacts. This SDK ships none, so reading them always ends in `ArtifactMissing`, which is
 * what the mainnet treasury rule (`treasury.ts`) expects: without them the company script is the only mainnet
 * treasury.
 */

import { ArtifactMissing } from './artifacts.ts';

/** A companion contract's P2SH and the company script its constructor names. */
export interface SplitterArtifact {
  /** The contract's P2SH script. */
  readonly spk: Uint8Array;
  /** The company script its constructor names. */
  readonly companySpk: Uint8Array;
}

export function splitterOfArtifacts(instance: string): SplitterArtifact {
  throw new ArtifactMissing(`contracts/vault/v1/artifacts/${instance}/manifest.json`);
}
