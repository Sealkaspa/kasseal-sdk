// Token locks through the built package: the Node entry (read, verify, create, claim), the web entries (the lock chunk
// loads on demand, checked against its digests) and the lite entries. Run `node scripts/build.mjs` first.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lockScenario } from '../scripts/parity-scenario.mjs';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const SCENARIO = pathToFileURL(fileURLToPath(new URL('../scripts/parity-scenario.mjs', import.meta.url))).href;
const m = await import(pathToFileURL(path.join(DIST, 'node.js')).href);

const KAS = 100_000_000n;
const DAY = 86_400_000n;
const T = '24'.repeat(32);
const NOW = 1_800_000_000_000n;
const SUPPLY = 1_000_000_000n;

const k = m.sdk();
const key = (last) => new k.PrivateKey(`${'00'.repeat(31)}${last}`);
const xOnlyOf = (last) => m.fromHex(key(last).toPublicKey().toXOnlyPublicKey().toString());

/** A testnet-10 or mainnet world: the creator's cells and coins, a four-release lock built from them. */
function world(network) {
  const set = m.loadLockV1();
  const creator = key('0b').toAddress(network).toString();
  const cell = (amount, seed) => {
    const state = m.userToken(amount, xOnlyOf('0b'));
    return { kind: 'token', outpoint: { txid: seed.repeat(32), index: 0 }, value: 2n * KAS, covenantId: T, program: m.tokenProgram(set.token, state), state, daaScore: 1n };
  };
  const funding = (amount, seed) => ({ outpoint: { txid: seed.repeat(32), index: 0 }, amount, spk: m.p2pkScript(creator), daaScore: 1n, address: creator });
  const params = (over = {}) => ({
    set, creator, factory: { outpoint: { txid: 'f0'.repeat(32), index: 0 }, value: m.LOCK_FACTORY_CELL_KAS, daaScore: 1n }, tokenCells: [cell(1_500_000n, 'c0')],
    beneficiary: { kind: 'p2pk', xOnly: xOnlyOf('0c') }, total: 1_000_000n, start: NOW, cliff: NOW, period: 30n * DAY, tranches: 4n,
    funding: [funding(20n * KAS, 'cf')], supply: SUPPLY, now: NOW - DAY, minDurationMs: m.lockMinDurationMsOf(network), ...over,
  });
  return { set, creator, cell, funding, params };
}

/** The lock cell and its T cell a creation (or a non-final claim) leaves. */
function cellsOf(set, r, lockId, state) {
  const o1 = r.built.outputs[1];
  return {
    lock: m.lockCellOf(set, { outpoint: { txid: r.tx.txid, index: 0 }, value: r.built.outputs[0].value, covenantId: lockId, program: m.lockProgram(set, state), daaScore: 1n }),
    tCell: { kind: 'token', outpoint: { txid: r.tx.txid, index: 1 }, value: o1.value, covenantId: T, program: o1.cell.program, state: o1.cell.predicted.state, daaScore: 1n },
  };
}

test('the Node entry exports the lock surface: read, verify, create, claim; no extend', () => {
  for (const name of ['loadLockSet', 'loadLockV1', 'lockProgramKind', 'lockMinDurationMsOf', 'decodeLockState', 'encodeLockState', 'lockStateOfProgram', 'lockCellOf', 'lockTokenCellProblem',
    'lockVestedAt', 'lockClaimableAt', 'lockNextUnlock', 'lockSchedule', 'lockEndOf', 'lockAmountAt', 'lockDeposit', 'assertLockAppRules', 'buildLockPrep', 'buildLockCreate', 'buildLockClaim',
    'checkLockCreateTx', 'checkLockClaimTx', 'lockFactoryAddressOf', 'lockFactoryCellsOf', 'lockArtifactPaths', 'LockRefused', 'LockClaimNotDue', 'LockRuleViolation']) {
    assert.equal(typeof m[name], 'function', name);
  }
  for (const name of ['buildLockExtend', 'checkLockExtendTx', 'lockExtendSigScript', 'LOCK_EXTEND_AUTHORITY_INDEX', 'parseLockTx', 'BUDGETS_LOCK_V1']) assert.equal(m[name], undefined, name);
  assert.equal(m.LOCK_MIN_DURATION_MS, 7n * DAY);
  assert.equal(m.LOCK_MIN_DURATION_MS_TESTNET, 600_000n);
  assert.equal(m.lockMinDurationMsOf('mainnet'), 7n * DAY);
  assert.equal(m.lockMinDurationMsOf('testnet-10'), 600_000n);
  assert.throws(() => m.lockMinDurationMsOf('testnet-11'), (e) => e.code === 'UNSUPPORTED_NETWORK');
});

