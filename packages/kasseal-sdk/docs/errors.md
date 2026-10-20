# Errors

Every failure the SDK raises on purpose is an instance of a named error class with a stable code string. Read it
with `errorCode(e)` (or test it with `isKassealError(e, 'CODE')`); match on the code or on `instanceof`, never on the
message: messages are for people and may change in any release. The code is also the error's `code` property,
except on the three wallet errors, whose `code` is the wallet's own numeric code. A code never changes meaning within
a major version (see [STABILITY.md](../STABILITY.md)). `ERROR_CODES` lists every code; the package's release checks
assert that this page and that list name exactly the same classes and codes.

```ts
try {
  built = await builder.buildSwap(params);
} catch (e) {
  switch (errorCode(e)) {
    case 'PROOF_NOT_BOUND':   /* verify the launch proof first */ break;
    case 'NEEDS_SPLIT':       /* carve an exact cell: e.cell, e.carve */ break;
    case 'NET_BOUND_EXCEEDED': /* the fee or deposit moved: show the new total */ break;
    default: throw e;
  }
}
```

The rule behind most of them: **the SDK refuses rather than guesses.** No error below means funds moved; each one is
raised before anything is signed or submitted.

## Launch proof and identity

| Class | `code` | Raised when |
|---|---|---|
| `ProofNotBound` | `PROOF_NOT_BOUND` | A buy, pool buy or deposit without `proofVerdict: 'bound'` |
| `CurveNotOfProof` | `CURVE_NOT_OF_PROOF` | The curve asked for is not the one the verified proof names (`expectedCurveId`) |
| `PoolNotOfProof` | `POOL_NOT_OF_PROOF` | The pool asked for is not the one the verified proof names (`expectedPoolId`) |
| `LineageMismatch` | `LINEAGE_MISMATCH` | The served curve or pool trades another token than `tokenId` |
| `UnknownCurveTemplate` | `UNKNOWN_CURVE_TEMPLATE` | The served curve program is not one of the bundled builds |
| `TreasuryNotAllowedOnNetwork` | `TREASURY_NOT_ALLOWED_ON_NETWORK` | A program's fee recipient is not one this network allows |
| `ForeignCovenantInput` | `FOREIGN_COVENANT_INPUT` | A transaction would spend a covenant cell of another lineage, or a P2SH output as plain funding |
| `CovenantCellValue` | `COVENANT_CELL_VALUE` | A curve-owned cell is served with less KAS than the contract allows: the served data cannot be real |
| `CovenantCellNotFound` | `COVENANT_CELL_NOT_FOUND` | No served cell has the exact state the covenant pins (for example the pool's reserve) |
| `TokenAmountMismatch` | `TOKEN_AMOUNT_MISMATCH` | A curve sell would take another number of tokens than the caller approved (`expectedTokens`) |

## Amounts, bounds and shapes

| Class | `code` | Raised when |
|---|---|---|
| `NetBoundExceeded` | `NET_BOUND_EXCEEDED` | The all-in cost exceeds `maxAllIn`, or the net payout is below `minNetOut` |
| `SlippageOutOfRange` | `SLIPPAGE_OUT_OF_RANGE` | A slippage tolerance is negative, above 10 %, finer than 0.01 %, or not a number |
| `NeedsSplit` | `NEEDS_SPLIT` | A sell or deposit needs one cell of an exact amount; `cell` is to be split, carving `carve` |
| `NeedsConsolidation` | `NEEDS_CONSOLIDATION` | The amount is spread over several cells; `cells` are to be merged (at most 3 per transaction) |
| `InsufficientTokensError` | `INSUFFICIENT_TOKENS` | The owner's cells hold fewer tokens than asked |
| `InsufficientFundsError` | `INSUFFICIENT_FUNDS` | The wallet's KAS does not cover the trade, the deposit and the fee |
| `PinnedFundingGone` | `PINNED_FUNDING_GONE` | A coin pinned for a retry (`fundingOptions.required`) is gone: the first attempt may have landed. Ask before building again |
| `ResidualBelowMinimum` | `RESIDUAL_BELOW_MINIMUM` | The inputs cannot cover the outputs and the fee while leaving the payout or change its minimum |
| `FloorViolation` | `FLOOR_VIOLATION` | An output would carry less KAS than the minimum for its kind, or a token output would be owned by its own token (anyone could spend it) |
| `TokenRecipientRefused` | `TOKEN_RECIPIENT_REFUSED` | A built transaction would send tokens somewhere the caller did not name |
| `UnsafeScript` | `UNSAFE_SCRIPT` | A swap-and-deposit or script sell names a script that is not key-locked (without `allowAnyScript`), is empty, or is a pool or token program; or a script sell's address or key does not match |
| `ShapeNotSupported` | `SHAPE_NOT_SUPPORTED` | The contracts cannot accept the requested transaction shape |
| `LpUnsafe` | `LP_UNSAFE` | A deposit on a pool whose liquidity invariants the indexer does not confirm (`lpSafe` false). Withdrawals are never refused for this |
| `RatioDriftError` | `RATIO_DRIFT` | The pool's KAS-to-token ratio moved 1 % or more since the liquidity quote: quote again and ask the user |
| `ClaimMismatch` | `CLAIM_MISMATCH` | A built fee payout pays something other than the plan |

## Fees and mass

| Class | `code` | Raised when |
|---|---|---|
| `FeerateOutOfRange` | `FEERATE_OUT_OF_RANGE` | The fee rate from the API is below the network minimum or above 20 times it: it is not used |
| `FeeAboveCeiling` | `FEE_ABOVE_CEILING` | The computed fee would exceed the SDK's ceiling for the transaction: nothing is built |

## Signing, submission and retries

| Class | `code` | Raised when |
|---|---|---|
| `FinalizeError` | `FINALIZE` | A signed transaction differs from the built one: another id, a changed input, a missing or invalid signature, a sighash other than `SIGHASH_ALL`, other masses |
| `SighashError` | `SIGHASH` | A sighash cannot be computed for the given transaction and input |
| `SignRequestError` | `SIGN_REQUEST` | A signature slot in a signing request is not where it should be, or is not empty |
| `RejectedError` | `REJECTED` | A node refused the transaction; carries the classified reason |
| `ReplacementRefused` | `REPLACEMENT_REFUSED` | A fee-bump replacement is not allowed: the transaction is not one of yours, not in a replaceable state (a lost race is never replaced: rebuild instead), or the replacement does not spend the same inputs or pay enough more |
| `RetryPolicyError` | `RETRY_POLICY` | The retry policy is misconfigured or used out of order |
| `InvalidTransition` | `INVALID_TRANSITION` | A submission state changed in a way the state machine does not allow |
| `OptimisticConflict` | `OPTIMISTIC_CONFLICT` | The pending-trade tracker was given a transaction twice, or one whose recorded effects do not match what it spends |

## Runtime and artifacts

| Class | `code` | Raised when |
|---|---|---|
| `UnsupportedNetwork` | `UNSUPPORTED_NETWORK` | A network id other than `mainnet` or `testnet-10`, or none where one is required |
| `UnsupportedBuild` | `UNSUPPORTED_BUILD` | A contract build that is not the network's bundled build |
| `SdkIntegrityError` | `SDK_INTEGRITY` | A bundled Kaspa WASM SDK file (Node entry), or the WASM bytes given to or fetched by `initWeb` (web entry), does not match its pinned SHA-256 |
| `ArtifactIntegrityError` | `ARTIFACT_INTEGRITY` | A bundled contract artifact or the artifact manifest is missing, altered or not listed |
| `SdkNotInstalled` | `SDK_NOT_INSTALLED` | A build or signing call before the WASM is loaded: import the Node entry, or await `initWeb` |
| `ArtifactMissing` | `ARTIFACT_MISSING` | A contract artifact the call needs is not in the bundle |
| `ArtifactNotLoaded` | `ARTIFACT_NOT_LOADED` | A curve preset's artifacts are not loaded yet in the browser: await `ensurePresetArtifacts` |
| `ArtifactSourceNotInstalled` | `ARTIFACT_SOURCE_NOT_INSTALLED` | The contract artifacts are not loaded yet |
| `ContractSetNotSupported` | `CONTRACT_SET_NOT_SUPPORTED` | A contract set this SDK does not build for |

## Wallets and addresses

| Class | `code` | Raised when |
|---|---|---|
| `WalletUnavailable` | `WALLET_UNAVAILABLE` | The wallet extension is not installed in this browser |
| `WalletNotConnected` | `WALLET_NOT_CONNECTED` | Call `connect()` first |
| `WalletNetworkMismatch` | `WALLET_NETWORK_MISMATCH` | The wallet is on another network than the adapter's `network` |
| `WalletAccountMismatch` | `WALLET_ACCOUNT_MISMATCH` | The account's address is not of the network, or its reported key does not match its address |
| `KasWareError` | `KASWARE` | KasWare answered with an error. `rejectedByUser` is true when the user declined (code 4001); `code` is the wallet's numeric code |
| `KastleError` | `KASTLE` | Kastle answered with an error; as above |
| `KaspireError` | `KASPIRE` | Kaspire answered with an error; as above |
| `MessageSigningUnsupported` | `MESSAGE_SIGNING_UNSUPPORTED` | The wallet cannot sign messages |
| `MessageSignatureError` | `MESSAGE_SIGNATURE` | A message signature is malformed |
| `AddressError` | `ADDRESS` | An address does not decode, or is not the expected kind |

## Decoding

| Class | `code` | Raised when |
|---|---|---|
| `UnknownTemplateError` | `UNKNOWN_TEMPLATE` | A program's template hash is not on the verified list: never decoded by guesswork |
| `TemplateMismatchError` | `TEMPLATE_MISMATCH` | The program hashes to another template than the one asserted |
| `TemplateNotDecodableError` | `TEMPLATE_NOT_DECODABLE` | The template is known but its state cannot be decoded |
| `LayoutError` | `LAYOUT` | The base class of the template, decoding, validation, supply, ownership and transfer errors |
| `DecodeError` | `DECODE` | Bytes are not a canonical encoding |
| `SigScriptError` | `SIGSCRIPT` | A signature script is not one of the contracts' entry encodings |
| `StateCodecError` | `STATE_CODEC` | A cell state does not encode or decode canonically |
| `DeclarationError` | `DECLARATION` | A KCC-23 declaration payload is malformed |
| `ValidationError` | `VALIDATION` | A decoded or constructed state breaks a layout rule |
| `SupplyError` | `SUPPLY` | A transfer would break supply conservation |
| `OwnershipError` | `OWNERSHIP` | A transfer would break an ownership rule |
| `TransferError` | `TRANSFER` | A KCC-20 transfer breaks a structural rule (counts, witness, extension) |
| `StateJsonError` | `STATE_JSON` | A state served as JSON is malformed |

## Quote math

All extend `CurveMathError`. The quote functions are total: invalid input raises one of these, never `NaN` or a
silently clamped value.

| Class | `code` | Raised when |
|---|---|---|
| `CurveMathError` | `CURVE_MATH` | The base class of the errors below |
| `ArgumentError` | `ARGUMENT` | An argument is not a bigint or outside its domain |
| `SellPayoutTooSmallError` | `SELL_PAYOUT_TOO_SMALL` | A curve sell would pay less than 0.1 KAS net: the curve refuses it |
| `ParameterError` | `PARAMETER` | Curve constants break a cap |
| `OverflowError` | `OVERFLOW` | A value would leave the contracts' 64-bit integer range |
| `PoolError` | `POOL` | A pool swap the pool would refuse: zero output, a leg above its cap, a reserve emptied |
| `PoolPayoutTooSmallError` | `POOL_PAYOUT_TOO_SMALL` | A pool sell would pay less than 0.1 KAS |
| `LpError` | `LP` | The base class of the liquidity errors below |
| `LpStateError` | `LP_STATE` | The pool state is malformed for liquidity |
| `LpShareCountError` | `LP_SHARE_COUNT` | Fewer than 1 share |
| `LpSharesCapError` | `LP_SHARES_CAP` | A deposit would exceed the pool's share cap |
| `LpReserveCapError` | `LP_RESERVE_CAP` | A deposit would push a reserve above its cap |
| `LpFloorError` | `LP_FLOOR` | A withdrawal would reach into the locked graduation shares |
| `LpPayoutTooSmallError` | `LP_PAYOUT_TOO_SMALL` | A withdrawal's KAS leg is below 0.1 KAS |
| `LpTokenLegTooSmallError` | `LP_TOKEN_LEG_TOO_SMALL` | A withdrawal's token leg is zero |
| `LpInvariantError` | `LP_INVARIANT` | A defensive check failed; report it as a bug |
| `LpInventoryError` | `LP_INVENTORY` | The pool's share inventory does not hold what the state requires |
| `StandardBandOutOfRange` | `STANDARD_BAND_OUT_OF_RANGE` | A KAS price outside the range the Standard curve bands cover |

## API data sources

| Class | `code` | Raised when |
|---|---|---|
| `NotSupported` | `NOT_SUPPORTED` | A `DataProvider` does not implement the requested call |
| `ApiError` | `API_ERROR` | `createApiSources`: the API answered with an error (after the waits for 429 and 503 ran out); `status` and `problem` carry the answer |
| `HeadMoving` | `HEAD_MOVING` | `createApiSources`: the curve or pool head is changing hands; read again in about a second. Nothing was built |

## API errors

Errors from the Kasseal API are HTTP problem details, not SDK classes: see [api.md](api.md#problem-codes-you-will-meet).
