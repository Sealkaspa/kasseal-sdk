/**
 * Node entry of the transaction builder: the Kaspa SDK, hash-verified against
 * its pinned SHA-256 sums on first use, and the contract artifacts from disk.
 */
import './install.node.ts';

export * from './index.common.ts';
export { PACKAGES_DIR, fileArtifactSource } from './artifacts.node.ts';
