/**
 * @kassealhq/sdk: quotes, transaction builders, launch-proof verification, submission helpers and wallet adapters for
 * Kasseal tokens on Kaspa.
 *
 * This entry is pure logic: importing it loads no WASM and reads no files. Import `@kassealhq/sdk/node` or
 * `@kassealhq/sdk/web` (which re-export everything here) to install the pinned Kaspa SDK and the bundled contract
 * artifacts before building transactions.
 */

// Errors first: the stable codes are installed on the error classes when this module loads.
export { ERROR_CODES, errorCode, isKassealError } from './errors.ts';
export {
  API_BASE_URLS, BUILD_OF_NETWORK, NETWORKS, SUPPORTED_BUILDS, UnsupportedBuild, UnsupportedNetwork, assertNetwork, buildOf, createContext, createTxBuilder, isKassealNetwork,
  type KassealNetwork, type PublicTxBuilder, type TxBuilderOptions,
} from './networks.ts';
export {
  ArtifactIntegrityError, SdkIntegrityError, artifactManifest, artifactPathsOfBuild, kaspaSdkDigests, type ArtifactBuildInfo, type ArtifactManifest,
} from './integrity.ts';
export { curveBasesOf, referenceTokenSuffix, verifyLaunchProofJson, type LaunchProofReport } from './proof.ts';
export {
  PUBLIC_KASPA_API, compareGraduationWithChain, graduationOnChain, type GraduationOnChain, type GraduationOnChainOptions, type PublicApiTransaction,
} from './graduation.ts';
export { ApiError, HeadMoving, createApiSources, type ApiSourcesOptions } from './api.ts';

/* ------------------------------------------------------------------ */
/* Curve and pool maths                                                */
/* ------------------------------------------------------------------ */

export * from '../../curve-math/src/errors.ts';
export * from '../../curve-math/src/bands.ts';
export * from '../../curve-math/src/lp.ts';
export {
  BPS_DENOMINATOR, CURVE_LOTS_COARSE, CURVE_LOTS_DEFAULT, CURVE_LOTS_MAX, CURVE_PAYOUT_MIN, FEE_BPS_MAX, INIT_GRAD_FEE_MIN, K_MAX, K_MAX_8000_LOTS, K_MAX_FINE, P0_MAX, POOL_ESCROW_MAX,
  buyQuote, cost, fee, finalLotFee, finalLotsFee, fullRaise, initEscrowFits, kCap, lastLotPrice, lotPrice, sellQuote, validateCurveParams,
  type CurveParams as CurveMathParams, type Quote,
} from '../../curve-math/src/curve.ts';
export {
  DEFAULT_PRESET, GRAD_RESERVE_MAX, LOT_MAX, PRESET_STANDARD, PRESET_STANDARD_REFERENCE_KAS_USD, curveSupply, gradReserve, graduationMarketCapSompi, graduationMarketCapUsd, validatePreset,
  type LaunchPreset,
} from '../../curve-math/src/presets.ts';
export * from '../../curve-math/src/graduation.ts';
export {
  KAS_SCALE, LP_SHARES_GENESIS, POOL_CREATOR_FEE_BPS_V2, POOL_FEE_BPS, POOL_KAS_IN_MAX, POOL_KAS_SCALED_MAX, POOL_KAS_VALUE_MAX, POOL_PAYOUT_MIN_SCALED, POOL_PLATFORM_FEE_BPS,
  POOL_RESERVE_FEE_BPS, POOL_SWEEP_MIN_SCALED, POOL_TOKEN_RESERVE_MAX, fromKasScaled, invariant, openPool, poolCellValue, poolSweepSplit, spotPricePerLot, swapKasForTokens, swapTokensForKas,
  sweepPool, toKasScaled, validatePool,
  type BuyResult as PoolMathBuyResult, type PlatformRounding, type PoolFee, type PoolLimits, type PoolState, type PoolSweepSplit, type SellResult as PoolMathSellResult,
  type SweepResult as PoolMathSweepResult,
} from '../../curve-math/src/pool.ts';

