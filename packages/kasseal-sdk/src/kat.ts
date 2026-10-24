/**
 * Known-answer test of a Kaspa SDK passed to `initWeb` (`kaspa` option), run before it is installed.
 *
 * The candidate is checked in three stages: it must report `SDK_VERSION`, expose every function and class the
 * builders call, and reproduce, through the builders' own code paths (`assemble`, `toBuiltTx`, `signWithKeys`,
 * `signBuiltWithKey`, `finalizeSigned`, `p2pkScript`, `addressOfSpk`), the answers of the pinned web build recorded
 * in `kat-fixtures.ts` by `scripts/kat-fixtures.mjs`:
 *
 * - script and address helpers on both networks (P2PK and P2SH, address -> script -> address);
 * - a P2PK transfer with payload and change: txid, fee, SafeJSON, v1 sighash;
 * - a transaction with a covenant input (non-zero sequence), a bound continuation output, a two-output KIP-20 genesis
 *   group (`populateGenesisCovenants`) and a lock time: txid, SafeJSON, the derived covenant id, both sighashes;
 * - signing with a fixed test key (derived below from a public label; it holds nothing): the candidate's Schnorr
 *   signatures must verify against our own sighash and key, and the finalized SafeJSON must equal the recorded one
 *   byte for byte outside the signature (BIP-340 signing in the SDK uses fresh auxiliary randomness, so signature
 *   bytes differ between runs by design).
 *
 * Every SDK call runs with the candidate answering `sdk()` (`withSdk`), and whatever was installed before is restored
 * afterwards, pass or fail.
 */
import { toHex, fromHex } from '../../codec/src/push.ts';
import { p2shScript } from '../../codec/src/blake2b.ts';
import { sha256Hex } from '../../codec/src/sha256.ts';
import {
  MIN_CHANGE, addressOfSpk, assemble, fundingInput, isFullySigned, p2pkScript, signWithKeys, type AssembledTx, type PredictedCell, type TxPlan,
} from '../../txbuilder/src/assemble.ts';
import { schnorrVerify } from '../../txbuilder/src/bip340.ts';
import { finalizeSigned, signBuiltWithKey, toBuiltTx } from '../../txbuilder/src/finalize.ts';
import { BUDGETS, FEERATE_SOMPI_PER_GRAM } from '../../txbuilder/src/mass.ts';
import { covenantOwnedToken } from '../../txbuilder/src/program.ts';
import { SDK_VERSION, withSdk, type KaspaSdk, type SdkPrivateKey } from '../../txbuilder/src/sdk.ts';
import { P2PK_PLACEHOLDER_SIGSCRIPT } from '../../txbuilder/src/sigscript.ts';
import type { BuiltTx, OptimisticDelta } from '../../txbuilder/src/types.ts';
import { sighashOfTxJson } from '../../txbuilder/src/wallet/sighash.ts';
import { SdkCompatibilityError } from './integrity.ts';
import { KAT_FIXTURES } from './kat-fixtures.ts';

/** The test key's label; the key is its SHA-256. Public by construction: never fund it. */
export const KAT_TEST_KEY_LABEL = '@kassealhq/sdk known-answer test key (public, holds nothing)';

/** The test key's P2PK addresses, as the pinned build derives them (checked by `scripts/kat-fixtures.mjs`). */
export const KAT_KEY_ADDRESS: Readonly<Record<'mainnet' | 'testnet-10', string>> = Object.freeze({
  mainnet: 'kaspa:qr93f565yswpmw47rtc86j9ycsz4dq47estnrfme3jfxsuy40l3ysvjv666lu',
  'testnet-10': 'kaspatest:qr93f565yswpmw47rtc86j9ycsz4dq47estnrfme3jfxsuy40l3ysd52p4ywc',
});

/** Every function or class of the SDK namespace the builders call. */
const REQUIRED_FUNCTIONS = [
  'version', 'Transaction', 'TransactionOutput', 'ScriptPublicKey', 'GenesisCovenantGroup', 'CovenantBinding', 'Hash', 'PrivateKey',
  'payToAddressScript', 'addressFromScriptPublicKey', 'createInputSignature',
] as const;
const REQUIRED_TX_METHODS = ['finalize', 'populateGenesisCovenants', 'serializeToSafeJSON'] as const;

