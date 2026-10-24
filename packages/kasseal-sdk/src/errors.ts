/**
 * Stable error codes. Every error class this package exports carries `errorCode`, a stable string; every one except
 * the wallet errors (whose `code` is the wallet's own numeric code) also carries it as `code`. Match on the code, not
 * on the message text.
 */
import { NotSupported } from '../../api-types/src/provider.ts';
import { DeclarationError } from '../../codec/src/kcc0023.ts';
import { StateCodecError } from '../../codec/src/cell-state.ts';
import {
  DecodeError, LayoutError, OwnershipError, SupplyError, TemplateMismatchError, TemplateNotDecodableError, TransferError, UnknownTemplateError, ValidationError,
} from '../../codec/src/errors.ts';
import { SigScriptError } from '../../codec/src/program.ts';
import { StandardBandOutOfRange } from '../../curve-math/src/bands.ts';
import {
  ArgumentError, CurveMathError, LpError, LpFloorError, LpInvariantError, LpInventoryError, LpPayoutTooSmallError, LpReserveCapError, LpShareCountError, LpSharesCapError,
  LpStateError, LpTokenLegTooSmallError, OverflowError, ParameterError, PoolError, PoolPayoutTooSmallError, SellPayoutTooSmallError,
} from '../../curve-math/src/errors.ts';
import { ArtifactMissing, ArtifactNotLoaded, ArtifactSourceNotInstalled, ContractSetNotSupported } from '../../txbuilder/src/artifacts.ts';
import { ResidualBelowMinimum } from '../../txbuilder/src/assemble.ts';
import { ClaimMismatch } from '../../txbuilder/src/claims.ts';
import { FinalizeError } from '../../txbuilder/src/finalize.ts';
import { FeeAboveCeiling, FeerateOutOfRange } from '../../txbuilder/src/mass.ts';
import { OptimisticConflict } from '../../txbuilder/src/optimistic.ts';
import { StateJsonError } from '../../txbuilder/src/program.ts';
import { TokenRecipientRefused } from '../../txbuilder/src/recipients.ts';
import { SdkNotInstalled } from '../../txbuilder/src/sdk.ts';
import { CovenantCellNotFound } from '../../txbuilder/src/select/covenant.ts';
import { FloorViolation } from '../../txbuilder/src/select/floors.ts';
import { InsufficientFundsError, PinnedFundingGone } from '../../txbuilder/src/select/funding.ts';
import { InsufficientTokensError } from '../../txbuilder/src/select/planner.ts';
import { ForeignCovenantInput } from '../../txbuilder/src/shapes/common.ts';
import { RatioDriftError } from '../../txbuilder/src/shapes/liquidity.ts';
import { UnsafeScript } from '../../txbuilder/src/shapes/swap.ts';
import { SlippageOutOfRange } from '../../txbuilder/src/slippage.ts';
import { RejectedError } from '../../txbuilder/src/submit.ts';
import { ReplacementRefused } from '../../txbuilder/src/submit/replace.ts';
import { RetryPolicyError } from '../../txbuilder/src/submit/retry.ts';
import { InvalidTransition } from '../../txbuilder/src/submit/state.ts';
import { TreasuryNotAllowedOnNetwork } from '../../txbuilder/src/treasury.ts';
import {
  CovenantCellValue, CurveNotOfProof, LineageMismatch, LpUnsafe, NeedsConsolidation, NeedsSplit, NetBoundExceeded, PoolNotOfProof, ProofNotBound, ShapeNotSupported, TokenAmountMismatch,
  UnknownCurveTemplate,
} from '../../txbuilder/src/types.ts';
import { AddressError } from '../../txbuilder/src/wallet/address.ts';
import { KaspireError, WalletAccountMismatch, WalletNetworkMismatch, WalletNotConnected, WalletUnavailable } from '../../txbuilder/src/wallet/kaspire.ts';
import { KastleError } from '../../txbuilder/src/wallet/kastle.ts';
import { KasWareError } from '../../txbuilder/src/wallet/kasware.ts';
import { MessageSignatureError, MessageSigningUnsupported } from '../../txbuilder/src/wallet/message.ts';
import { SighashError } from '../../txbuilder/src/wallet/sighash.ts';
import { SignRequestError } from '../../txbuilder/src/wallet/splice.ts';
import { ApiError, HeadMoving } from './api.ts';
import { ArtifactIntegrityError, SdkCompatibilityError, SdkIntegrityError } from './integrity.ts';
import { UnsupportedBuild, UnsupportedNetwork } from './networks.ts';

