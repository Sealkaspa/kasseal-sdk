# DEXs, routers and other contracts

Kasseal pool swaps are **composable**: a swap may share its transaction, and its token's KCC-20 transfer, with other
covenants, such as another venue's pool, a router or an escrow. This page is for anyone who puts a Kasseal swap
inside a transaction they design. It applies to the pools of every current build (`v1-kasseal-mainnet-3` and `v1-kasseal-mainnet-2`
share one pool program) and their testnet-10 builds (template hashes in [contract-artifacts.md](contract-artifacts.md)).

If you only trade through the SDK's own transaction shapes, read [trading-bots.md](trading-bots.md) instead. The
rules below still explain why the SDK does what it does.

## 1. What a pool checks, and what it leaves to you

In any swap it accepts, a pool checks only its own footprint:

- **Its pool cell.** The input it spends and its one successor, whose KAS value and state follow the swap formula
  exactly.
- **Its token reserve.** The token input at the position you name (`reserveK`) must be the pool-owned reserve
  holding exactly the state's `tokenReserve`. Its successor, at the token output position you name (`restK` for a
  buy, `mergedK` for a sell), must hold exactly the new reserve.
- **No other cell of its own moves.** Every other input of the pool's token is refused if the pool's inputs would
  authorize it: a cell owned `0x04` by the pool's covenant id, or owned `0x03` by the P2SH of the pool cell's script
  or of the reserve's script. LP-share cells may not take part in a swap at all.

The pool does **not** check where the tokens a buy releases go, where the KAS a sell releases goes, or which cells
supply a sell's tokens. KCC-20 conserves the tokens across the whole transfer. The signatures and covenant programs
behind the other inputs decide the destinations.

## 2. Rules for routers and integrators

1. **Protect your users with signatures, not with `minTokensOut` or `minOutScaled`.** The entry arguments sit in the
   pool input's signature script, which no signature covers: whoever relays the transaction can rewrite them without
   changing its id. A user's `SIGHASH_ALL` signature over the whole transaction (the spent pool outpoint and every
   output) is what fixes the trade.
2. **Guard your own covenant cells.** A token cell owned `0x04` by your covenant moves in any transaction in which
   your covenant has an input, whatever entry it runs. Your program must validate every cell it owns that is
   present, as the Kasseal pool does for its own.