/* ------------------------------------------------------------------ */
/* Codec: cells, programs, hashes, KIP-24, KCC-23 launch proofs        */
/* ------------------------------------------------------------------ */

export * from '../../codec/src/errors.ts';
export * from '../../codec/src/types.ts';
export * from '../../codec/src/auth.ts';
export { bytesEqual, concat, fromHex, toHex } from '../../codec/src/push.ts';
export * from '../../codec/src/blake3.ts';
export * from '../../codec/src/blake3-keyed.ts';
export * from '../../codec/src/blake2b.ts';
export * from '../../codec/src/sha256.ts';
export * from '../../codec/src/template-hash.ts';
export * from '../../codec/src/registry.ts';
export * from '../../codec/src/kcc20-46.ts';
export * from '../../codec/src/kcc0020-112.ts';
export * from '../../codec/src/templates.ts';
export * from '../../codec/src/kip24.ts';
export * from '../../codec/src/program.ts';
export * from '../../codec/src/push-rule.ts';
export * from '../../codec/src/number-rule.ts';
export * from '../../codec/src/cell-state.ts';
export * from '../../codec/src/kcc0023.ts';
export * from '../../codec/src/display-text.ts';
export { createDefaultRegistry } from '../../codec/src/index.ts';

/* ------------------------------------------------------------------ */
/* Programs, templates and contexts                                    */
/* ------------------------------------------------------------------ */

export {
  ArtifactMissing, ArtifactNotLoaded, ArtifactSourceNotInstalled, BUILDER_CONTRACT_SETS, ContractSetNotSupported, DEFAULT_CONTRACT_SET, V1_COMPOSABLE_REVISION, V1_COMPOSABLE_TWIN_REVISION,
  ensurePresetArtifacts, hasOpenLiquidity, launchRevisionOf, presetArtifactsPending,
  type ArtifactSource, type BuilderContractSet, type PoolTemplateSet,
} from '../../txbuilder/src/artifacts.ts';
export {
  BORROW_SCHEME_DISABLED, CellDecoder, POOL_KAS_SCALE, POOL_UNBOUND_LP_COV_ID, StateJsonError, assertEntryTags, covenantOwnedToken, curveProgram, curveStateFromJson, curveStateToJson,
  defaultRegistry, entrySignaturesOf, isComposablePool, isCovenantOwnedBy, isP2shSpk37, isTreasurySpkOf, loadCurveTemplate, loadCurveTemplateOf, loadPoolTemplate, loadTokenTemplate,
  lpBoundToPool, lpExtensionOf, poolProgram, poolStateFromJson, poolStateToJson, scriptHashOf, scriptOwnedToken, templateDescriptor, tokenProgram, tokenStateFromJson, tokenStateToJson,
  userToken,
  type CellKind, type CurveParams, type CurveTemplate, type DecodedCell, type PoolTemplate, type Template, type TokenTemplate,
} from '../../txbuilder/src/program.ts';
export {
  budgetsOf, budgetsV3Of, changeTo, contextSet, curveInput, curveOutput, kasInput, payoutTo, plainOutput, poolInput, poolLimitsOf, poolOutput, poolRoundingOf, poolTemplateRounding,
  tokenDelegatorCovenantInput, tokenDelegatorSignedInput, tokenLeaderCovenantInput, tokenLeaderSignedInput, tokenOutput, tokenResidual,
  type BuilderContext,
} from '../../txbuilder/src/cells.ts';
export * from '../../txbuilder/src/instantiate.ts';
export { contextForCurveTemplate, curveParamsForProof, curveTemplateTrust } from '../../txbuilder/src/proof-params.ts';
export { committedPresets } from '../../txbuilder/src/builder.ts';
export {
  MAINNET_COMPANY_ADDRESS, TreasuryNotAllowedOnNetwork, allowedTreasurySpks, assertTreasuryAllowedOnNetwork, isTreasuryAllowedOnNetwork, mainnetCompanySpk, mainnetTreasurySpks,
  p2pkTreasurySpkOfAddress, treasuryProblemOf,
} from '../../txbuilder/src/treasury.ts';
export { MAINNET_NETWORK_ID } from '../../txbuilder/src/instance.ts';
export * from '../../txbuilder/src/payout.ts';
export { launchPresetOf } from '../../txbuilder/src/shapes/create.ts';

