# Examples

Small TypeScript programs against **testnet-10** and the public API at `https://app.kasseal.com/v1`. They are not
run in CI. Use a testnet-10 wallet with test KAS only; never a mainnet key.

Run them with Node 22.6 or later (`node --experimental-strip-types examples/<file>.ts`) or any TypeScript runner.

| File | What it does | Needs a key |
|---|---|---|
| [`quote.ts`](quote.ts) | Quotes a pool buy, a pool sell, or a curve buy, with a slippage bound | No |
| [`verify-launch-proof.ts`](verify-launch-proof.ts) | Verifies a token's launch proof, including the graduation check | No |
| [`pool-buy.ts`](pool-buy.ts) | The full flow: proof, build on the latest state, sign, submit, safe retry | Yes (`KEY`) |
| [`swap-and-deposit.ts`](swap-and-deposit.ts) | A pool buy delivered to a key-locked script | Yes (`KEY`) |
| [`pool-sell-wallet.ts`](pool-sell-wallet.ts) | A pool sell signed by a browser wallet (module for a web page) | Wallet |
| [`lib/api.ts`](lib/api.ts) | A minimal REST client: reads, submission and status (the builder's sources are the SDK's `createApiSources`) | |
| [`lib/proof.ts`](lib/proof.ts) | Launch-proof check with the public Kaspa API graduation check | |

Pass the key in the environment (`KEY=...`), never on the command line of a shared machine and never in a file you
commit.