const EMPTY_DELTA: OptimisticDelta = { cells: { consumed: [], produced: [] }, funding: { reserved: [] } };
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The parts of the SDK namespace that must exist, as failure lines (empty when complete). */
export function missingSdkSurface(k: unknown): string[] {
  if (k === null || (typeof k !== 'object' && typeof k !== 'function')) return ['the module is not an object'];
  const ns = k as Record<string, unknown>;
  const out: string[] = [];
  for (const name of REQUIRED_FUNCTIONS) if (typeof ns[name] !== 'function') out.push(`missing function ${name}`);
  const tx = ns['Transaction'] as ((...args: never[]) => unknown) & { prototype?: Record<string, unknown>; deserializeFromSafeJSON?: unknown } | undefined;
  if (typeof tx === 'function') {
    for (const m of REQUIRED_TX_METHODS) if (typeof tx.prototype?.[m] !== 'function') out.push(`missing method Transaction.prototype.${m}`);
    if (typeof tx.deserializeFromSafeJSON !== 'function') out.push('missing static Transaction.deserializeFromSafeJSON');
  }
  const sh = ns['SighashType'] as { All?: unknown } | undefined;
  if (sh === null || typeof sh !== 'object' || typeof sh.All !== 'number') out.push('missing SighashType.All');
  return out;
}

/** The 64-hex Schnorr signature inside input `index`'s P2PK sigscript of a SafeJSON transaction. */
function p2pkSignatureHex(txJson: string, index: number): string {
  const script = (JSON.parse(txJson) as { inputs: { signatureScript?: string }[] }).inputs[index]?.signatureScript ?? '';
  if (script.length !== 132 || !script.startsWith('41') || !script.endsWith('01')) throw new Error(`input ${index}: not a P2PK signature script`);
  return script.slice(2, 130);
}

/** The SafeJSON with one input's signature replaced by zeros (signatures carry fresh randomness). */
function masked(txJson: string, sigHex: string): string {
  const at = txJson.indexOf(sigHex);
  if (at < 0 || txJson.indexOf(sigHex, at + 1) >= 0) throw new Error('signature not found exactly once in the transaction');
  return txJson.slice(0, at) + '0'.repeat(sigHex.length) + txJson.slice(at + sigHex.length);
}

/** Whether input `index`'s signature verifies against our v1 sighash and the x-only key of a P2PK script. */
function verifies(txJson: string, index: number, keySpk: Uint8Array): boolean {
  return schnorrVerify(keySpk.subarray(1, 33), fromHex(sighashOfTxJson(txJson, index)), fromHex(p2pkSignatureHex(txJson, index)));
}

/** Where a case writes its answers, as it goes (a case that throws keeps the answers it gave before). */
type Answers = Record<string, string>;

function scriptsCase(out: Answers): void {
  const p2sh = p2shScript(enc('kasseal kat program A'));
  for (const network of ['mainnet', 'testnet-10'] as const) {
    const keySpk = p2pkScript(KAT_KEY_ADDRESS[network]);
    out[`key.script.${network}`] = toHex(keySpk);
    out[`key.address.${network}`] = addressOfSpk(keySpk, network);
    const a = addressOfSpk(p2sh, network);
    out[`p2sh.address.${network}`] = a;
    out[`p2sh.script.${network}`] = toHex(p2pkScript(a));
  }
}

function p2pkCase(out: Answers, key: SdkPrivateKey): void {
  const address = KAT_KEY_ADDRESS['testnet-10'];
  const keySpk = p2pkScript(address);
  const plan: TxPlan = {
    name: 'kat-p2pk',
    inputs: [fundingInput({ outpoint: { txid: 'a1'.repeat(32), index: 1 }, amount: 500_000_000n, spk: keySpk, daaScore: 123_456n, address }, 'funding', BUDGETS.p2pk, P2PK_PLACEHOLDER_SIGSCRIPT)],
    outputs: [{ label: 'pay', value: 123_456_789n, spk: p2shScript(enc('kasseal kat program A')), binding: undefined, cell: undefined }],
    residual: { label: 'change', spk: keySpk, binding: undefined, cell: undefined, minimum: 0n, dropBelow: MIN_CHANGE },
    genesisGroups: [],
    payload: enc('kasseal known-answer test'),
    feeMargin: 0n,
  };
  const a = assemble(plan);
  out['txid'] = a.txid;
  out['fee'] = String(a.fee);
  const built = toBuiltTx(a, { feerate: FEERATE_SOMPI_PER_GRAM, produces: [], optimistic: EMPTY_DELTA });
  out['txJson'] = built.txJson;
  out['sighash.0'] = sighashOfTxJson(built.txJson, 0);
  signedAnswers(out, built, key, [0], keySpk);
  assembledSigning(out, assemble(plan), key);
}

