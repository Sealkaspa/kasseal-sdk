/**
 * Node wiring: the Kaspa SDK loader (every bundled file hashed against its
 * pinned SHA-256 before the Node build is required) and the contract
 * artifacts from disk. Imported for its effect by
 * `index.node.ts` before anything else.
 */

import { loadSdk } from '@kasseal/sdk';
import { installArtifactSource } from './artifacts.ts';
import { fileArtifactSource } from './artifacts.node.ts';
import { registerSdkLoader } from './sdk.ts';

registerSdkLoader(() => loadSdk());
installArtifactSource(fileArtifactSource());
