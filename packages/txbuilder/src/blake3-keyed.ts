/**
 * Keyed BLAKE3 for the KIP-24 transaction id. The implementation lives in
 * the codec (`blake3-keyed.ts`, pure TypeScript, shared with servers and the
 * browser); this module re-exports it.
 */
export { blake3Keyed, domainKey, keyedBlake3 } from '@kasseal/codec';
