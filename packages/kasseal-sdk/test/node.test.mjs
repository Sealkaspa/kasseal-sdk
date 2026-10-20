// The built package through its Node entry (run `node scripts/build.mjs` first).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const m = await import(pathToFileURL(path.join(DIST, 'node.js')).href);

const KAS = 100_000_000n;
const T = '22'.repeat(32);
const P = '59'.repeat(32);
const L = '69'.repeat(32);

const node = (code, cwd = DIST) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd, encoding: 'utf8' });

test('the Node entry exports the public surface and leaves out launch, batch and keeper code', () => {
  for (const name of ['createTxBuilder', 'createContext', 'buildBuy', 'buildSell', 'buildSwapKasForTokens', 'buildSwapTokensForKas', 'buildAddLiquidity', 'buildRemoveLiquidity',
    'planClaims', 'buildClaims', 'verifyLaunchProofJson', 'verifyLaunchProof', 'launchProofFromJson', 'graduationOnChain', 'createApiSources', 'keyLockedRedeem', 'assertSafeRedeem', 'UnsafeScript',
    'maxWithSlippage', 'swapKasForTokens', 'createKasWareAdapter', 'createKastleAdapter', 'createKaspireAdapter', 'verifyArtifacts']) {
    assert.equal(typeof m[name], 'function', name);
  }
  for (const name of ['buildCreate', 'buildTokenGenesisInit', 'registrationOf', 'buildGraduate', 'buildGraduateAndBind', 'buildPlaceOrder', 'buildFill', 'buildVaultBuy', 'buildSplitterSplit',
    'loadVaultInstanceV1', 'V1_FROZEN_REVISIONS', 'V1_MAINNET_REVISION', 'PRESET_TINY', 'PRESET_A', 'installArtifactSource', 'registerSdkLoader', 'NETWORK_ID']) {
    assert.equal(m[name], undefined, name);
  }
  assert.deepEqual([...m.SUPPORTED_BUILDS], ['v1-kasseal-mainnet-2', 'v1-kasseal-mainnet-2-tn10']);
  assert.equal(m.API_BASE_URLS['testnet-10'], 'https://app.kasseal.com/v1');
  assert.equal(m.API_BASE_URLS.mainnet, undefined, 'no hidden mainnet default');
});

test('the root entry loads no WASM and installs no artifacts', () => {
  const r = node(`
    const m = await import('./index.js');
    let code = '';
    try { m.createContext('standard', 'mainnet'); } catch (e) { code = e.code; }
    console.log(JSON.stringify({ sdk: m.sdkAvailable(), code }));
  `);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { sdk: false, code: 'ARTIFACT_SOURCE_NOT_INSTALLED' });
});

test('network and build are explicit: an unknown network or another network\'s build is refused with a stable code', () => {
  assert.throws(() => m.createContext('standard', 'testnet-11'), (e) => e.code === 'UNSUPPORTED_NETWORK' && m.errorCode(e) === 'UNSUPPORTED_NETWORK');
  assert.throws(() => m.createContext('standard', 'mainnet', 'v1', 'v1-kasseal-mainnet-2-tn10'), (e) => e.code === 'UNSUPPORTED_BUILD');
  assert.throws(() => m.createTxBuilder({ sources: {} }), (e) => e.code === 'UNSUPPORTED_NETWORK');
  assert.throws(() => m.createContext('tiny', 'testnet-10'), (e) => e.code === 'ARTIFACT_MISSING', 'retired presets are not bundled');
});

