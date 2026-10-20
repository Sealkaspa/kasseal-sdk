/**
 * The transaction builder for the Kasseal lineages, as the build checks and the byte-parity check load it from
 * source (`index.node.ts` installs the Kaspa SDK and the contract artifacts from disk). The published package is
 * built from `packages/kasseal-sdk/src` instead.
 *
 *   program.ts    artifacts, programs R, states and decoding of T / C / P cells
 *   artifacts.ts  the installed source of the committed contract artifacts
 *   sigscript.ts  KCC-1 sigscripts for every entrypoint; signature slots; R recovery
 *   mass.ts       the v2.1.0 mass and fee model; compute-budget table
 *   assemble.ts   TxPlan -> finalized SDK transaction (fee fixed point, bindings, genesis ids, signing)
 *   cells.ts      plan fragments and the builder context
 *   instance.ts   the network launch rules (mainnet: Standard only)
 *   payout.ts     fee payouts per contract set (v1 50/50) and the graduation fold
 *   vault.ts      companion-contract artifacts (none ship; the mainnet treasury rule reads their absence)
 *   quote.ts      lot rounding in the user's favour: lots for a KAS budget (floor), lots of a token amount, the smallest sell
 *   recipients.ts the pre-sign recipient check: every token output re-derived from its claimed state, owners the
 *                 connected key or a named covenant
 *   slippage.ts   slippage bounds (max paid, min received), refused outside [0, 10 %] and never widened by rounding
 *   shapes/       one module per transaction shape: buy, sell, split, bind-lp, liquidity, consolidate, sweep (curve,
 *                 pool), graduate, swaps; roles and optimistic delta
 *   select/       funding selection, token-cell selection, the consolidation planner, output floors
 *   builder.ts    the asynchronous TxBuilder over UtxoSources
 *   submit.ts     node-side submission with budget patching and acceptance polling (for server-side signers)
 *   submit/       SubmitState machine, verbatim rejection classifier, retry policy, replacement
 *   optimistic.ts OptimisticDelta store: apply, commit, rollback, chained trades
 *   wallet/       Kaspire, KasWare and Kastle adapters, request preparation and signature splicing, own v1 sighash
 *   kip24.ts      KCC-23 declarations, plainTxFromSdk; KIP-24 txid re-exported from @kasseal/codec
 *   types.ts      public types: CovenantCell, UtxoSources, BuiltTx, TxBuilder, SubmitState, OptimisticDelta
 *   finalize.ts   AssembledTx -> BuiltTx (SafeJSON, inputs to sign); wallet answer -> final transaction
 *   sha256.ts     synchronous SHA-256 for both builds
 *   blake2b.ts    P2SH commitment and KIP-20 covenant id (re-exported from @kasseal/codec)
 *   blake3-keyed.ts keyed BLAKE3 for KIP-24 (re-exported from @kasseal/codec)
 *
 * Hashing (BLAKE2b, keyed BLAKE3, the KIP-24 txid) and sigscript argument
 * encoding and decoding are pure TypeScript in the codec, shared with
 * servers and the browser; this package re-exports them.
 */
export * from './blake2b.ts';
export * from './blake3-keyed.ts';
export * from './sha256.ts';
export * from './artifacts.ts';
export * from './kip24.ts';
export * from './program.ts';
export * from './sigscript.ts';
export * from './mass.ts';
export * from './assemble.ts';
export * from './cells.ts';
export * from './instantiate.ts';
export * from './instance.ts';
export * from './treasury.ts';
export * from './payout.ts';
export * from './vault.ts';
export * from './quote.ts';
export * from './recipients.ts';
export * from './slippage.ts';
export * from './shapes/index.ts';
export * from './select/floors.ts';
export * from './select/funding.ts';
export * from './select/cells.ts';
export * from './select/covenant.ts';
export * from './fee-bytes.ts';
export * from './proof-params.ts';
export * from './select/planner.ts';
export * from './select/liquidity.ts';
export * from './builder.ts';
export * from './claims.ts';
export * from './submit.ts';
export * from './submit/index.ts';
export * from './optimistic.ts';
export * from './wallet/index.ts';
export * from './sdk.ts';
export * from './types.ts';
export * from './finalize.ts';
export * from './required.ts';
