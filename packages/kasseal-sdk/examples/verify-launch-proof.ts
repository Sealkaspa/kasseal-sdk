/**
 * Verify a token's launch proof on testnet-10 and print the verdict. Read-only.
 *
 *   node --experimental-strip-types examples/verify-launch-proof.ts <tokenId>
 *
 * `bound` is the only verdict to trade on. The ids printed (curve C, pool P) are the only ones to trade with.
 */
import { NETWORK } from './lib/api.ts';
import { checkLaunchProof } from './lib/proof.ts';

const tokenId = process.argv[2];
if (tokenId === undefined) throw new Error('usage: verify-launch-proof.ts <tokenId>');

const r = await checkLaunchProof(tokenId, NETWORK);
console.log(`verdict:    ${r.status}${r.reason === undefined ? '' : ` (${r.reason})`}`);
console.log(`token T:    ${r.tokenId ?? '-'}`);
console.log(`curve C:    ${r.curveId ?? '-'}`);
console.log(`pool P:     ${r.poolId ?? '(not graduated)'}`);
console.log(`graduation: ${r.graduation}`);
process.exitCode = r.status === 'bound' ? 0 : 1;