type ErrorClass = abstract new (...args: never[]) => Error;

/** Class -> stable code. Subclasses get their own code; the table is checked when the module loads. */
const TABLE: readonly (readonly [ErrorClass, string])[] = [
  // Package
  [UnsupportedNetwork, 'UNSUPPORTED_NETWORK'],
  [UnsupportedBuild, 'UNSUPPORTED_BUILD'],
  [ArtifactIntegrityError, 'ARTIFACT_INTEGRITY'],
  [SdkIntegrityError, 'SDK_INTEGRITY'],
  [SdkCompatibilityError, 'SDK_INCOMPATIBLE'],
  // Artifacts and SDK
  [ArtifactMissing, 'ARTIFACT_MISSING'],
  [ArtifactNotLoaded, 'ARTIFACT_NOT_LOADED'],
  [ArtifactSourceNotInstalled, 'ARTIFACT_SOURCE_NOT_INSTALLED'],
  [ContractSetNotSupported, 'CONTRACT_SET_NOT_SUPPORTED'],
  [SdkNotInstalled, 'SDK_NOT_INSTALLED'],
  // Codec
  [LayoutError, 'LAYOUT'],
  [UnknownTemplateError, 'UNKNOWN_TEMPLATE'],
  [TemplateMismatchError, 'TEMPLATE_MISMATCH'],
  [TemplateNotDecodableError, 'TEMPLATE_NOT_DECODABLE'],
  [DecodeError, 'DECODE'],
  [ValidationError, 'VALIDATION'],
  [SupplyError, 'SUPPLY'],
  [OwnershipError, 'OWNERSHIP'],
  [TransferError, 'TRANSFER'],
  [StateCodecError, 'STATE_CODEC'],
  [DeclarationError, 'DECLARATION'],
  [SigScriptError, 'SIGSCRIPT'],
  // Curve and pool maths
  [CurveMathError, 'CURVE_MATH'],
  [ArgumentError, 'ARGUMENT'],
  [SellPayoutTooSmallError, 'SELL_PAYOUT_TOO_SMALL'],
  [ParameterError, 'PARAMETER'],
  [OverflowError, 'OVERFLOW'],
  [PoolError, 'POOL'],
  [PoolPayoutTooSmallError, 'POOL_PAYOUT_TOO_SMALL'],
  [LpError, 'LP'],
  [LpStateError, 'LP_STATE'],
  [LpShareCountError, 'LP_SHARE_COUNT'],
  [LpSharesCapError, 'LP_SHARES_CAP'],
  [LpReserveCapError, 'LP_RESERVE_CAP'],
  [LpFloorError, 'LP_FLOOR'],
  [LpPayoutTooSmallError, 'LP_PAYOUT_TOO_SMALL'],
  [LpTokenLegTooSmallError, 'LP_TOKEN_LEG_TOO_SMALL'],
  [LpInvariantError, 'LP_INVARIANT'],
  [LpInventoryError, 'LP_INVENTORY'],
  [StandardBandOutOfRange, 'STANDARD_BAND_OUT_OF_RANGE'],
  // Building
  [ProofNotBound, 'PROOF_NOT_BOUND'],
  [ShapeNotSupported, 'SHAPE_NOT_SUPPORTED'],
  [LineageMismatch, 'LINEAGE_MISMATCH'],
  [TokenAmountMismatch, 'TOKEN_AMOUNT_MISMATCH'],
  [UnknownCurveTemplate, 'UNKNOWN_CURVE_TEMPLATE'],
  [CovenantCellValue, 'COVENANT_CELL_VALUE'],
  [LpUnsafe, 'LP_UNSAFE'],
  [CurveNotOfProof, 'CURVE_NOT_OF_PROOF'],
  [PoolNotOfProof, 'POOL_NOT_OF_PROOF'],
  [NetBoundExceeded, 'NET_BOUND_EXCEEDED'],
  [NeedsConsolidation, 'NEEDS_CONSOLIDATION'],
  [NeedsSplit, 'NEEDS_SPLIT'],
  [ResidualBelowMinimum, 'RESIDUAL_BELOW_MINIMUM'],
  [FloorViolation, 'FLOOR_VIOLATION'],
  [InsufficientFundsError, 'INSUFFICIENT_FUNDS'],
  [PinnedFundingGone, 'PINNED_FUNDING_GONE'],
  [InsufficientTokensError, 'INSUFFICIENT_TOKENS'],
  [CovenantCellNotFound, 'COVENANT_CELL_NOT_FOUND'],
  [ForeignCovenantInput, 'FOREIGN_COVENANT_INPUT'],
  [RatioDriftError, 'RATIO_DRIFT'],
  [UnsafeScript, 'UNSAFE_SCRIPT'],
  [SlippageOutOfRange, 'SLIPPAGE_OUT_OF_RANGE'],
  [FeeAboveCeiling, 'FEE_ABOVE_CEILING'],
  [FeerateOutOfRange, 'FEERATE_OUT_OF_RANGE'],
  [TreasuryNotAllowedOnNetwork, 'TREASURY_NOT_ALLOWED_ON_NETWORK'],
  [StateJsonError, 'STATE_JSON'],
  [TokenRecipientRefused, 'TOKEN_RECIPIENT_REFUSED'],
  [ClaimMismatch, 'CLAIM_MISMATCH'],
  [FinalizeError, 'FINALIZE'],
  // Submission
  [RejectedError, 'REJECTED'],
  [ReplacementRefused, 'REPLACEMENT_REFUSED'],
  [RetryPolicyError, 'RETRY_POLICY'],
  [InvalidTransition, 'INVALID_TRANSITION'],
  [OptimisticConflict, 'OPTIMISTIC_CONFLICT'],
  // Wallets
  [AddressError, 'ADDRESS'],
  [SighashError, 'SIGHASH'],
  [SignRequestError, 'SIGN_REQUEST'],
  [MessageSignatureError, 'MESSAGE_SIGNATURE'],
  [MessageSigningUnsupported, 'MESSAGE_SIGNING_UNSUPPORTED'],
  [WalletUnavailable, 'WALLET_UNAVAILABLE'],
  [WalletNotConnected, 'WALLET_NOT_CONNECTED'],
  [WalletNetworkMismatch, 'WALLET_NETWORK_MISMATCH'],
  [WalletAccountMismatch, 'WALLET_ACCOUNT_MISMATCH'],
  [KaspireError, 'KASPIRE'],
  [KastleError, 'KASTLE'],
  [KasWareError, 'KASWARE'],
  // API
  [NotSupported, 'NOT_SUPPORTED'],
  [ApiError, 'API_ERROR'],
  [HeadMoving, 'HEAD_MOVING'],
];

