// The built package through its browser entry, run in Node with the WASM handed over as bytes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const w = await import(pathToFileURL(path.join(DIST, 'web.js')).href);
const wasm = readFileSync(path.join(DIST, 'kaspa/web/kaspa_bg.wasm'));

test('initWeb refuses altered WASM bytes and an unknown network', async () => {
  const bad = Uint8Array.from(wasm);
  bad[bad.length - 1] ^= 0xff;
  await assert.rejects(w.initWeb({ network: 'testnet-10', wasm: bad }), (e) => e.code === 'SDK_INTEGRITY');
  assert.throws(() => w.initWeb({ network: 'devnet' }), (e) => e.code === 'UNSUPPORTED_NETWORK');
  assert.equal(w.sdkAvailable(), false);
});

test('initWeb installs the SDK and the network\'s artifacts; presets load on demand, checked against the manifest', async () => {
  await w.initWeb({ network: 'testnet-10', wasm });
  assert.equal(w.sdk().version(), '2.1.0');
  assert.throws(() => w.createContext('standard-k180', 'testnet-10'), (e) => e.code === 'ARTIFACT_NOT_LOADED');
  await w.ensurePresetArtifacts('standard-k180');
  const ctx = w.createContext('standard-k180', 'testnet-10');
  // The launch build by default (the creator window); the earlier build's preset loaded with it.
  assert.equal(ctx.curve.templateHash, w.artifactManifest.builds['v1-kasseal-mainnet-3-tn10'].presets['standard-k180']);
  assert.equal(ctx.pool.templateHash, w.artifactManifest.builds['v1-kasseal-mainnet-3-tn10'].poolTemplateHash);
  const earlier = w.createContext('standard-k180', 'testnet-10', 'v1', 'v1-kasseal-mainnet-2-tn10');
  assert.equal(earlier.curve.templateHash, w.artifactManifest.builds['v1-kasseal-mainnet-2-tn10'].presets['standard-k180']);
  assert.throws(() => w.createContext('standard', 'mainnet'), (e) => e.code === 'ARTIFACT_MISSING', 'only the initialised network is installed');
  await assert.rejects(w.initWeb({ network: 'mainnet', wasm }), /already ran/);
});

test('a tampered artifact chunk is refused when its preset loads', () => {
  const pkg = mkdtempSync(path.join(tmpdir(), 'kassealhq-sdk-web-'));
  cpSync(DIST, path.join(pkg, 'dist'), { recursive: true });
  const chunks = path.join(pkg, 'dist', 'chunks');
  // The text every curve preset shares lives in the build's curve template; each preset chunk is a patch against it.
  const chunk = readdirSync(chunks).find((f) => f.startsWith('v1-kasseal-mainnet-2-tn10--curve-template-'));
  assert.ok(chunk, 'the curve template chunk exists');
  const text = readFileSync(path.join(chunks, chunk), 'utf8');
  const altered = text.replace('"compiler_version":"0.1.0"', '"compiler_version":"0.1.1"');
  assert.notEqual(altered, text);
  writeFileSync(path.join(chunks, chunk), altered);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const w = await import('./web.js');
    const { readFileSync } = await import('node:fs');
    await w.initWeb({ network: 'testnet-10', wasm: readFileSync('kaspa/web/kaspa_bg.wasm') });
    try { await w.ensurePresetArtifacts('standard-k180'); console.log('loaded'); } catch (e) { console.log(e.code); }
  `], { cwd: path.join(pkg, 'dist'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  assert.equal(r.stdout.trim(), 'ARTIFACT_INTEGRITY');
});

// A caller-supplied Kaspa SDK (`kaspa` option). Each run is its own process: an installed SDK stays for the process.
// The caller's copy of the pinned web build lives outside dist/, so it is a separate module with its own WASM memory.
function callerRun(body, entry = 'web.js') {
  const caller = mkdtempSync(path.join(tmpdir(), 'kassealhq-sdk-caller-'));
  cpSync(path.join(DIST, 'kaspa', 'web'), caller, { recursive: true });
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const w = await import(${JSON.stringify(pathToFileURL(path.join(DIST, entry)).href)});
    const kaspa = await import(${JSON.stringify(pathToFileURL(path.join(caller, 'kaspa.js')).href)});
    const { readFileSync } = await import('node:fs');
    const wasm = readFileSync(${JSON.stringify(path.join(caller, 'kaspa_bg.wasm'))});
    const out = [];
    const outcome = async (p) => { try { await p; return 'ok'; } catch (e) { return [e.code ?? e.name, e.stage, ...(e.failures ?? [])].filter(Boolean).join(' | '); } };
    ${body}
    console.log(JSON.stringify(out));
  `], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr.slice(-3000));
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('initWeb accepts the pinned build supplied by the caller (wasm and digest given) once it passes the known-answer test', () => {
  const [result, version, same, ms, built] = callerRun(`
    const t0 = performance.now();
    out.push(await outcome(w.initWeb({ network: 'testnet-10', kaspa: { module: kaspa, wasm, sha256: w.WEB_WASM_SHA256.toUpperCase() } })));
    const ms = performance.now() - t0;
    out.push(w.sdk().version(), w.sdk().Transaction === kaspa.Transaction, ms);
    await w.ensurePresetArtifacts('standard-k180');
    out.push(w.createContext('standard-k180', 'testnet-10').curve.templateHash === w.artifactManifest.builds['v1-kasseal-mainnet-3-tn10'].presets['standard-k180']);
  `);
  assert.equal(result, 'ok');
  assert.equal(version, '2.1.0');
  assert.equal(same, true, 'the caller\'s module is the installed SDK');
  assert.ok(ms < 1000, `initWeb with the known-answer test took ${ms} ms`);
  assert.equal(built, true);
});