function genesisCase(out: Answers, key: SdkPrivateKey): void {
  const address = KAT_KEY_ADDRESS.mainnet;
  const keySpk = p2pkScript(address);
  const cellSpk = p2shScript(enc('kasseal kat covenant cell'));
  const genesisProgram = enc('kasseal kat genesis');
  const genesisSpk = p2shScript(genesisProgram);
  const covenantId = 'c3'.repeat(32);
  const born: PredictedCell = { predicted: { kind: 'token', state: covenantOwnedToken(1_000n, covenantId) }, program: genesisProgram, covenantId: undefined };
  const plan: TxPlan = {
    name: 'kat-genesis',
    inputs: [
      {
        label: 'cell', outpoint: { txid: 'b2'.repeat(32), index: 0 }, amount: 300_000_000n, spk: cellSpk, daaScore: 222n, covenantId, budget: 7,
        sigscript: Uint8Array.from({ length: 40 }, (_, i) => i), signature: undefined, sequence: 42n,
      },
      fundingInput({ outpoint: { txid: 'd4'.repeat(32), index: 3 }, amount: 1_000_000_000n, spk: keySpk, daaScore: 333n, address }, 'funding', BUDGETS.p2pk, P2PK_PLACEHOLDER_SIGSCRIPT),
    ],
    outputs: [
      { label: 'cell', value: 300_000_000n, spk: cellSpk, binding: { authorizingInput: 0, covenantId }, cell: undefined },
      { label: 'genesis-a', value: 50_000_000n, spk: genesisSpk, binding: undefined, cell: born },
      { label: 'genesis-b', value: 20_000_000n, spk: genesisSpk, binding: undefined, cell: born },
    ],
    residual: { label: 'change', spk: keySpk, binding: undefined, cell: undefined, minimum: 0n, dropBelow: MIN_CHANGE },
    genesisGroups: [{ authorizingInput: 1, outputs: [1, 2] }],
    payload: new Uint8Array(0),
    feeMargin: 0n,
    lockTime: 1_000n,
  };
  const a = assemble(plan);
  out['txid'] = a.txid;
  out['fee'] = String(a.fee);
  out['genesis.covenantId'] = a.genesis.map((g) => g.covenantId).join(',');
  const built = toBuiltTx(a, { feerate: FEERATE_SOMPI_PER_GRAM, produces: [], optimistic: EMPTY_DELTA });
  out['txJson'] = built.txJson;
  out['sighash.0'] = sighashOfTxJson(built.txJson, 0);
  out['sighash.1'] = sighashOfTxJson(built.txJson, 1);
  signedAnswers(out, built, key, [1], keySpk);
  assembledSigning(out, assemble(plan), key);
}

/** `signBuiltWithKey` (createInputSignature, SafeJSON round trip, `finalizeSigned`): the signed form, signatures masked. */
function signedAnswers(out: Answers, built: BuiltTx, key: SdkPrivateKey, signed: readonly number[], keySpk: Uint8Array): void {
  const fin = signBuiltWithKey(built, key);
  out['signed.txid'] = fin.txid;
  out['signed.verifies'] = String(signed.every((i) => verifies(fin.txJson, i, keySpk)));
  let json = fin.txJson;
  for (const i of signed) json = masked(json, p2pkSignatureHex(fin.txJson, i));
  out['signed.txJson'] = json;
  // A second finalize of the signed form changes nothing.
  out['signed.refinalized'] = String(finalizeSigned(built, fin.txJson).txJson === fin.txJson);
}

