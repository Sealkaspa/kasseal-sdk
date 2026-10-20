/**
 * BLAKE2b, the KCC-1 P2SH commitment and the KIP-20 covenant id. The
 * implementation lives in the codec (`blake2b.ts`, pure TypeScript, shared
 * with servers and the browser); this module re-exports it. It is tested
 * against the Kaspa SDK's `payToScriptHashScript` and `covenantId`.
 */
export { blake2b, covenantIdKip20, p2shCommitsTo, p2shScript, type Blake2bOptions, type GenesisAuthorizedOutput } from '@kasseal/codec';
