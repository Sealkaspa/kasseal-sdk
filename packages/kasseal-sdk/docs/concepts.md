# Concepts

How a Kasseal token works, from launch to pool. Every rule on this page is enforced by a contract on Kaspa L1 unless
it says "the SDK" or "the app".

## The four lineages

A Kasseal token is a family of covenant lineages. Each has a covenant id: 32 bytes, written as 64 hex characters.
The id is the lineage's identity. Names, tickers and addresses are not.

| Lineage | What it is |
|---|---|
| **T**, the token | The KCC-20 token itself, on the unmodified KCC-20 reference program |
| **C**, the curve | The bonding curve that sells the token until it sells out |
| **P**, the pool | The constant-product pool the token graduates into |
| **L**, the LP shares | The pool's liquidity shares: a KCC-20 lineage of its own, created when the pool is set up |

The launch proof links T, C and P (see [launch-proof.md](launch-proof.md)). The pool's state names L.

## Supply

Every token has a fixed supply of **1,200,000,000** tokens with **0 decimals**: every amount, on chain and in the
API, is a count of whole tokens. The whole supply is created in the launch transaction, in two cells owned by the
curve:

- **800,000,000** tokens for sale on the curve;
- **400,000,000** tokens held back for the pool.

The token program has no mint function, and consensus makes any other cell of the token's lineage impossible to
create. The curve checks both genesis cells against the pinned token program and the exact amounts. The supply can
never grow.

## The bonding curve

The curve sells tokens in **lots**: 1,000 tokens per lot on most tokens, 10,000 on tokens launched at high KAS
prices. The price rises linearly with every lot sold: lot `i` costs `p0 + k × i` sompi, where `p0` and `k` are
constants of the token's curve program. The curve has 800,000 lots (or 80,000 lots of 10,000 tokens).

- **Buy.** You pay the exact cost of the next `n` lots plus the curve fee. The curve releases exactly `n` lots into a
  new token cell for you.
- **Sell.** You return exactly `n` lots from one cell holding exactly that amount. The curve pays the cost of the
  last `n` lots sold, minus the curve fee. A sell must pay at least 0.1 KAS net. Prices depend only on the number of lots
  sold, not on the order of trades: if you sell back what you bought with nothing in between, you get the same cost
  back, less the sell fee (you paid the buy fee on the way in).
- **Price bands.** Every token on mainnet uses the Standard curve shape. The app picks the curve constants for the
  launch-day KAS price, so that a token graduates at a market cap of about $69,000 whatever the KAS price. A token
  keeps its constants for life.
- **No per-buy limit.** One buy can take any number of the lots left.

The SDK's quotes (`buyQuote`, `sellQuote`, `lotsForKas`, `buyForKas`, `minSellLots`) compute exactly what the curve
program computes.

## Graduation

When the last lot is sold, the curve is finished. Anyone can then submit the **graduation** (the app's graduation
service normally does it within seconds). In one transaction, the curve:

- creates the pool P, with all the KAS the curve holds as the pool's KAS reserve and the 400,000,000 held-back
  tokens as its token reserve;
