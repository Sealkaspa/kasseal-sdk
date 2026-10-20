/**
 * Swap and deposit: buy on a pool and deliver the tokens to a script instead of your key, in one transaction.
 * Testnet-10, local key.
 *
 *   KEY=<hex> node --experimental-strip-types examples/swap-and-deposit.ts <tokenId> <KAS>
 *
 * By default the SDK accepts only a key-locked script, `<32-byte x-only key> OP_CHECKSIG` (`keyLockedRedeem`): tokens
 * delivered there can always be moved again by that key. Any other script needs `allowAnyScript: true`, and even then
 * a script that is a pool or token program, or an empty script, is refused: tokens sent there would be lost.
 *
 * Here the script is locked to your own key, so this example is a "vault" you control. A router or escrow would put
 * its own script here and must guard every cell it owns (see docs/dex-and-routers.md).
 */
import {
  SOMPI_PER_KAS,
  createApiSources,
  createTxBuilder,
  keyLockedRedeem,
  poolLegForKas,
  sdk,
  signBuiltWithKey,
  xOnlyKeyOfAddress,
} from '@kassealhq/sdk/node';
import { API_BASE, NETWORK, submit, waitForOutcome } from './lib/api.ts';
import { checkLaunchProof } from './lib/proof.ts';

const [tokenId, kasText] = process.argv.slice(2);
const keyHex = process.env['KEY'];
if (tokenId === undefined || kasText === undefined || keyHex === undefined) throw new Error('usage: KEY=<hex> swap-and-deposit.ts <tokenId> <KAS>');

const key = new (sdk().PrivateKey)(keyHex);
const address = key.toAddress(NETWORK).toString();
const xOnly = xOnlyKeyOfAddress(address);

const proof = await checkLaunchProof(tokenId, NETWORK);
if (proof.status !== 'bound' || proof.poolId === undefined) throw new Error(`launch proof is ${proof.status}, or the token has no pool yet`);

const redeem = keyLockedRedeem(xOnly);
const sources = createApiSources({ baseUrl: API_BASE, network: NETWORK, tokenId, ownKey: Buffer.from(xOnly).toString('hex') });
const builder = createTxBuilder({ sources, networkId: NETWORK });
const leg = poolLegForKas(BigInt(Math.round(Number(kasText) * 100)) * (SOMPI_PER_KAS / 100n));

const built = await builder.buildSwap({
  poolId: proof.poolId,
  expectedPoolId: proof.poolId,
  tokenId,
  trader: address,
  traderXOnlyPubkey: xOnly,
  side: 'kas->tok',
  amountIn: leg,
  proofVerdict: 'bound',
  // The token cell is owned by P2SH(redeem) (scheme 0x03). `scriptFunding` is a plain KAS output to that same
  // script address: the input that authorizes the cell later. At least 0.0201 KAS.
  deliverToScript: { redeem, scriptFunding: 2n * SOMPI_PER_KAS },
});

const signed = signBuiltWithKey(built, key);
const answer = await submit(signed.txJson);
console.log('unknown' in answer ? `answer lost; ask GET /tx/${signed.txid}` : `${signed.txid}: ${(await waitForOutcome(signed.txid))?.kind}`);

// To sell those tokens later, `builder.buildScriptSell({ poolId, expectedPoolId: poolId, tokenId, payout: address,
// redeem, signerXOnly: xOnly, scriptAddress })` spends the script's KAS output as the authority. `scriptAddress` must be
// P2SH(redeem), and a key-locked redeem must be locked to `signerXOnly`; the SDK refuses anything else.