/* ------------------------------------------------------------------ */
/* Quotes and slippage                                                 */
/* ------------------------------------------------------------------ */

export * from '../../txbuilder/src/quote.ts';
export * from '../../txbuilder/src/slippage.ts';

/* ------------------------------------------------------------------ */
/* Transactions: plans, mass and fees, sigscripts, assembly            */
/* ------------------------------------------------------------------ */

export * from '../../txbuilder/src/assemble.ts';
export {
  APP_BUY_POSITIONS, APP_SELL_POSITIONS, P2PK_PLACEHOLDER_SIGSCRIPT, SCHNORR_SIG_LENGTH, ZERO_SIG65, curveBuySigScript, curveSellSigScript, curveSweepSigScript, parsePushes,
  poolAddLiquiditySigScript, poolBindLpSigScript, poolRemoveLiquiditySigScript, poolSwapKasForTokensSigScript, poolSwapTokensForKasSigScript, poolSweepSigScript, pushByte, pushInt,
  pushKcc20Full, pushMinimal, scriptNum, signatureFromP2pkSigScript, spliceSignature, tokenDelegatorCovenantSigScript, tokenDelegatorSigScript, tokenDelegatorSignedSigScript,
  tokenLeaderCovenantSigScript, tokenLeaderSigScript, tokenLeaderSignedSigScript,
  type LeaderSigScript,
} from '../../txbuilder/src/sigscript.ts';
export {
  BLOCK_COMPUTE_MASS_LIMIT, BLOCK_STORAGE_MASS_LIMIT, BLOCK_TRANSIENT_MASS_LIMIT, BUDGETS, BUDGETS_V1, BUDGETS_V1_COMPOSABLE, BUDGET_CEILING, BUDGET_CEILING_COMPOSABLE, BUDGET_CEILING_V3,
  COVENANT_OUTPUT_FLOOR, DEFAULT_USER_CELL_VALUE, FEERATE_MAX_SOMPI_PER_GRAM, FEERATE_SOMPI_PER_GRAM, FEE_CEILING_FLOOR, FEE_CEILING_MULTIPLE, FeeAboveCeiling, FeerateOutOfRange,
  P2PK_OUTPUT_FLOOR, SOMPI_PER_KAS, STORAGE_MASS_PARAMETER, assertMinable, boundedFeerate, budgetCeilingFor, budgetCovering, budgetFromLimit, budgetsFor, clampFeerate, computeMass,
  feeCeiling, masses, plurality, serializedSize, signedLeaderBudget, storageMass, transientMass,
  type BudgetRole, type BudgetRoleV3, type Masses, type ShapeInput, type ShapeOutput, type TxShape,
} from '../../txbuilder/src/mass.ts';
export * from '../../txbuilder/src/fee-bytes.ts';
export * from '../../txbuilder/src/finalize.ts';
export * from '../../txbuilder/src/recipients.ts';
export { parseIJSON, plainTxFromSdk, type Declaration, type TokenMetadata } from '../../txbuilder/src/kip24.ts';

/* ------------------------------------------------------------------ */
/* Transaction shapes                                                  */
/* ------------------------------------------------------------------ */