/** `signWithKeys` on the assembled transaction (createInputSignature spliced into the SDK object). */
function assembledSigning(out: Answers, a: AssembledTx, key: SdkPrivateKey): void {
  out['assembled.signed'] = signWithKeys(a, () => key).join(',');
  out['assembled.fullySigned'] = String(isFullySigned(a));
  out['assembled.txid'] = a.tx.id;
}

/**
 * Run every known-answer case with `k` answering `sdk()`, and return the answers by name (`<case>.<field>`). A case
 * that throws answers `<case>.error` instead. Used by `verifyKaspaSdk` and by `scripts/kat-fixtures.mjs`.
 */
export function knownAnswers(k: KaspaSdk): Record<string, string> {
  return withSdk(k, () => {
    const out: Record<string, string> = { version: String(k.version()) };
    let key: SdkPrivateKey | undefined;
    const run = (name: string, fn: (answers: Answers) => void): void => {
      const answers: Answers = {};
      try {
        fn(answers);
      } catch (e) {
        answers['error'] = e instanceof Error ? e.message : String(e);
      }
      for (const [f, v] of Object.entries(answers)) out[`${name}.${f}`] = v;
    };
    run('key', () => {
      key = new k.PrivateKey(sha256Hex(KAT_TEST_KEY_LABEL));
    });
    run('scripts', scriptsCase);
    run('p2pk', (a) => p2pkCase(a, key!));
    run('genesis', (a) => genesisCase(a, key!));
    return out;
  });
}

const clip = (s: string | undefined, max = 80): string => (s === undefined ? '(none)' : s.length > max ? `${s.slice(0, max)}... (${s.length} chars)` : s);

/** Differences between answers and the recorded fixtures, one line each. */
export function compareKnownAnswers(answers: Readonly<Record<string, string>>, expected: Readonly<Record<string, string>> = KAT_FIXTURES): string[] {
  const out: string[] = [];
  // A case that threw: its error first, and the answers it never reached are not listed one by one.
  const threw = new Set<string>();
  for (const [name, message] of Object.entries(answers)) {
    if (!name.endsWith('.error') || expected[name] !== undefined) continue;
    const c = name.slice(0, -'.error'.length);
    threw.add(c);
    out.push(`${c}: threw ${clip(message, 240)}`);
  }
  for (const name of [...new Set([...Object.keys(expected), ...Object.keys(answers)])].sort()) {
    const got = answers[name];
    const want = expected[name];
    if (got === want) continue;
    const c = name.slice(0, name.indexOf('.') < 0 ? name.length : name.indexOf('.'));
    if (threw.has(c) && (got === undefined || name === `${c}.error`)) continue;
    if (want === undefined) out.push(`${name}: unexpected answer ${clip(got)}`);
    else if (got === undefined) out.push(`${name}: no answer, expected ${clip(want)}`);
    else {
      let at = 0;
      while (at < got.length && got[at] === want[at]) at++;
      out.push(`${name}: got ${clip(got)}, expected ${clip(want)} (first difference at character ${at})`);
    }
  }
  return out;
}

/**
 * Check a candidate Kaspa SDK namespace (version, API surface, known answers) and return it typed. Throws
 * `SdkCompatibilityError` naming every difference; installs nothing.
 */
export function verifyKaspaSdk(candidate: unknown): KaspaSdk {
  const ns = candidate as Record<string, unknown> | null;
  if (ns !== null && typeof ns === 'object' && typeof ns['version'] === 'function') {
    let v: unknown;
    try {
      v = (ns['version'] as () => unknown)();
    } catch (e) {
      throw new SdkCompatibilityError('version', [`version() threw: ${e instanceof Error ? e.message : String(e)} (is the WASM initialised?)`]);
    }
    if (v !== SDK_VERSION) throw new SdkCompatibilityError('version', [`reports version ${JSON.stringify(v)}, expected ${SDK_VERSION}`]);
  }
  const missing = missingSdkSurface(candidate);
  if (missing.length > 0) throw new SdkCompatibilityError('surface', missing);
  const k = candidate as KaspaSdk;
  const diffs = compareKnownAnswers(knownAnswers(k));
  if (diffs.length > 0) throw new SdkCompatibilityError('known-answer', diffs);
  return k;
}