- pays out the curve fees not yet paid, half to Kasseal and half to the creator, when they are at least 1 KAS
  (a smaller remainder stays in the pool's KAS reserve);
- ends: the curve has no successor and never trades again.

There is no graduation fee. The pool's starting price is set by the curve's final KAS reserve and the 400,000,000
tokens.

## The pool

The pool is a constant-product market maker between KAS and the token. A swap moves the pool along
`kasReserve × tokenReserve = constant`, after the fee.

- **Units.** The pool counts KAS in units of 0.01 KAS (`kasScaled`; 1 unit = 1,000,000 sompi). A swap's KAS leg is a
  whole number of units.
- **Buy** (`swapKasForTokens`): `tokensOut = floor(tokenReserve × (kasIn − fee) / (kasReserve + kasIn − fee))`.
- **Sell** (`swapTokensForKas`): `gross = floor(kasReserve × tokensIn / (tokenReserve + tokensIn))`, and you receive
  `gross − fee`, at least 0.1 KAS.
- Every rounding goes against the trader, never against the pool.

The exact formulas and every case the pool refuses are in [dex-and-routers.md](dex-and-routers.md).

**Composable swaps.** A pool swap checks only its own footprint: its pool cell, its token reserve and the reserve's
successor. So a swap can share its transaction with other contracts: a router splitting an order across venues, a
second pool, a vault receiving the tokens. Your signature over the whole transaction is what fixes where your
tokens and KAS go. Liquidity, fee payouts and pool setup are not composable within their own token, but can share a
transaction with another token's pool. See [dex-and-routers.md](dex-and-routers.md).

## Liquidity and LP shares

Right after graduation the pool takes swaps but no deposits. A one-time **pool setup** transaction (`bindLp`) then
creates the pool's LP-share lineage L. The graduation service normally sends it within seconds; anyone can.

- **Fixed share supply.** The setup creates all **999,000,000** issuable shares at once, in an inventory cell the
  pool owns. The setup leaves 10 KAS in that cell for good. Deposits take shares from the inventory and withdrawals
  return them. No share is ever minted later.
- **Add liquidity** (`addLiquidity`): you deposit KAS and tokens at the pool's current ratio and receive shares in a
  new LP-share cell. Both legs round up, against the depositor, so an immediate withdrawal never returns more than
  was put in. The LP cell carries 5 KAS by default (at least 2.5 KAS), returned when you withdraw.
- **Remove liquidity** (`removeLiquidity`): you return shares and receive your part of both reserves, rounded down.
  A withdrawal must pay at least 0.1 KAS.
- **The SDK's deposit minimum.** The SDK refuses a deposit whose KAS leg is under 1 KAS or under 20 shares' worth,
  or too small to stay withdrawable on every state the pool can reach. This is SDK policy, not a contract rule.
- **Shares are tied to their pool.** Every LP-share cell carries its pool's id as its KCC-20 extension commitment,
  and the pool refuses a share cell that does not. Keep it when you transfer shares.

### Locked graduation liquidity

The liquidity created at graduation is represented by **1,000,000 locked shares**. They exist only as a counter in
the pool's state (`lpShares` starts at 1,000,000), never as a cell, so nobody holds them and nobody can withdraw
them. The graduation liquidity stays in the pool for good, and a withdrawal can never take the pool below it.

### Risks for liquidity providers

- **Divergence (impermanent) loss.** A KAS-and-token position changes value with the price. If the token doubles
  against KAS, a 100 KAS + 100 KAS deposit withdraws as about 141 KAS and 141 KAS worth of tokens: about 283 KAS of
  value, against 300 had you held both.
- **Contract risk.** Smart contracts can have bugs. Only deposit what you can afford to lose.

## Fees

| Action | Fee | Creator | Kasseal | Liquidity providers |
|---|---|---|---|---|
| Launch | None | | | |
| Curve buy or sell | 1 % of the trade's KAS cost, rounded up | 0.50 % | 0.50 % | |
| Graduation | None | | | |
| Pool swap | 0.30 % of the KAS leg | 0.05 % | 0.05 % | 0.20 % |
| Add or remove liquidity | None | | | |

Every transaction also pays the Kaspa network fee.

**How fees are paid out.**

- **Curve fees** accrue inside the curve cell (`feeAccrued`). A **sweep** pays them out once they reach 10 KAS:
  Kasseal receives `floor(F / 2)` and the creator the rest, so an odd sompi goes to the creator. What is left at
  graduation is paid by the graduation when it is at least 1 KAS.
- **Pool fees.** Of every swap's 0.30 %, 0.20 % stays in the reserves and belongs to the liquidity providers
  (before the pool setup, it deepens the locked liquidity). The other 0.10 % accrues in the pool state
  (`feeAccruedScaled`), rounded to the nearest 0.01 KAS per swap, half up, so a swap whose KAS leg is under 5 KAS
  accrues nothing (the full 0.30 % is still taken and the rest stays in the reserves). A pool sweep pays the accrual
  out once it reaches 10 KAS, split as above.
- **Sweeps are permissionless.** Anyone can submit one. The submitter pays only the network fee and receives
  nothing; the contract fixes who is paid and how much.
- The fee payouts of a sweep or a graduation carry no covenant binding. A sweep you build must leave them unbound,
  or the contract refuses it.

## Pending trades and races

Every trade spends the one live curve cell or pool cell, so trades on one token race. The first transaction the
network accepts wins; the others are refused, and a refused transaction costs nothing.

To keep a busy market fast, a trade can be built on a trade still in the mempool. The API serves the end of that
chain as `tip`, with the pending transactions it follows in `via` (at most 8). If one of them is dropped, every trade
built on it is refused with it. See [trading-bots.md](trading-bots.md).