export * from '../../txbuilder/src/shapes/common.ts';
export * from '../../txbuilder/src/shapes/buy.ts';
export * from '../../txbuilder/src/shapes/sell.ts';
export * from '../../txbuilder/src/shapes/swap.ts';
export * from '../../txbuilder/src/shapes/split.ts';
export * from '../../txbuilder/src/shapes/consolidate.ts';
export * from '../../txbuilder/src/shapes/sweep.ts';
export * from '../../txbuilder/src/shapes/liquidity.ts';
export {
  BIND_LP_OUT, BIND_MAX_OUTS, BIND_POOL_OUT, LP_INVENTORY_CELL_VALUE, buildBindLp,
  type BindLpParams, type BindLpResult,
} from '../../txbuilder/src/shapes/bind-lp.ts';

/* ------------------------------------------------------------------ */
/* Selection and planning                                              */
/* ------------------------------------------------------------------ */

export * from '../../txbuilder/src/select/floors.ts';
export * from '../../txbuilder/src/select/funding.ts';
export * from '../../txbuilder/src/select/cells.ts';
export * from '../../txbuilder/src/select/covenant.ts';
export * from '../../txbuilder/src/select/planner.ts';
export * from '../../txbuilder/src/select/liquidity.ts';

/* ------------------------------------------------------------------ */
/* Builder types, fee claims                                           */
/* ------------------------------------------------------------------ */

export {
  CovenantCellValue, CurveNotOfProof, LineageMismatch, LpUnsafe, NeedsConsolidation, NeedsSplit, NetBoundExceeded, PoolNotOfProof, ProofNotBound, ShapeNotSupported, TokenAmountMismatch,
  UnknownCurveTemplate,
  type BuildAddLiquidityParams, type BuildBuyParams, type BuildConsolidateParams, type BuildRemoveLiquidityParams, type BuildScriptSellParams, type BuildSellParams, type BuildSplitParams,
  type BuildSwapParams, type BuiltTx, type CovenantCell, type CurveHead, type InputToSign, type InputToSignKind, type LaunchProofVerdict, type LineageGenesis, type LineageTermination,
  type LiquidityPlanBuilt, type OptimisticDelta, type OutputRole, type QuotedReserves, type Sompi, type SubmitState, type UtxoSources,
} from '../../txbuilder/src/types.ts';
export * from '../../txbuilder/src/claims.ts';

/* ------------------------------------------------------------------ */
/* Submission, retry, optimistic state                                 */
/* ------------------------------------------------------------------ */

export * from '../../txbuilder/src/submit.ts';
export * from '../../txbuilder/src/submit/classify.ts';
export * from '../../txbuilder/src/submit/state.ts';
export * from '../../txbuilder/src/submit/retry.ts';
export * from '../../txbuilder/src/submit/replace.ts';
export * from '../../txbuilder/src/optimistic.ts';

/* ------------------------------------------------------------------ */
/* Wallets                                                             */
/* ------------------------------------------------------------------ */

export * from '../../txbuilder/src/wallet/address.ts';
export * from '../../txbuilder/src/wallet/sighash.ts';
export * from '../../txbuilder/src/wallet/splice.ts';
export * from '../../txbuilder/src/wallet/kaspire.ts';
export * from '../../txbuilder/src/wallet/kasware.ts';
export * from '../../txbuilder/src/wallet/kastle.ts';
export * from '../../txbuilder/src/wallet/message.ts';

/* ------------------------------------------------------------------ */
/* Kaspa SDK access                                                    */
/* ------------------------------------------------------------------ */

export {
  SDK_VERSION, SdkNotInstalled, sdk, sdkAvailable,
  type Kaspa, type KaspaSdk, type SdkPrivateKey, type SdkRpcClient, type SdkTransaction, type SdkTransactionInputInit, type SdkTransactionOutput, type SdkUtxoEntryReference,
} from '../../txbuilder/src/sdk.ts';

/* ------------------------------------------------------------------ */
/* API types                                                           */
/* ------------------------------------------------------------------ */

export { NotSupported, type DataProvider } from '../../api-types/src/provider.ts';
export type {
  CurveState as ApiCurveState, Holder, SalePhase, Token, TokenListPage, TokenListQuery, TokenMeta, TokenSupply, Trade, TradeQuote, Verification,
} from '../../api-types/src/types.ts';
