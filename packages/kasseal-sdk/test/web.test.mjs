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
  assert.equal(ctx.curve.templateHash, w.artifactManifest.builds['v1-kasseal-mainnet-2-tn10'].presets['standard-k180']);
  assert.equal(ctx.pool.templateHash, w.artifactManifest.builds['v1-kasseal-mainnet-2-tn10'].poolTemplateHash);
  assert.throws(() => w.createContext('standard', 'mainnet'), (e) => e.code === 'ARTIFACT_MISSING', 'only the initialised network is installed');
  await assert.rejects(w.initWeb({ network: 'mainnet', wasm }), /already ran/);
});

test('a tampered artifact chunk is refused when its preset loads', () => {
  const pkg = mkdtempSync(path.join(tmpdir(), 'kassealhq-sdk-web-'));
  cpSync(DIST, path.join(pkg, 'dist'), { recursive: true });
  const chunks = path.join(pkg, 'dist', 'chunks');
  const chunk = readdirSync(chunks).find((f) => f.startsWith('v1-kasseal-mainnet-2-tn10--standard-k180-'));
  assert.ok(chunk, 'the preset chunk exists');
  const text = readFileSync(path.join(chunks, chunk), 'utf8');
  const altered = text.replace('"compiler_version": "0.1.0"', '"compiler_version": "0.1.1"');
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
