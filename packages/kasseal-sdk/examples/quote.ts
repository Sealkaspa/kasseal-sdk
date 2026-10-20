/**
 * Quote a pool buy, a pool sell and a curve buy on testnet-10. Read-only: no key, no wallet, no transaction.
 *
 *   node --experimental-strip-types examples/quote.ts <tokenId>
 *
 * The quote functions are pure and come from the package root; they compute exactly what the contracts compute.
 */
import {
  KAS_SCALE,
  buyQuote,
  minWithSlippage,
  swapKasForTokens,
  swapTokensForKas,
  type PoolState,
} from '@kassealhq/sdk';
import { get, type PoolCellWire } from './lib/api.ts';

const tokenId = process.argv[2];
if (tokenId === undefined) throw new Error('usage: quote.ts <tokenId>');

const SLIPPAGE_BPS = 100; // 1 %
const kas = (sompi: bigint): string => `${sompi / 100_000_000n}.${(sompi % 100_000_000n).toString().padStart(8, '0')} KAS`;

// Find the token's pool. A pool id is only trusted once the launch proof names it (see pool-buy.ts).
const pools = await get<{ pools: { poolId: string }[] }>(`/pools?token=${tokenId}`);
const poolId = pools.pools[0]?.poolId;

if (poolId !== undefined) {
  const cell = await get<PoolCellWire>(`/pools/${poolId}/cell`);
  const c = cell.tip?.pool ?? cell; // the pending tip, when trades are in flight
  const s = c.state as { kasScaled: string; tokenReserve: string; feeAccruedScaled: string };
  const state: PoolState = {
    kasScaled: BigInt(s.kasScaled),
    tokenReserve: BigInt(s.tokenReserve),
    feeAccruedScaled: BigInt(s.feeAccruedScaled),
    // The cell's KAS beyond the scaled amounts: below 0.01 KAS, carried unchanged.
    dust: BigInt(c.amount) - (BigInt(s.kasScaled) + BigInt(s.feeAccruedScaled)) * KAS_SCALE,
  };

  // Pool buy: the KAS leg is a whole number of 0.01 KAS units. 'uncapped' and 'nearest' are what the current pools use.
  const leg = 10_000n; // 100 KAS
  const buy = swapKasForTokens(state, leg, 'uncapped', 'nearest');
  console.log(`pool buy ${kas(leg * KAS_SCALE)} -> ${buy.tokenOut} tokens (fee ${kas(buy.fee.total * KAS_SCALE)})`);
  console.log(`  minimum at 1 % slippage: ${minWithSlippage(buy.tokenOut, SLIPPAGE_BPS)} tokens`);

  // Pool sell. Throws PoolPayoutTooSmallError below the pool's 0.1 KAS payout minimum.
  const sell = swapTokensForKas(state, 1_000_000n, 'uncapped', 'nearest');
  console.log(`pool sell 1,000,000 tokens -> ${kas(sell.kasOutScaled * KAS_SCALE)}`);
} else {
  // Still on its bonding curve: price whole lots at the current depth.
  const head = await get<{ state: { lotsSold: string }; params: { p0: string; k: string; feeBps: string; curveLots: string; lotSize: string } }>(`/tokens/${tokenId}/curve-head`);
  const p = { p0: BigInt(head.params.p0), k: BigInt(head.params.k), feeBps: BigInt(head.params.feeBps), curveLots: BigInt(head.params.curveLots) };
  const q = buyQuote(p, BigInt(head.state.lotsSold), 100n);
  console.log(`curve buy 100 lots (${100n * BigInt(head.params.lotSize)} tokens) -> ${kas(q.total)} (fee ${kas(q.fee)})`);
  // These params come from the API and are fine for display. A trade is sized by the builder from the curve program
  // itself (`curveParams`), never from served params.
}