test('quote and build a pool buy on fake cells (composable pool, testnet-10)', () => {
  const ctx = m.createContext('standard', 'testnet-10');
  assert.ok(m.isComposablePool(ctx.pool));
  const k = m.sdk();
  const priv = new k.PrivateKey(`${'00'.repeat(31)}0b`);
  const address = priv.toAddress('testnet-10').toString();
  const xonly = m.fromHex(priv.toPublicKey().toXOnlyPublicKey().toString());
  const state = { tokenCovId: m.fromHex(T), kasScaled: 57_411_380n, tokenReserve: 400_400_000n, lpShares: m.LOCKED_SHARES, lpCovId: m.fromHex(L), feeAccruedScaled: 0n, creatorSpk: m.fromHex(`000020${'22'.repeat(32)}ac`) };
  const pool = { kind: 'pool', outpoint: { txid: '96'.repeat(32), index: 0 }, value: state.kasScaled * 1_000_000n, covenantId: P, program: m.poolProgram(ctx.pool, state), state, daaScore: 1n };
  const reserveState = m.covenantOwnedToken(state.tokenReserve, P);
  const reserve = { kind: 'token', outpoint: { txid: '92'.repeat(32), index: 0 }, value: 10n * KAS, covenantId: T, program: m.tokenProgram(ctx.token, reserveState), state: reserveState, daaScore: 1n };
  const funding = { outpoint: { txid: '93'.repeat(32), index: 0 }, amount: 100n * KAS, spk: m.p2pkScript(address), daaScore: 1n, address };

  const kasInScaled = 1_000n;
  const quote = m.swapKasForTokens(m.poolMathState(pool), kasInScaled, m.poolLimitsOf(ctx), m.poolRoundingOf(ctx));
  const minOut = m.minWithSlippage(quote.tokenOut, 100);
  assert.ok(minOut <= quote.tokenOut && minOut > 0n);
  const r = m.buildSwapKasForTokens({ ctx, pool, poolToken: reserve, buyer: { xOnlyPubkey: xonly, address }, kasInScaled, funding: [funding] });
  assert.equal(r.tokensOut, quote.tokenOut, 'the built swap delivers the quoted amount');
  const built = m.toBuilt(r);
  assert.match(built.txid, /^[0-9a-f]{64}$/);
  assert.deepEqual(built.produces.map((p) => p.role).slice(0, 3), ['pool', 'token-rest', 'token-user']);
  assert.equal(built.inputsToSign.length, 1);
  const tx = JSON.parse(built.txJson);
  assert.equal(tx.outputs.length, 4);
});

test('errors carry stable codes', () => {
  assert.throws(() => m.assertSlippageBps(5_000), (e) => e instanceof m.SlippageOutOfRange && e.code === 'SLIPPAGE_OUT_OF_RANGE' && e.errorCode === 'SLIPPAGE_OUT_OF_RANGE');
  assert.equal(new m.KasWareError('signPskt', 4001, 'denied').code, 4001, 'wallet errors keep the wallet\'s numeric code');
  assert.equal(new m.KasWareError('signPskt', 4001, 'denied').errorCode, 'KASWARE');
  assert.equal(m.errorCode(new Error('x')), undefined);
  assert.equal(new m.DecodeError('x').name, 'DecodeError', 'class names survive the bundle');
  assert.equal(new m.DecodeError('x').code, 'DECODE');
  assert.ok(m.isKassealError(new m.ArtifactMissing('x'), 'ARTIFACT_MISSING'));
  assert.equal(new Set(m.ERROR_CODES).size, m.ERROR_CODES.length);
});

test('docs/errors.md and ERROR_CODES name exactly the same classes and codes', () => {
  const doc = readFileSync(fileURLToPath(new URL('../docs/errors.md', import.meta.url)), 'utf8');
  const rows = [...doc.matchAll(/^\| `(\w+)` \| `([A-Z0-9_]+)` \|/gm)].map(([, cls, code]) => ({ cls, code }));
  assert.ok(rows.length > 0, 'errors.md has error tables');
  const docCodes = rows.map((r) => r.code);
  assert.equal(new Set(docCodes).size, docCodes.length, 'each code appears once in errors.md');
  assert.deepEqual([...docCodes].sort(), [...m.ERROR_CODES].sort(), 'errors.md codes = ERROR_CODES');
  for (const { cls, code } of rows) {
    assert.equal(typeof m[cls], 'function', `${cls} is exported`);
    assert.equal(m[cls].prototype.errorCode, code, `${cls} carries ${code}`);
  }
});

test('the only launch-proof verifier exported is the nine-step one', () => {
  assert.equal(m.LAUNCH_PROOF_STEPS, 9);
  assert.equal(typeof m.verifyLaunchProof, 'function');
  assert.equal(typeof m.launchProofFromJson, 'function');
  assert.equal(typeof m.verifyLaunchProofJson, 'function');
  for (const name of ['buildLaunchProof', 'bundleFromJson', 'bundleToJson', 'paramsToJson']) assert.equal(m[name], undefined, name);
  // The older eight-step verifier is not even in the bundle: none of its own messages ships.
  const code = [...['index.js', 'node.js', 'web.js'], ...readdirSync(path.join(DIST, 'chunks')).filter((f) => f.startsWith('chunk-')).map((f) => `chunks/${f}`)]
    .map((f) => readFileSync(path.join(DIST, f), 'utf8')).join('\n');
  for (const msg of ['tx2 curve input carries no sigscript', 'bundle token suffix differs from the reference artifact']) {
    assert.ok(!code.includes(msg), msg);
  }
  const report = m.verifyLaunchProofJson({ not: 'a bundle' }, 'testnet-10');
  assert.equal(report.status, 'malformed');
});

