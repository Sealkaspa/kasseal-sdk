# The launch proof

Every Kasseal token has a **launch proof**: the two launch transactions and, once the token has graduated, the
graduation transaction. Verifying it shows, from the transactions alone, that the token, its curve and its pool are
genuine Kasseal programs, linked to each other, with a sealed supply. Verify it before you trade a token, label it,
or show it as verified.

The API serves the bundle at `GET /tokens/{T}/launch-proof`. The SDK verifies it in your own process. Nothing in the
bundle is trusted: every id and hash is recomputed. The verifier trusts only two things the SDK carries itself:

- the KCC-20 reference token program, whose template hash is checked when it loads
  (`9703112ee6e3555107cd168858992b77d3b74f655205b2b463b1f9ec2ec73cf7`);
- the curve programs of the bundled contract builds, to check the curve's constants.

## Verdicts

| Verdict | Meaning | What to do |
|---|---|---|
| `bound` | Every step passed | Trade, using only the curve id and pool id the proof names |
| `unverified` | Something could not be proven: the preparation transaction is missing, the curve is not one of the bundled builds, or the graduation is not found on chain yet | Do not buy or deposit. Ask again later. A holder may still sell or withdraw |
| `invalid` | A recomputation disagreed with the bundle | Do not trade. Do not show the token as verified |
| `malformed` | The bundle does not parse | As `invalid` |

The builders enforce this: a curve buy, a pool buy and a deposit are refused unless you pass `proofVerdict: 'bound'`
(`ProofNotBound`). Sells and withdrawals are never gated, so a holder can always leave.

## What it verifies

| Step | Name | What is checked |
|---|---|---|
| 1 | Lineage T | The launch transaction's two outputs bound to the token id share one authorizing input, and the token id recomputes from that input's outpoint |
| 2 | Program | Each token cell's address commits to the unmodified KCC-20 reference program with the stated state, byte for byte |
| 3 | State | Both token cells are owned by the curve C under the covenant-id scheme, with borrowing and extension fields zero, and their amounts sum to the supply the curve's constants give |
| 4 | Sealing | The reference program only conserves supply, and consensus makes any other cell with the token's id impossible to create (a stated argument, not a computation) |
| 5 | Lineage C | The curve id recomputes from the preparation transaction; exactly one output carries it; the curve's program hashes to the stated template; its constants are read from the program itself and must equal the bundle's `params` |
| 6 | Custody | Curve-owned token cells move only through the curve's own entries, at the coded price (a stated argument) |
| 7 | Metadata | The token's KCC-23 declaration is the payload of the preparation transaction, and that transaction's id recomputes |
| 8 | Program recovery | The curve program revealed when the curve started is the one the preparation transaction committed to, and it was given the reference token program |
| 9 | Graduation | Once graduated: exactly one output carries the pool id P (the pool's first cell), and exactly one output carries the token: the 400,000,000-token reserve, now owned by P. The graduation was the curve's own `graduate` entry at its last lot, and the reserve it spent was the curve's own |

Before graduation, step 9 passes as not applicable.

The SDK reads signature scripts the way consensus does. A consensus-valid but non-minimal encoding is reported as a
note (`notes`), never as a failure.

## The graduation check against the public Kaspa API

Steps 1 to 9 run on the transactions the Kasseal API serves. A compromised or intercepted API could serve a doctored
graduation that names a counterfeit pool. So, once a token has graduated, confirm the graduation against a source
Kasseal does not operate:

1. Recompute the graduation transaction's id from the served transaction (`txidV1`). The id commits to every spent
   outpoint and every output, covenant bindings included.
2. Ask the public Kaspa REST API for that id (`https://api.kaspa.org` on mainnet, `https://api-tn10.kaspa.org` on
   testnet-10): `GET /transactions/{txid}?inputs=true&outputs=false&resolve_previous_outpoints=no`.
3. Compare: the transaction must be accepted (`is_accepted: true`), and every input's previous outpoint and
   signature script must equal the served ones. Signature scripts are not part of the id, and step 9 reads the
   reserve's program from them.

| Answer | Meaning | Verdict |
|---|---|---|
| Accepted, same inputs and signature scripts | Confirmed | Stays `bound` |
| Different transaction or signature scripts | The served graduation is not the real one | `invalid` |
| Not found, or not accepted | Not indexed yet (seconds after a graduation), or never mined | `unverified` until found; ask again |
| The public API cannot be read | Unknown | Stays as checked from the served data |

`graduationOnChain(json, network)` runs this step (it never throws; `confirmed`, `mismatch`, `not-found`,
`unavailable`, or `none` before graduation). [examples/lib/proof.ts](../examples/lib/proof.ts) puts the whole check together.

## Running it

```ts
import { graduationOnChain, launchProofFromJson, verifyLaunchProofJson } from '@kassealhq/sdk/node';

const network = 'mainnet';                         // testnet-10: https://testnet.kasseal.com/v1
const json = await (await fetch(`https://app.kasseal.com/v1/tokens/${tokenId}/launch-proof`)).json();

// Steps 1 to 9, against the SDK's own reference token program and the curve programs of the network's bundled build.
// Never throws on bundle content: a bundle that does not parse is 'malformed'.
const result = verifyLaunchProofJson(json, network);
let verdict = result.status;

if (verdict === 'bound') {
  const bundle = launchProofFromJson(json);
  const curveId = bundle.C;                          // pass as expectedCurveId
  if (bundle.graduation) {
    // The graduation check against the public Kaspa REST API (above).
    const onChain = await graduationOnChain(json, network);
    if (onChain === 'mismatch') verdict = 'invalid';
    if (onChain === 'not-found') verdict = 'unverified';
    const poolId = bundle.graduation.P;              // pass as expectedPoolId, only while the verdict is 'bound'
  }
}
```

`verifyLaunchProofJson` reports a curve program that is not one of the bundled builds as `unverified`: its constants
cannot be checked. The lower-level `verifyLaunchProof(bundle, trust)` takes the parsed bundle and trust anchors you supply
(`referenceTokenSuffix()`, and `curveTemplateTrust(curveBasesOf(network), onUnmatched)` for the curve check). If you
use it, treat a `bound` result as `unverified` whenever `onUnmatched` was called, as `verifyLaunchProofJson` does.

Unless the bundle is `malformed`, `result.steps` lists every step with its outcome and details; `result.reason` names
the first failure.

The response also carries `verifier.result`, the Kasseal indexer's own verdict. It is useful for display, but your
own check is the one to trade on.

## Use the ids the proof names

Once the proof is `bound`, take the curve id `C` and the pool id `graduation.P` from it, and from nowhere else. Pass
them to the builders as `expectedCurveId` and `expectedPoolId`, and pass `tokenId: T`. The builder then refuses a
curve or pool the API serves that is not the proven one, before it reads or builds anything.