test('the lock build is bundled once for both networks, verified at load, with the manifest\'s template hashes', async () => {
  const set = await m.loadLockSet();
  assert.equal(set, m.loadLockV1(), 'one cached set');
  const info = m.artifactManifest.lock;
  assert.deepEqual([...info.networks], ['mainnet', 'testnet-10']);
  assert.equal(set.lock.templateHash, info.lockTemplateHash);
  assert.equal(set.lock.templateHash, '9f4eb229cfea334fafd15c05901ce20a8db0a59ba0932cbc7a3a1de079a70ac9');
  assert.equal(set.factory.templateHash, info.factoryTemplateHash);
  assert.equal(set.factory.templateHash, '481065e01ee2f15fe06e7ce2b865857b073e18a6298e30a22551426c4c328f6b');
  assert.deepEqual(m.lockArtifactPaths(), [...m.lockV1ArtifactPaths()].sort());
  assert.ok(m.verifyArtifacts().includes('contracts/lock/v1/artifacts/lock.artifact.json'));
  for (const p of m.lockArtifactPaths()) assert.match(m.artifactManifest.files[p], /^[0-9a-f]{64}$/);
});

test('read and verify: a lock program is recognised by its template hash, its state decoded, its schedule computed', () => {
  const { set, params } = world('mainnet');
  const c = m.buildLockCreate(params());
  const { lock } = cellsOf(set, c, c.lockId, c.state);
  assert.equal(m.lockProgramKind(set, lock.program), 'lock');
  assert.equal(m.lockProgramKind(set, m.lockFactoryProgram(set, m.fromHex(`0000${m.toHex(m.p2pkScript(key('0b').toAddress('mainnet').toString()))}`))), 'lock-factory');
  assert.equal(m.lockProgramKind(set, set.token.bytecode), undefined, 'a token program is neither');
  assert.equal(m.lockProgramKind(set, m.curveProgram(m.createContext('standard', 'mainnet').curve, { tokenCovId: m.fromHex(T), lotsSold: 0n, feeAccrued: 0n, phase: 1 })), undefined, 'nor a curve');
  const altered = Uint8Array.from(lock.program);
  altered[altered.length - 1] ^= 1;
  assert.equal(m.lockProgramKind(set, altered), undefined, 'a changed program body is not the lock');
  // Another state is the same template: the state window (140 bytes at offset 1) is left out of the hash.
  const other = m.lockProgram(set, { ...c.state, claimed: 1n });
  assert.equal(m.lockProgramKind(set, other), 'lock');

  const s = m.lockStateOfProgram(set, lock.program);
  assert.deepEqual(m.encodeLockState(s), m.encodeLockState(c.state));
  assert.deepEqual(m.decodeLockState(m.encodeLockState(s)), s);
  assert.equal(m.toHex(s.tokenCovId), T);
  assert.equal(s.scheme, m.LOCK_SCHEME_P2PK);
  assert.equal(s.endCap, m.lockEndOf(s) + m.LOCK_FIVE_YEARS_MS);
  assert.equal(m.lockEndOf(s), NOW + 120n * DAY);
  assert.equal(m.lockRemaining(s), 1_000_000n);
  assert.equal(c.lockValue, m.lockDeposit(4n));
  assert.equal(m.lockDeposit(4n), 4n * (KAS + 20_000_000n) + KAS);

  // Vesting: nothing before the first period, two releases after two periods, everything at the end.
  assert.deepEqual(m.lockClaimableAt(s, NOW + 30n * DAY - 1n), { vested: 0n, tranches: 0n, amount: 0n, final: false });
  assert.deepEqual(m.lockClaimableAt(s, NOW + 60n * DAY), { vested: 2n, tranches: 2n, amount: 500_000n, final: false });
  assert.deepEqual(m.lockClaimableAt(s, NOW + 365n * DAY), { vested: 4n, tranches: 4n, amount: 1_000_000n, final: true });
  assert.deepEqual(m.lockNextUnlock(s), { at: NOW + 30n * DAY, vested: 1n, amount: 250_000n, final: false });
  assert.deepEqual(m.lockSchedule(s).map((r) => [r.at, r.vested, r.amount]), [1n, 2n, 3n, 4n].map((i) => [NOW + i * 30n * DAY, i, 250_000n]));
  assert.equal(m.lockStateProblem(s, c.lockId), undefined);
  assert.equal(m.lockStateProblem(s, m.toHex(s.tokenCovId)), 'tokenCovId is the lock itself');
  assert.throws(() => m.decodeLockState(m.encodeLockState(s).subarray(1)));

  // An uneven split spreads the remainder one token at a time; a cliff pays every release due by then at once.
  const uneven = { ...s, total: 10n, tranches: 3n, cliff: NOW + 75n * DAY };
  assert.deepEqual([0n, 1n, 2n, 3n].map((i) => m.lockAmountAt(uneven, i)), [0n, 3n, 6n, 10n]);
  assert.deepEqual(m.lockNextUnlock(uneven), { at: NOW + 75n * DAY, vested: 2n, amount: 6n, final: false });
});

