/**
 * Buy tokens on a graduated token's pool, on testnet-10, with a local key.
 *
 *   KEY=<hex private key of a testnet-10 wallet> node --experimental-strip-types examples/pool-buy.ts <tokenId> <KAS>
 *
 * Steps: check the launch proof, quote, build on the latest pool state, check the bounds, sign your own inputs,
 * submit, and follow the result. If the answer to the submission is lost, the retry reuses the same coins, so the
 * trade can never go through twice.
 *
 * Never use a mainnet key with an example. Keep keys out of source files and logs.
 */
import {
  SOMPI_PER_KAS,
  createApiSources,
  createTxBuilder,
  poolLegForKas,
  sdk,
  signBuiltWithKey,
  xOnlyKeyOfAddress,
  type BuiltTx,
} from '@kassealhq/sdk/node';
import { API_BASE, NETWORK, submit, txStatus, waitForOutcome, walletInputsOf } from './lib/api.ts';
import { checkLaunchProof } from './lib/proof.ts';

const [tokenArg, kasText] = process.argv.slice(2);
const keyHex = process.env['KEY'];
if (tokenArg === undefined || kasText === undefined || keyHex === undefined) throw new Error('usage: KEY=<hex> pool-buy.ts <tokenId> <KAS>');
const tokenId: string = tokenArg.toLowerCase();

const key = new (sdk().PrivateKey)(keyHex);
const address = key.toAddress(NETWORK).toString();
const xOnly = xOnlyKeyOfAddress(address);
const ownKey = Buffer.from(xOnly).toString('hex');

// 1. The launch proof, checked here. Trade only on `bound`, and only with the pool the proof names.
const proof = await checkLaunchProof(tokenId, NETWORK);
if (proof.status !== 'bound') throw new Error(`launch proof is ${proof.status}: ${proof.reason ?? ''}`);
if (proof.poolId === undefined) throw new Error('the token has not graduated: buy on its curve instead');
const poolId = proof.poolId;

// 2. The KAS leg: whole 0.01 KAS units, rounded down.
const budget = BigInt(Math.round(Number(kasText) * 100)) * (SOMPI_PER_KAS / 100n);
const leg = poolLegForKas(budget);

// 3. Build on the latest pool state (the pending tip when trades are in flight).
const sources = createApiSources({ baseUrl: API_BASE, network: NETWORK, tokenId, ownKey });
const builder = createTxBuilder({ sources, networkId: NETWORK });

async function build(pin?: Set<string>): Promise<BuiltTx> {
  const b = pin === undefined ? builder : createTxBuilder({ sources, networkId: NETWORK, fundingOptions: { required: pin } });
  return b.buildSwap({
    poolId,
    expectedPoolId: poolId, // refused unless the pool is the one the proof names
    tokenId, // refused unless the pool trades this token
    trader: address,
    traderXOnlyPubkey: xOnly,
    side: 'kas->tok',
    amountIn: leg,
    // No `minOut`: the builder writes the exact quote of this pool state as the pool's minTokensOut. Pass your own
    // minimum (for example `minWithSlippage(quote, 100)`) to accept less when you build on a pending tip.
    maxAllIn: budget + 6n * SOMPI_PER_KAS, // leg + the 5 KAS cell deposit + the network fee, at most
    proofVerdict: 'bound',
  });
}

// 4. Sign only your own inputs (the plain KAS inputs here), submit, and follow.
let built = await build();
let signed = signBuiltWithKey(built, key);
let answer = await submit(signed.txJson);

if ('unknown' in answer) {
  // The answer was lost. Ask before doing anything else.
  const state = await txStatus(signed.txid);
  if (state === null || state.kind === 'dropped') {
    // Not seen, or definitely not through: rebuild on the same coins. Both transactions spend them, so at most one lands.
    built = await build(walletInputsOf(built, sources.lastFunding()));
    signed = signBuiltWithKey(built, key);
    answer = await submit(signed.txJson);
  }
}

const outcome = await waitForOutcome(signed.txid);
console.log(`txid ${signed.txid}: ${outcome?.kind ?? 'unknown'}`);
if (outcome?.kind === 'lost-race' || outcome?.kind === 'dropped') {
  console.log('Another trade spent the pool state first. Nothing was charged. Quote again and rebuild.');
}