3. **Never create a token cell that nobody can safely spend.** Your builder must refuse each of these outputs; the
   pool no longer refuses them for you:
   - a cell owned `0x04` by the token's own covenant id: anyone can spend it;
   - a cell owned `0x04` by the pool's covenant id (other than the reserve's successor): it is locked for good, since
     the pool refuses it as an extra input;
   - a cell owned `0x03` by the P2SH of a pool cell's script or of a reserve's script (in other words, sent to the
     pool's contract address): the pool refuses it as an input, so the tokens are lost to the sender. A cell of
     another token sent there can be taken by whoever submits the next transaction of that pool.
4. **A sell whose tokens come from a covenant cell has no seller signature.** That covenant must bind where the
   released KAS goes.
5. **KCC-20 limits.** At most 3 inputs and 3 outputs of one token per transaction, counting the pool's reserve and its
   successor.
6. **Cells owned by the P2SH of another input's script move with that input** (KCC-20 presence authorization). The
   pool refuses only those owned by its own scripts. A cell of another token owned `0x04` by the pool rides along with
   any pool spend, and can in turn authorize a token cell owned by its script. Do not send tokens to covenant or
   script owners you do not control.
7. **Identify a Kasseal pool by its covenant id, never by its template or its address.** Anyone can create a pool
   cell from the same program under another id: a counterfeit composes exactly like the real one. A pool cell's
   address commits to the program and its current state, not to the id, so a counterfeit in the same state has the
   same address, and the real pool's address changes with every trade. The real pool of a token is the one its
   launch proof names (`graduation.P`, see [launch-proof.md](launch-proof.md)).
8. **The pool's price is not an oracle.** The reserves move with every swap, and anyone can move them, then move them
   back, within one transaction or a short chain of pending ones. Do not value collateral, trigger liquidations,
   settle contracts or set a price anywhere else from a Kasseal pool's state.
9. **Guard your own outputs against double satisfaction.** Your covenant must pin the outputs it pays by position or
   by a commitment only it makes. A rule such as "output 0 pays the maker" can be met by an output another contract
   also counts as its own, including the KAS a Kasseal sell releases.
10. **A borrow-enabled cell (KCC-20 borrow path) can join any transfer as its leader without its owner's
    signature.** Do not treat a cell's presence as its owner's consent.
11. **Build on the latest pool state.** A swap spends the pool cell by outpoint. If another transaction spends it
    first, yours is invalid and must be rebuilt on the new state (section 6).

## 3. The two swap entries

| Entry | Arguments after the state | Kasseal's own shape |
|---|---|---|
| `swapKasForTokens` | `kasInScaled`, `minTokensOut`, `reserveK`, `restK` | The reserve is the only token input (`reserveK = 0`). Token outputs: the successor, then the buyer's cell (`restK = 0`) |
| `swapTokensForKas` | `tokensIn`, `minOutScaled`, `reserveK`, `mergedK` | Token inputs: the seller's cell, then the reserve (`reserveK = 1`). One token output, the merged reserve (`mergedK = 0`) |

`reserveK` counts positions among the transaction's inputs of that token, in input order. `restK` and `mergedK`
count among its outputs of that token.

**Encoding.** The pool input's signature script is `<args> OP_DATA_4 <dispatch tag> <redeem script>`, every integer a
minimal script-number push, in the order of the table.

| Entry | Dispatch tag | Signature |
|---|---|---|
| `swapKasForTokens` | `855ca714` | `(int, int, int, int)` |
| `swapTokensForKas` | `3698a282` | `(int, int, int, int)` |

The SDK encodes and decodes both (`POOL_BUY_COMPOSABLE_TAG`, `POOL_SELL_COMPOSABLE_TAG`).

**Units.** KAS legs are in units of 0.01 KAS (1 unit = 1,000,000 sompi). Token amounts are whole tokens.

**Formulas.** Fee 0.30 % of the KAS leg. 0.10 % of the leg accrues for Kasseal and the creator, rounded to the nearest
unit (half up); the rest of the fee stays in the reserve.

```
buy:  fee       = ceil(kasIn × 30 / 10000)          platform = floor((kasIn × 10 + 5000) / 10000)
      tokensOut = floor(tokenReserve × (kasIn − fee) / (kasScaled + kasIn − fee))
      kasScaled'    = kasScaled + kasIn − platform
      tokenReserve' = tokenReserve − tokensOut

sell: gross     = floor(kasScaled × tokensIn / (tokenReserve + tokensIn))
      fee       = ceil(gross × 30 / 10000)          platform = floor((gross × 10 + 5000) / 10000)
      kasOut    = gross − fee
      kasScaled'    = kasScaled − kasOut − platform
      tokenReserve' = tokenReserve + tokensIn

both: feeAccrued' = feeAccrued + platform
      pool cell value = (kasScaled' + feeAccrued') × 1,000,000 + dust
```

`dust` is the part of the pool cell's value below one unit. A swap carries it unchanged. The SDK's
`swapKasForTokens(state, kasIn, 'uncapped', 'nearest')` and `swapTokensForKas(state, tokensIn, 'uncapped',
'nearest')` compute exactly these numbers.

**Compute budgets.** A pool input needs a compute budget of 23 in a composed transaction (the worst case: a swap
reading two extra token inputs). Kasseal's own two shapes need 16 (buy) and 19 (sell).

## 4. Swaps the pool refuses

A quote that models only the formulas above can produce trades the pool refuses. The pool refuses a swap in each of
these cases, from the pool program of both current builds.

**Both directions**

- The pool cell's state is not well formed (the pool never produces one).
- An LP-share cell of this pool is an input.
- The pool's successor is not exactly one output, or its value is not exactly
  `(kasScaled' + feeAccrued') × 1,000,000 + dust`.
- `kasScaled' + feeAccrued'` exceeds 9,000,000,000,000 units.
- The token inputs: fewer than 1 or more than 3; `reserveK` is negative or not below their count; the input at
  `reserveK` is not the pool-owned reserve (owner `0x04` the pool's id, borrowing disabled, no guard) holding exactly
  `tokenReserve`; or any other token input is owned `0x04` by the pool's id or `0x03` by the P2SH of the pool cell's
  or the reserve's script.
- The token outputs: more than 3; `restK` or `mergedK` is negative or not below their count; the output there is not
  the reserve's exact successor (owner the pool, holding exactly `tokenReserve'`, same template and extension); or
  its KAS value is below the reserve input's.

**Buy (`swapKasForTokens`)**

- `kasInScaled` is 0 or less, or above 7,000,000,000 units (70,000,000 KAS).
- `kasIn − fee` is 0 or less.
- `tokensOut` is less than 1.
- `tokensOut` is less than `minTokensOut`. A negative `minTokensOut` is accepted and has no effect.
- `tokensOut` is not below `tokenReserve`: a buy can never empty the reserve.

**Sell (`swapTokensForKas`)**

- Fewer than 2 token inputs (the tokens sold must come from somewhere other than the reserve).
- `tokensIn` is 0 or less, or above 1,200,000,000; or `tokenReserve + tokensIn` is above 1,200,000,000.
- `gross` is 0 or less, or not below `kasScaled`.
- `kasOut` is below 10 units (0.1 KAS).
- `minOutScaled` is negative.
- `kasOut` is below `minOutScaled`.
- `kasScaled'` is 0 or less.

The SDK's quote functions throw on every case they can see from the state alone (`PoolError`,
`PoolPayoutTooSmallError`, `ArgumentError`), so a quote the SDK returns is one the pool accepts on that state.

## 5. What is composable and what is not

"Composable" is about one token's lineages: the token T and the LP shares L of the pool.

- **Swaps** may share a transaction, and T's transfer, with any other covenant, within the rules above.
- **Add liquidity, remove liquidity and fee payouts (sweeps)** keep exact transaction shapes for their own pool's
  lineages: they cannot share T's or L's transfer with another covenant. They **can** share a transaction with a
  pool of **another** token (a swap there, for example) or with another token's curve. Each entry pins its own
  lineages exactly.
- **Pool setup (`bindLp`)** cannot share a transaction with anything: it allows at most 3 outputs, which leaves no
  room.
- **The bonding curve** keeps exact shapes for its own token, and can share a transaction with another token's
  pool. A token's curve and its pool are never live at the same time.

## 6. Reading the pool's state, pending trades included

Kasseal's app chains swaps on transactions still in the mempool, so the cell to build on is often not yet accepted.
The API serves both the accepted head and the pending tip. It is public and read-only.

| Read | What it gives |
|---|---|
| `GET /tokens/{T}/launch-proof` | The proof; `graduation.P` is the token's real pool |
| `GET /pools/{P}/cell` | The live pool cell (`outpoint`, `amount`, `redeemScript`, decoded `state`) and, while trades are pending, `tip`: the cells at the end of the chain of pending swaps |
| `GET /tokens/{T}/covenant-cells` | The pool's reserve cell (`reserve`), picked by its state rather than by position, and any `strays` sent to the pool |
| Stream `{op:'sub', ch:'token', id:T}` | `pool.state` on every accepted swap, and live-only `pool.tip` frames when the server sends them |

**Which cells to spend.**

- **With a `tip`:** the pool cell from `tip.pool`, the reserve from `tip.reserve`. `tip.via` lists the pending
  transactions the tip follows, oldest first, at most 8. Your transaction depends on them.
- **With no `tip`:** the pool cell from the response, the reserve from `covenant-cells.reserve`, read right after. If
  the reserve does not hold the state's `tokenReserve`, read both again.
- **`headSpent: true`**, or **503 `head-moving`:** the head is changing hands. Wait (`retryAfterMs`) and read again.

**Your own pending transactions.** The tip follows only transactions the API can prove, which are Kasseal's own
shapes. A composed transaction that spends another covenant is not followed, and app swaps wait until it is
accepted. A router building on its own pending transaction should chain on that transaction's outputs, which it
knows, and should expect app swaps to queue behind it.

**Losing a race.** Two transactions that spend the same pool outpoint conflict, and the network accepts one. If yours
loses, it costs nothing; rebuild on the new state. `GET /tx/{txid}` and the stream's `tx` channel report `submitted`,
`accepted`, `confirmed` (at least 10 blue score deep, and only while the node is synced) or `dropped`.

**Indexing.** Kasseal's indexer records every transaction the chain accepts, wherever it was submitted. A routed trade
is attributed by net token flow: a buy to the party that gains the most tokens, a sell to the party that gives the
most.

## 7. The SDK's composable helpers and their safe defaults

**Swap and deposit.** `buildSwap({ side: 'kas->tok', deliverToScript: { redeem, scriptFunding, allowAnyScript? } })`
delivers the bought tokens to a cell owned by a script (`0x03`, owner = P2SH(redeem)) instead of the buyer's key, and
pays `scriptFunding` sompi to that script's address as a plain output: the input that will authorize the cell later.

- **By default only a key-locked script is accepted:** `<32-byte x-only key> OP_CHECKSIG`, built by
  `keyLockedRedeem(key)`. Tokens delivered there can always be moved by that key.
- **`allowAnyScript: true`** accepts another script. Even then the SDK refuses an empty script (anyone could satisfy
  it) and a script that is a pool or token program (tokens delivered there would be locked for good).
- `scriptFunding` must be at least 2,010,000 sompi (0.0201 KAS), the minimum the SDK pays to any plain output.
- Refused with `UnsafeScript`.

**Script sell.** `buildScriptSell({ poolId, redeem, signerXOnly, scriptAddress, payout, allowAnyScript? })` sells a
script-owned cell, authorized by spending a UTXO at the script's address.

- `scriptAddress` must be exactly P2SH(`redeem`).
- By default `redeem` must be the key-locked form, locked to `signerXOnly`.
- `allowAnyScript` lifts the key-locked requirement only; pool and token programs stay refused.

**Multi-cell sell.** `buildSwap({ side: 'tok->kas', extraCell })` sells two of your own cells in one swap without
merging them first. KCC-20 allows at most three token inputs: your two cells and the reserve.

**Your own shapes.** For anything else, the SDK gives you the pieces: the signature-script encoders
(`poolSwapKasForTokensSigScript`, `poolSwapTokensForKasSigScript`), the pool state codec, the quote functions and the
mass model. You are then responsible for every rule in section 2.