test('artifact verification refuses a tampered, missing or unlisted file and a changed manifest', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kassealhq-sdk-art-'));
  cpSync(path.join(DIST, 'artifacts'), root, { recursive: true });
  const url = pathToFileURL(`${root}/`);
  assert.equal(m.verifyArtifacts(url).length, Object.keys(m.artifactManifest.files).length);

  const victim = 'contracts/pool/v1/artifacts/v1-kasseal-mainnet-2/pool.artifact.json';
  const original = readFileSync(path.join(root, victim));
  const tampered = Buffer.from(original);
  tampered[tampered.length - 3] ^= 0x01;
  writeFileSync(path.join(root, victim), tampered);
  assert.throws(() => m.verifyArtifacts(url), (e) => e instanceof m.ArtifactIntegrityError && e.code === 'ARTIFACT_INTEGRITY' && e.path === victim);
  assert.throws(() => m.verifiedArtifactSource(url), (e) => e.code === 'ARTIFACT_INTEGRITY');
  writeFileSync(path.join(root, victim), original);
  assert.doesNotThrow(() => m.verifyArtifacts(url));

  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  manifest.files[victim] = '00'.repeat(32);
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  assert.throws(() => m.verifyArtifacts(url), (e) => e.code === 'ARTIFACT_INTEGRITY' && e.path === 'manifest.json', 'a rewritten manifest does not help');

  const source = m.verifiedArtifactSource();
  assert.throws(() => source.readText('contracts/curve/v1/artifacts/v1-kasseal-mainnet-2/curve.tiny.artifact.json'), (e) => e.code === 'ARTIFACT_MISSING');
  assert.throws(() => source.readText('../package.json'), (e) => e.code === 'ARTIFACT_MISSING');
});