/** Errors whose `code` is a wallet's numeric code: they carry the stable string as `errorCode` only. */
const NUMERIC_CODE: readonly ErrorClass[] = [KaspireError, KastleError, KasWareError];

/** Every stable code. */
export const ERROR_CODES: readonly string[] = Object.freeze(TABLE.map(([, c]) => c));

function install(): void {
  const seen = new Set<string>();
  for (const [cls, code] of TABLE) {
    if (typeof cls !== 'function' || !(cls.prototype instanceof Error)) throw new Error(`error table: ${String(code)} is not an Error class`);
    if (seen.has(code)) throw new Error(`error table: duplicate code ${code}`);
    seen.add(code);
    const proto = cls.prototype as object;
    Object.defineProperty(proto, 'errorCode', { value: code, enumerable: false, configurable: false, writable: false });
    if (!NUMERIC_CODE.includes(cls)) Object.defineProperty(proto, 'code', { value: code, enumerable: false, configurable: false, writable: false });
  }
}
install();

/** The stable code of an error this package throws, or undefined for any other value. */
export function errorCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const c = (err as { errorCode?: unknown }).errorCode;
  return typeof c === 'string' ? c : undefined;
}

/** Whether `err` is an error this package throws (optionally with the given code). */
export function isKassealError(err: unknown, code?: string): err is Error & { readonly errorCode: string } {
  const c = errorCode(err);
  return c !== undefined && (code === undefined || c === code);
}
