/**
 * Synchronous SHA-256 for both builds: the constructor-file digest a launch
 * proof names (`program.ts`) and the bundled Kaspa SDK digests the web entry
 * checks. The implementation lives in the codec (`sha256.ts`); this module
 * re-exports it.
 */
export { sha256, sha256Hex } from '@kasseal/codec';