test('a tampered package fails closed: an altered artifact stops the import, an altered WASM stops the SDK', () => {
  const pkg = mkdtempSync(path.join(tmpdir(), 'kassealhq-sdk-pkg-'));
  cpSync(DIST, path.join(pkg, 'dist'), { recursive: true });
  const ctor = path.join(pkg, 'dist/artifacts/contracts/curve/v1/artifacts/v1-kasseal-mainnet-2-tn10/curve.ctor.standard.json');
  const good = readFileSync(ctor, 'utf8');
  writeFileSync(ctor, good.replace('1000', '1001'));
  let r = node(`
    try { await import('./node.js'); console.log('imported'); } catch (e) { console.log(e.name, e.code); }
  `, path.join(pkg, 'dist'));
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  assert.equal(r.stdout.trim(), 'ArtifactIntegrityError ARTIFACT_INTEGRITY');
  writeFileSync(ctor, good);

  const wasm = path.join(pkg, 'dist/kaspa/nodejs/kaspa_bg.wasm');
  const bytes = readFileSync(wasm);
  bytes[bytes.length - 1] ^= 0xff;
  writeFileSync(wasm, bytes);
  r = node(`
    const m = await import('./node.js');
    try { m.sdk(); console.log('loaded'); } catch (e) { console.log(e.code); }
  `, path.join(pkg, 'dist'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'SDK_INTEGRITY');
});

test('createApiSources: explicit network and base URL, waits out 429, typed errors, no coinbase funding', async () => {
  assert.throws(() => m.createApiSources({ baseUrl: 'https://x.test/v1', network: 'testnet-11', tokenId: T, ownKey: '00' }), (e) => e.code === 'UNSUPPORTED_NETWORK');
  assert.throws(() => m.createApiSources({ baseUrl: 'x.test', network: 'testnet-10', tokenId: T, ownKey: '00' }), TypeError);
  const k = m.sdk();
  const address = new k.PrivateKey(`${'00'.repeat(31)}0b`).toAddress('testnet-10').toString();
  const mainnetAddress = new k.PrivateKey(`${'00'.repeat(31)}0b`).toAddress('mainnet').toString();
  const calls = [];
  let fees = 0;
  const fetch = async (url) => {
    calls.push(url);
    const json = (status, body) => ({ ok: status === 200, status, json: async () => body });
    if (url.endsWith('/fees')) return ++fees === 1 ? json(429, { retryAfterMs: 0 }) : json(200, { feerateSompiPerGram: '1' });
    if (url.includes('/utxos')) {
      const u = (txid, isCoinbase) => ({ outpoint: { txid, index: 0 }, amount: '100000000', scriptPublicKey: { version: 0, script: `20${'11'.repeat(32)}ac` }, blockDaaScore: '7', isCoinbase });
      return json(200, { utxos: [u('aa'.repeat(32), false), u('bb'.repeat(32), true)] });
    }
    if (url.includes('/pools/')) return json(200, { headSpent: true });
    return json(404, { type: 'not-found' });
  };
  const s = m.createApiSources({ baseUrl: 'https://x.test/v1/', network: 'testnet-10', tokenId: T, ownKey: '11'.repeat(32), fetch });
  assert.equal(await s.feerate(), 1n);
  assert.equal(calls[0], 'https://x.test/v1/fees', 'no double slash, explicit base URL');
  assert.equal(calls.length, 2, 'a 429 is waited out and asked again');
  const funding = await s.funding(address);
  assert.deepEqual(funding.map((u) => u.outpoint.txid), ['aa'.repeat(32)], 'coinbase outputs are not offered');
  assert.equal(s.lastFunding(), funding);
  await assert.rejects(s.funding(mainnetAddress), (e) => e.code === 'ADDRESS');
  await assert.rejects(s.poolCell(P), (e) => e.code === 'HEAD_MOVING');
  await assert.rejects(s.curveHead(T), (e) => e instanceof m.ApiError && e.code === 'API_ERROR' && e.status === 404);
});

test('compareGraduationWithChain: only present values that differ are a mismatch', async () => {
  const tx = { inputs: [{ transactionId: 'AA'.repeat(32), index: 1, signatureScript: '51' }, { transactionId: 'bb'.repeat(32), index: 0, signatureScript: '52' }] };
  const txid = 'cc'.repeat(32);
  const inputs = [
    { index: 1, previous_outpoint_hash: 'bb'.repeat(32), previous_outpoint_index: '0', signature_script: '52' },
    { index: 0, previous_outpoint_hash: 'aa'.repeat(32), previous_outpoint_index: 1, signature_script: '51' },
  ];
  assert.equal(m.compareGraduationWithChain(tx, txid, { transaction_id: txid, is_accepted: true, inputs }), 'confirmed');
  assert.equal(m.compareGraduationWithChain(tx, txid, { transaction_id: txid, is_accepted: false, inputs }), 'not-found');
  assert.equal(m.compareGraduationWithChain(tx, txid, { transaction_id: 'dd'.repeat(32), is_accepted: true, inputs }), 'mismatch');
  assert.equal(m.compareGraduationWithChain(tx, txid, { transaction_id: txid, is_accepted: true, inputs: [inputs[0], { ...inputs[1], signature_script: '53' }] }), 'mismatch');
  assert.equal(m.compareGraduationWithChain(tx, txid, { transaction_id: txid, is_accepted: true, inputs: [inputs[0]] }), 'mismatch');
  assert.equal(m.compareGraduationWithChain(tx, txid, { transaction_id: txid, is_accepted: true }), 'unavailable');
  assert.equal(m.compareGraduationWithChain(tx, txid, { transaction_id: txid, is_accepted: true, inputs: [inputs[0], { index: 0 }] }), 'unavailable');
  assert.equal(m.compareGraduationWithChain(tx, txid, {}), 'unavailable');
  assert.equal(await m.graduationOnChain({ not: 'a bundle' }, 'testnet-10', { fetch: () => { throw new Error('not called'); } }), 'mismatch');
  await assert.rejects(m.graduationOnChain({}, 'testnet-11'), (e) => e.code === 'UNSUPPORTED_NETWORK');
  assert.equal(m.PUBLIC_KASPA_API['testnet-10'], 'https://api-tn10.kaspa.org');
});