test('create: prep then create, two wallet-signed transactions, checked again from their bytes', () => {
  for (const network of ['mainnet', 'testnet-10']) {
    const { set, creator, cell, funding, params } = world(network);
    const prep = m.buildLockPrep({ set, creator, funding: [funding(50n * KAS, 'a1')] });
    assert.deepEqual(prep.tx.produces.map((p) => p.role), ['lock-factory', 'change']);
    assert.equal(prep.factory.value, m.LOCK_FACTORY_CELL_KAS);
    assert.match(m.lockFactoryAddressOf(set, creator), network === 'mainnet' ? /^kaspa:p/ : /^kaspatest:p/);
    assert.deepEqual(prep.tx.inputsToSign.map((i) => i.index), [0]);

    const change = { outpoint: { txid: prep.tx.txid, index: 1 }, amount: prep.built.outputs[1].value, spk: m.p2pkScript(creator), daaScore: 0n, address: creator };
    const c = m.buildLockCreate(params({ factory: { ...prep.factory, daaScore: 0n }, tokenCells: [cell(6_000_000n, 'b1'), cell(5_000_000n, 'b2')], total: 10_000_000n, funding: [change] }));
    assert.equal(c.restAmount, 1_000_000n);
    assert.deepEqual(c.tx.produces.map((p) => p.role), ['lock', 'token-rest', 'token-user', 'change']);
    assert.deepEqual(c.tx.inputsToSign.map((i) => i.index), [1, 2, 3], 'the token cells and the KAS sign; the factory input carries no signature');
    const check = m.checkLockCreateTx(set, c.tx, { supply: SUPPLY, now: NOW - DAY, creator, minDurationMs: m.lockMinDurationMsOf(network) }, { feerate: 100n });
    assert.equal(check.lockId, c.lockId);
    assert.equal(check.fee, c.tx.feeSompi);
    // A tampered deposit is refused before signing.
    const j = JSON.parse(c.tx.txJson);
    j.outputs[0].value = String(BigInt(j.outputs[0].value) - 1n);
    assert.throws(() => m.checkLockCreateTx(set, { ...c.tx, txJson: JSON.stringify(j) }, { supply: SUPPLY, now: NOW - DAY }), (e) => e.code === 'LOCK_REFUSED');
    // The prep signs with a local key; the create's token cells are P2SH slots: a wallet signs them, or a local signer
    // writes each SIGHASH_ALL signature at its slot (trading-bots.md section 7). Either way `finalizeSigned` accepts it.
    assert.equal(m.signBuiltWithKey(prep.tx, key('0b')).txid, prep.tx.txid);
    assert.throws(() => m.signBuiltWithKey(c.tx, key('0b')), (e) => e.code === 'FINALIZE');
    assert.deepEqual(c.tx.inputsToSign.map((s) => s.kind), ['p2sh-leader', 'p2sh-delegator', 'p2pk']);
    const tx = k.Transaction.deserializeFromSafeJSON(c.tx.txJson);
    const ins = tx.inputs;
    const { signatureFromP2pkSigScript } = m;
    for (const s of c.tx.inputsToSign) {
      const sig = signatureFromP2pkSigScript(k.createInputSignature(tx, s.index, key('0b'), k.SighashType.All));
      ins[s.index].signatureScript = s.kind === 'p2pk' ? m.toHex(Uint8Array.of(0x41, ...sig)) : m.toHex(m.spliceSignature(m.fromHex(ins[s.index].signatureScript), s.signatureOffset, sig));
    }
    tx.inputs = ins;
    assert.equal(m.finalizeSigned(c.tx, tx.serializeToSafeJSON()).txid, c.tx.txid);
  }
});

