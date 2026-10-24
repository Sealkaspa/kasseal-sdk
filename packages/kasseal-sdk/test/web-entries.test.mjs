// The built per-network browser entries (`./web/mainnet`, `./web/testnet-10`): the same API as `./web`, an import
// graph that reaches only their own build's artifact chunks, and `initWeb` bound to their network. Each initialisation
// runs in its own process (one Kaspa SDK per context).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkWebEntries, reachable } from '../scripts/check-web-entries.mjs';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const PKG = fileURLToPath(new URL('../', import.meta.url));
const load = (f) => import(pathToFileURL(path.join(DIST, f)).href);
const web = await load('web.js');
const ENTRIES = { mainnet: 'web-mainnet.js', 'testnet-10': 'web-testnet-10.js' };
const BUILD = { mainnet: 'v1-kasseal-mainnet-2', 'testnet-10': 'v1-kasseal-mainnet-2-tn10' };
const OTHER = { mainnet: 'testnet-10', 'testnet-10': 'mainnet' };

const node = (code, cwd = DIST) => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  return JSON.parse(r.stdout.trim().split('\n').pop());
};

test('package.json exports the per-network and lite entries next to the unchanged ones', () => {
  const pj = JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8'));
  assert.deepEqual(pj.exports['./web'], { types: './dist/web.d.ts', default: './dist/web.js' });
  assert.deepEqual(pj.exports['./web/mainnet'], { types: './dist/web-mainnet.d.ts', default: './dist/web-mainnet.js' });
  assert.deepEqual(pj.exports['./web/testnet-10'], { types: './dist/web-testnet-10.d.ts', default: './dist/web-testnet-10.js' });
  assert.deepEqual(pj.exports['./web-lite/mainnet'], { types: './dist/web-lite-mainnet.d.ts', default: './dist/web-lite-mainnet.js' });
  assert.deepEqual(pj.exports['./web-lite/testnet-10'], { types: './dist/web-lite-testnet-10.d.ts', default: './dist/web-lite-testnet-10.js' });
  assert.deepEqual(Object.keys(pj.exports), ['.', './node', './web', './web/mainnet', './web/testnet-10', './web-lite/mainnet', './web-lite/testnet-10', './package.json']);
});

test('each per-network entry reaches its own build\'s chunks only; ./web still reaches both', () => {
  const { results } = checkWebEntries(DIST);
  for (const [network, file] of Object.entries(ENTRIES)) {
    const files = [...reachable(DIST, file).keys()];
    const own = files.filter((f) => f.startsWith(`chunks/${BUILD[network]}--`));
    const other = files.filter((f) => f.startsWith(`chunks/${BUILD[OTHER[network]]}--`));
    assert.equal(other.length, 0, `${file} reaches ${other.length} chunk(s) of ${BUILD[OTHER[network]]}`);
    assert.equal(own.length, Object.keys(web.artifactManifest.builds[BUILD[network]].presets).length + 2, `${file} reaches every chunk of its build`);
    assert.ok(!readFileSync(path.join(DIST, file), 'utf8').includes(`${BUILD[OTHER[network]]}--`), `${file} names no chunk of the other build`);
    const chunkBytes = (r) => Object.values(r.perBuild).reduce((a, x) => a + x.bytes, 0);
    assert.ok(results[file].total < results['web.js'].total, `${file}: ${results[file].total} B vs web.js ${results['web.js'].total} B`);
    assert.equal(chunkBytes(results[file]), results['web.js'].perBuild[BUILD[network]].bytes, `${file} reaches the same chunk bytes of its build as web.js`);
  }
  for (const b of Object.values(BUILD)) assert.ok(results['web.js'].perBuild[b].chunks > 0, `web.js reaches ${b}`);
});

test('each per-network entry exports what ./web exports, plus WEB_NETWORK and WEB_BUILD, sharing classes', async () => {
  for (const [network, file] of Object.entries(ENTRIES)) {
    const m = await load(file);
    assert.deepEqual(Object.keys(m).filter((k) => k !== 'WEB_NETWORK' && k !== 'WEB_BUILD').sort(), Object.keys(web).sort(), file);
    assert.equal(m.WEB_NETWORK, network);
    assert.equal(m.WEB_BUILD, m.BUILD_OF_NETWORK[network]);
    assert.equal(m.WEB_WASM_SHA256, web.WEB_WASM_SHA256);
    assert.equal(m.WEB_JS_SHA256, web.WEB_JS_SHA256);
    assert.equal(m.webWasmUrl().href, web.webWasmUrl().href);
    assert.equal(m.ProofNotBound, web.ProofNotBound);
    assert.equal(m.createTxBuilder, web.createTxBuilder);
  }
});