test('initWeb accepts a caller SDK the app already initialised (no wasm passed)', () => {
  const [result, same] = callerRun(`
    await kaspa.default({ module_or_path: wasm });
    out.push(await outcome(w.initWeb({ network: 'mainnet', kaspa: { module: kaspa } })), w.sdk().Transaction === kaspa.Transaction);
  `);
  assert.equal(result, 'ok');
  assert.equal(same, true);
});

test('initWeb refuses a caller SDK that fails a check, installs nothing, and still accepts a good one afterwards', () => {
  const r = callerRun(`
    const bad = new Uint8Array(wasm); bad[bad.length - 1] ^= 0xff;
    out.push(await outcome(w.initWeb({ network: 'testnet-10', kaspa: { module: kaspa, wasm: bad, sha256: w.WEB_WASM_SHA256 } })), w.sdkAvailable());
    try { w.initWeb({ network: 'testnet-10', wasm, kaspa: { module: kaspa, wasm } }); out.push('no throw'); } catch (e) { out.push(e.name); }
    out.push(await outcome(w.initWeb({ network: 'testnet-10', kaspa: { module: kaspa } })), w.sdkAvailable());
    await kaspa.default({ module_or_path: wasm });
    const T = kaspa.Transaction;
    const shim = (patch) => ({ ...kaspa, ...patch });
    // Serialisation that differs by one field.
    class SerialiseBroken extends T { serializeToSafeJSON() { return super.serializeToSafeJSON().replace('"gas":"0"', '"gas":"1"'); } }
    // finalize() that leaves the transaction other than it was built.
    class FinalizeBroken extends T { finalize() { super.finalize(); this.lockTime = this.lockTime + 1n; } }
    // No genesis population.
    class NoGenesis extends T {}
    Object.defineProperty(NoGenesis.prototype, 'populateGenesisCovenants', { value: undefined });
    const otherKey = new kaspa.PrivateKey('11'.repeat(32));
    const cases = {
      version: shim({ version: () => '2.0.6' }),
      serialise: shim({ Transaction: SerialiseBroken }),
      finalize: shim({ Transaction: FinalizeBroken }),
      surface: shim({ Transaction: NoGenesis }),
      signature: shim({ createInputSignature: (tx, i, _key, t) => kaspa.createInputSignature(tx, i, otherKey, t) }),
      p2pkScript: shim({ payToAddressScript: (a) => { const s = kaspa.payToAddressScript(a); return new kaspa.ScriptPublicKey(0, s.script.replace(/ac$/, 'ad')); } }),
    };
    for (const [name, module] of Object.entries(cases)) out.push([name, await outcome(w.initWeb({ network: 'testnet-10', kaspa: { module } })), w.sdkAvailable()]);
    out.push(await outcome(w.initWeb({ network: 'testnet-10', kaspa: { module: kaspa } })), w.sdk().version());
  `);
  const [integrity, afterIntegrity, mixed, uninitialised, afterUninitialised, ...rest] = r;
  assert.match(integrity, /^SDK_INTEGRITY/);
  assert.equal(afterIntegrity, false);
  assert.equal(mixed, 'TypeError');
  assert.match(uninitialised, /^SDK_INCOMPATIBLE \| version \| version\(\) threw/, 'an uninitialised module is refused');
  assert.equal(afterUninitialised, false);
  const byCase = Object.fromEntries(rest.slice(0, 6).map(([name, result, available]) => {
    assert.equal(available, false, `${name}: nothing installed`);
    return [name, result];
  }));
  assert.match(byCase.version, /^SDK_INCOMPATIBLE \| version \| reports version "2.0.6"/);
  assert.match(byCase.surface, /^SDK_INCOMPATIBLE \| surface \| missing method Transaction.prototype.populateGenesisCovenants/);
  assert.match(byCase.serialise, /^SDK_INCOMPATIBLE \| known-answer \| .*p2pk\.txJson: got/);
  assert.match(byCase.serialise, /genesis\.txJson: got/);
  assert.match(byCase.finalize, /^SDK_INCOMPATIBLE \| known-answer \| .*p2pk: threw .*txid/);
  assert.match(byCase.signature, /^SDK_INCOMPATIBLE \| known-answer \| .*p2pk: threw .*invalid signature/);
  assert.match(byCase.p2pkScript, /^SDK_INCOMPATIBLE \| known-answer \| .*scripts\.key\.script\.mainnet: got/);
  assert.deepEqual(rest.slice(6), ['ok', '2.1.0'], 'the genuine module is accepted after the refusals');
});