test('the app rules: 0.05 % of supply, 7 days on mainnet (10 minutes on testnet-10 or when asked), at most 2 years and 100 releases, nothing claimable at creation', () => {
  const { params } = world('mainnet');
  const refused = (over, rule) => assert.throws(() => m.buildLockCreate(params(over)), (e) => e instanceof m.LockRefused && e.code === 'LOCK_REFUSED' && e.rule === rule && m.errorCode(e) === 'LOCK_REFUSED');
  const tenMinutes = { start: NOW - DAY, cliff: NOW - DAY + 600_000n, period: 600_000n, tranches: 1n };
  refused({ ...tenMinutes, minDurationMs: undefined }, 'app-rule');
  refused({ ...tenMinutes, minDurationMs: m.LOCK_MIN_DURATION_MS }, 'app-rule');
  assert.doesNotThrow(() => m.buildLockCreate(params({ ...tenMinutes, minDurationMs: m.LOCK_MIN_DURATION_MS_TESTNET })), 'the contract allows it; the 10-minute policy is the caller\'s choice');
  refused({ total: 499_999n, tokenCells: [world('mainnet').cell(499_999n, 'c1')] }, 'app-rule');
  refused({ period: 300n * DAY, tranches: 3n }, 'app-rule');
  refused({ tranches: 101n }, 'app-rule');
  refused({ start: NOW - 31n * DAY }, 'app-rule');
  refused({ beneficiary: { kind: 'p2pk', xOnly: new Uint8Array(32).fill(0xff) } }, 'beneficiary');
  refused({ beneficiary: { kind: 'p2sh', redeem: m.fromHex('51') } }, 'beneficiary');
  assert.throws(() => m.assertLockAppRules({ tokenCovId: m.fromHex(T), beneficiary: xOnlyOf('0c'), scheme: 0, total: 1n, start: NOW, cliff: NOW, period: DAY * 30n, tranches: 1n }, { supply: SUPPLY, now: NOW - DAY }),
    (e) => e instanceof m.LockRuleViolation && e.code === 'LOCK_RULE' && e.rule === 'size');
});

test('claim: unsigned, a release vested at the claim\'s lock time; nothing due is LockClaimNotDue; the final claim pays the lock\'s KAS to the beneficiary', () => {
  const { set, params } = world('testnet-10');
  const c = m.buildLockCreate(params({ start: NOW, cliff: NOW, period: 180_000n, tranches: 4n, now: NOW }));
  const live = cellsOf(set, c, c.lockId, c.state);
  assert.throws(() => m.buildLockClaim({ set, ...live, now: NOW + 179_999n }), (e) => e instanceof m.LockClaimNotDue && e.code === 'LOCK_CLAIM_NOT_DUE' && e.nextAt === NOW + 180_000n);
  const r = m.buildLockClaim({ set, ...live, now: NOW + 360_000n });
  assert.equal(r.final, false);
  assert.equal(r.vested, 2n);
  assert.equal(r.amount, 500_000n);
  assert.equal(r.tx.inputsToSign.length, 0, 'a claim has nothing to sign');
  assert.ok(r.feeSompi <= m.LOCK_FEE_CAP);
  assert.equal(JSON.parse(r.tx.txJson).lockTime, String(NOW + 360_000n));
  assert.deepEqual(r.tx.produces.map((p) => p.role), ['lock', 'token-rest', 'token-user']);
  const check = m.checkLockClaimTx(set, r.tx, { feerate: 100n, pastMedianTime: NOW + 360_001n });
  assert.equal(check.vested, 2n);
  assert.throws(() => m.checkLockClaimTx(set, r.tx, { pastMedianTime: NOW + 360_000n }), (e) => e.code === 'LOCK_REFUSED' && e.rule === 'time');

  const last = m.buildLockClaim({ set, ...cellsOf(set, r, c.lockId, r.next), now: NOW + 3_600_000n });
  assert.equal(last.final, true);
  assert.equal(last.amount, 500_000n);
  assert.deepEqual(last.tx.produces.map((p) => p.role), ['token-user', 'beneficiary']);
  const out = JSON.parse(last.tx.txJson).outputs;
  assert.equal(out[1].scriptPublicKey, `0000${m.toHex(m.lockPayeeScript(c.state))}`);
  assert.equal(BigInt(out[0].value), m.LOCK_PAYOUT_CELL_KAS);
  // A cell that is not the lock's own T cell is refused.
  const decoy = { ...live.tCell, outpoint: { txid: 'de'.repeat(32), index: 1 } };
  assert.throws(() => m.buildLockClaim({ set, lock: live.lock, tCell: decoy, now: NOW + 360_000n }), (e) => e.code === 'LOCK_REFUSED' && e.rule === 'lock-cell');
});

