# Security policy

Kasseal moves real funds on Kaspa L1. We take every report seriously and thank everyone who reports responsibly.

## Reporting a vulnerability

**Report privately through GitHub's private vulnerability reporting:** open the SDK's repository on GitHub, go to
the **Security** tab and choose **Report a vulnerability**. This is the only channel for security reports. Do not
open a public issue, post on social media or discuss it in a public channel until it is fixed.

Please include:

- what is affected: the SDK version, the contract build (`v1-kasseal-mainnet-2` or `v1-kasseal-mainnet-2-tn10`), the
  API route, or the app page;
- the steps to reproduce, or a proof of concept (testnet-10 only);
- the impact as you understand it: whose funds, how much, under what conditions;
- how to reach you, and whether you want to be credited.

**Test on testnet-10 only.** Never test against mainnet funds, other users' funds or Kasseal's infrastructure beyond
normal API use. Do not degrade the service for others (no load testing, no denial of service).

## What happens next

These are our goals, not guarantees; we will tell you in the report if we expect to miss one.

| Step | Goal |
|---|---|
| We acknowledge your report | Within 3 business days |
| We confirm or dispute the issue and share our assessment | Within 10 business days |
| We fix it, or agree a timeline with you | Depends on severity; funds-at-risk issues come first |
| We publish an advisory and credit you (if you wish) | When the fix is released |

We aim to disclose publicly within 90 days of your report, and sooner when a fix ships sooner; we ask you not to
disclose before then. If an issue is being exploited, we may disclose earlier to protect users, and we will tell you
first.

## Scope

In scope:

- this SDK (`@kassealhq/sdk`): quote math, transaction builders, launch-proof verification, signing and submission
  helpers, wallet adapters;
- the bundled contract builds and their artifacts;
- the public Kasseal API, where a flaw could mislead an integrator into an unsafe transaction.

Out of scope: the Kaspa node and consensus, third-party wallets, the public Kaspa REST API, and issues that need a
compromised user device or key.

## What we consider most serious

- Anything that lets someone take value from a curve, a pool, a liquidity provider, Kasseal's treasury or a user who
  did not sign for it.
- A way to make the SDK build, or ask a user to sign, a transaction other than the one it showed.
- A way to make the launch-proof verifier report `bound` for a token, curve or pool that is not genuine.
- A way to make the SDK accept artifacts or a WASM build that do not match their pinned hashes, or a Kaspa SDK passed
  to `initWeb` (`kaspa` option) that builds, serialises or signs differently from the pinned build and still passes
  the known-answer test.

## Supported versions

Security fixes go into the latest 0.x release. A release with a security fix is announced in the
[CHANGELOG](CHANGELOG.md), and affected versions are marked deprecated on npm. See [STABILITY.md](STABILITY.md).