test('a lite entry bundles no Kaspa SDK: initWeb requires kaspa, then runs on the caller\'s SDK after the known-answer test', () => {
  const [missing, refusedOther, ok, version, same, available, built] = callerRun(`
    try { w.initWeb({}); out.push('no throw'); } catch (e) { out.push(e.name + ': ' + e.message); }
    try { w.initWeb({ network: 'testnet-10', kaspa: { module: kaspa, wasm } }); out.push('no throw'); } catch (e) { out.push(e.code); }
    out.push(await outcome(w.initWeb({ kaspa: { module: kaspa, wasm } })), w.sdk().version(), w.sdk().Transaction === kaspa.Transaction, 'webWasmUrl' in w);
    await w.ensurePresetArtifacts('standard-k180');
    out.push(w.createContext('standard-k180', 'mainnet').curve.templateHash === w.artifactManifest.builds['v1-kasseal-mainnet-3'].presets['standard-k180']);
  `, 'web-lite-mainnet.js');
  assert.match(missing, /^TypeError: .*bundles no Kaspa SDK/);
  assert.equal(refusedOther, 'UNSUPPORTED_NETWORK');
  assert.equal(ok, 'ok');
  assert.equal(version, '2.1.0');
  assert.equal(same, true, 'the caller\'s module is the installed SDK');
  assert.equal(available, false, 'no bundled WASM URL is exported');
  assert.equal(built, true);
});

test('a lite entry refuses a caller SDK that fails the known-answer test and installs nothing', () => {
  const [result, available] = callerRun(`
    await kaspa.default({ module_or_path: wasm });
    class SerialiseBroken extends kaspa.Transaction { serializeToSafeJSON() { return super.serializeToSafeJSON().replace('"gas":"0"', '"gas":"1"'); } }
    out.push(await outcome(w.initWeb({ kaspa: { module: { ...kaspa, Transaction: SerialiseBroken } } })), w.sdkAvailable());
  `, 'web-lite-testnet-10.js');
  assert.match(result, /^SDK_INCOMPATIBLE \| known-answer/);
  assert.equal(available, false);
});