test('the lock scenario of the parity check builds the same bytes through the Node entry on both networks', () => {
  for (const network of ['mainnet', 'testnet-10']) {
    const r = lockScenario(m, network);
    assert.equal(Object.keys(r).length, 7, network);
    for (const v of Object.values(r)) assert.match(v.txid, /^[0-9a-f]{64}$/);
  }
});

/** Run `body` in a fresh process with the web entry `entry` as `w`; prints `out`. */
function webRun(body, entry, cwd = DIST) {
  const caller = mkdtempSync(path.join(tmpdir(), 'kassealhq-sdk-lock-caller-'));
  cpSync(path.join(DIST, 'kaspa', 'web'), caller, { recursive: true });
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const w = await import('./${entry}');
    const kaspa = await import(${JSON.stringify(pathToFileURL(path.join(caller, 'kaspa.js')).href)});
    const { lockScenario } = await import(${JSON.stringify(SCENARIO)});
    const { readFileSync } = await import('node:fs');
    const wasm = readFileSync(${JSON.stringify(path.join(caller, 'kaspa_bg.wasm'))});
    const out = [];
    const code = async (f) => { try { await f(); return 'ok'; } catch (e) { return e.code ?? e.name; } };
    ${body}
    console.log(JSON.stringify(out));
  `], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr.slice(-3000));
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

for (const [entry, network, own] of [['web.js', 'testnet-10', false], ['web-mainnet.js', 'mainnet', false], ['web-testnet-10.js', 'testnet-10', false], ['web-lite-mainnet.js', 'mainnet', true], ['web-lite-testnet-10.js', 'testnet-10', true]]) {
  test(`${entry}: the lock build loads on demand after initWeb and builds the Node entry's bytes`, () => {
    const expected = lockScenario(m, network);
    const [before, loaded, same, kind, scenario] = webRun(`
      out.push(await code(() => w.loadLockV1()));
      await w.initWeb({ network: '${network}', ${own ? 'kaspa: { module: kaspa, wasm }' : 'wasm'} });
      const set = await w.loadLockSet();
      out.push(set.lock.templateHash === w.artifactManifest.lock.lockTemplateHash && set.factory.templateHash === w.artifactManifest.lock.factoryTemplateHash);
      out.push(set === w.loadLockV1(), w.lockProgramKind(set, set.lock.bytecode), lockScenario(w, '${network}'));
    `, entry);
    assert.equal(before, 'ARTIFACT_SOURCE_NOT_INSTALLED');
    assert.equal(loaded, true);
    assert.equal(same, true);
    assert.equal(kind, 'lock');
    assert.deepEqual(scenario, expected, 'web and Node build the same lock transactions');
  });
}

test('a web entry refuses a tampered lock chunk when the lock build loads', () => {
  const pkg = mkdtempSync(path.join(tmpdir(), 'kassealhq-sdk-lock-web-'));
  cpSync(DIST, path.join(pkg, 'dist'), { recursive: true });
  const chunks = path.join(pkg, 'dist', 'chunks');
  const chunk = readdirSync(chunks).find((f) => f.startsWith('token-lock-v1-'));
  assert.ok(chunk, 'the lock chunk exists');
  const text = readFileSync(path.join(chunks, chunk), 'utf8');
  const altered = text.replace('LOCK_VERSION 1', 'LOCK_VERSION 2');
  assert.notEqual(altered, text);
  writeFileSync(path.join(chunks, chunk), altered);
  const [result, presets] = webRun(`
    await w.initWeb({ wasm });
    out.push(await code(() => w.loadLockSet()));
    await w.ensurePresetArtifacts('standard');
    out.push(w.createContext('standard', 'mainnet').curve.templateHash === w.artifactManifest.builds['v1-kasseal-mainnet-3'].presets.standard);
  `, 'web-mainnet.js', path.join(pkg, 'dist'));
  assert.equal(result, 'ARTIFACT_INTEGRITY');
  assert.equal(presets, true, 'the rest of the package still works');
});