test('a per-network initWeb refuses another or an unknown network, before loading anything', async () => {
  for (const [network, file] of Object.entries(ENTRIES)) {
    const m = await load(file);
    assert.throws(() => m.initWeb({ network: OTHER[network] }), (e) => e.code === 'UNSUPPORTED_NETWORK' && e.message.includes(`@kassealhq/sdk/web/${OTHER[network]}`));
    assert.throws(() => m.initWeb({ network: 'devnet' }), (e) => e.code === 'UNSUPPORTED_NETWORK');
    assert.equal(m.sdkAvailable(), false);
  }
});

for (const [network, file] of Object.entries(ENTRIES)) {
  test(`${file}: initWeb with no network installs ${network}; presets load on demand; idempotent`, () => {
    const r = node(`
      const m = await import('./${file}');
      const { readFileSync } = await import('node:fs');
      const wasm = readFileSync('kaspa/web/kaspa_bg.wasm');
      const bad = Uint8Array.from(wasm); bad[bad.length - 1] ^= 0xff;
      let badCode = ''; try { await m.initWeb({ wasm: bad }); } catch (e) { badCode = e.code; }
      await m.initWeb({ wasm });
      await m.initWeb({ network: '${network}', wasm });
      let notLoaded = ''; try { m.createContext('standard-k180', '${network}'); } catch (e) { notLoaded = e.code; }
      await m.ensurePresetArtifacts('standard-k180');
      const ctx = m.createContext('standard-k180', '${network}');
      const info = m.artifactManifest.builds['${BUILD[network]}'];
      let other = ''; try { m.createContext('standard', '${OTHER[network]}'); } catch (e) { other = e.code; }
      const w = await import('./web.js');
      await w.initWeb({ network: '${network}', wasm });
      let again = ''; try { await w.initWeb({ network: '${OTHER[network]}', wasm }); } catch (e) { again = e.message; }
      console.log(JSON.stringify({
        badCode, version: m.sdk().version(), notLoaded, curve: ctx.curve.templateHash === info.presets['standard-k180'],
        pool: ctx.pool.templateHash === info.poolTemplateHash, other, again,
      }));
    `);
    assert.deepEqual(r, {
      badCode: 'SDK_INTEGRITY', version: '2.1.0', notLoaded: 'ARTIFACT_NOT_LOADED', curve: true, pool: true, other: 'ARTIFACT_MISSING',
      again: `initWeb already ran for ${network}`,
    });
  });
}

test('preload "all" through a per-network entry loads every preset of that build', () => {
  const r = node(`
    const m = await import('./web-mainnet.js');
    const { readFileSync } = await import('node:fs');
    await m.initWeb({ wasm: readFileSync('kaspa/web/kaspa_bg.wasm'), preload: 'all' });
    const presets = Object.keys(m.artifactManifest.builds['v1-kasseal-mainnet-2'].presets);
    let ok = 0;
    for (const p of presets) if (m.createContext(p, 'mainnet').curve.templateHash === m.artifactManifest.builds['v1-kasseal-mainnet-2'].presets[p]) ok++;
    console.log(JSON.stringify({ ok, total: presets.length }));
  `);
  assert.equal(r.ok, r.total);
});

test('a tampered artifact chunk is refused through a per-network entry', () => {
  const pkg = mkdtempSync(path.join(tmpdir(), 'kassealhq-sdk-web-net-'));
  cpSync(DIST, path.join(pkg, 'dist'), { recursive: true });
  const chunks = path.join(pkg, 'dist', 'chunks');
  // compiler_version lives in the build's curve template; every preset is rebuilt from it.
  const chunk = readdirSync(chunks).find((f) => f.startsWith('v1-kasseal-mainnet-2--curve-template-'));
  assert.ok(chunk, 'the curve template chunk exists');
  const text = readFileSync(path.join(chunks, chunk), 'utf8');
  const altered = text.replace('"compiler_version":"0.1.0"', '"compiler_version":"0.1.1"');
  assert.notEqual(altered, text);
  writeFileSync(path.join(chunks, chunk), altered);
  const r = node(`
    const m = await import('./web-mainnet.js');
    const { readFileSync } = await import('node:fs');
    await m.initWeb({ wasm: readFileSync('kaspa/web/kaspa_bg.wasm') });
    let code = 'loaded'; try { await m.ensurePresetArtifacts('standard-k180'); } catch (e) { code = e.code; }
    console.log(JSON.stringify({ code }));
  `, path.join(pkg, 'dist'));
  assert.equal(r.code, 'ARTIFACT_INTEGRITY');
});
