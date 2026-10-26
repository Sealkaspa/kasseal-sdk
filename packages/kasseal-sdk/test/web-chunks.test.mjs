// The web curve-preset chunks (a template per build plus a patch per preset) give back every artifact file byte for
// byte, and an altered patch is refused by the digest check (run `node scripts/build.mjs` first).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const decoder = await import(new URL('../src/web-chunks.ts', import.meta.url).href);
const manifest = JSON.parse(readFileSync(path.join(DIST, 'artifacts', 'manifest.json'), 'utf8'));
const BUILDS = ['v1-kasseal-mainnet-3', 'v1-kasseal-mainnet-2', 'v1-kasseal-mainnet-3-tn10', 'v1-kasseal-mainnet-2-tn10'];
const NETWORK = { 'v1-kasseal-mainnet-3': 'mainnet', 'v1-kasseal-mainnet-2': 'mainnet', 'v1-kasseal-mainnet-3-tn10': 'testnet-10', 'v1-kasseal-mainnet-2-tn10': 'testnet-10' };
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** The emitted chunk file of `<build>--<name>` (esbuild appends `-<hash>.js`). */
function chunkFile(dir, build, name) {
  const re = new RegExp(`^${build.replace(/[-]/g, '\\-')}--${name.replace(/[-]/g, '\\-')}-[A-Z0-9]{8}\\.js$`);
  const hits = readdirSync(dir).filter((f) => re.test(f));
  assert.equal(hits.length, 1, `${build}--${name}: ${hits.length} chunk files`);
  return path.join(dir, hits[0]);
}

const loadChunk = async (build, name) => (await import(pathToFileURL(chunkFile(path.join(DIST, 'chunks'), build, name)).href)).default;

test('every curve preset of every build is rebuilt from template + patch byte for byte', async () => {
  for (const build of BUILDS) {
    const presets = Object.keys(manifest.builds[build].presets).sort();
    assert.equal(presets.length, 66, build);
    const template = await loadChunk(build, 'curve-template');
    assert.ok(decoder.isCurveTemplateChunk(template), `${build}: template chunk`);
    for (const preset of presets) {
      const chunk = await loadChunk(build, preset);
      assert.ok(decoder.isCurvePatchChunk(chunk), `${build} ${preset}: patch chunk`);
      const dir = `contracts/curve/v1/artifacts/${build}`;
      const want = [`${dir}/curve.${preset}.artifact.json`, `${dir}/curve.ctor.${preset}.json`];
      const files = decoder.decodeCurvePatchChunk(template, chunk);
      assert.deepEqual(Object.keys(files).sort(), [...want].sort(), `${build} ${preset}: file list`);
      for (const f of want) {
        const original = readFileSync(path.join(DIST, 'artifacts', f));
        const rebuilt = Buffer.from(files[f], 'utf8');
        assert.ok(rebuilt.equals(original), `${build} ${preset}: ${f} differs from dist/artifacts`);
        assert.equal(sha256(rebuilt), manifest.files[f], `${build} ${preset}: ${f} digest`);
      }
      assert.ok(statSync(chunkFile(path.join(DIST, 'chunks'), build, preset)).size < 4096, `${build} ${preset}: chunk under 4 KB`);
    }
  }
});

test('the web entry loads every preset of every build through the digest checks', () => {
  for (const build of BUILDS) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const w = await import('./web.js');
      const { readFileSync } = await import('node:fs');
      await w.initWeb({ network: ${JSON.stringify(NETWORK[build])}, wasm: readFileSync('kaspa/web/kaspa_bg.wasm'), preload: 'all' });
      const info = w.artifactManifest.builds[${JSON.stringify(build)}];
      let n = 0;
      for (const [preset, h] of Object.entries(info.presets)) {
        const ctx = w.createContext(preset, info.network, 'v1', ${JSON.stringify(build)});
        if (ctx.curve.templateHash !== h) throw new Error(preset + ': template hash differs');
        n++;
      }
      console.log(n);
    `], { cwd: DIST, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr.slice(-2000));
    assert.equal(r.stdout.trim(), '66', build);
  }
});

test('an altered patch is refused by the digest check', () => {
  const pkg = mkdtempSync(path.join(tmpdir(), 'kassealhq-sdk-web-chunks-'));
  cpSync(DIST, path.join(pkg, 'dist'), { recursive: true });
  const chunks = path.join(pkg, 'dist', 'chunks');
  const build = 'v1-kasseal-mainnet-2-tn10';
  const alter = (name, edit) => {
    const f = chunkFile(chunks, build, name);
    const text = readFileSync(f, 'utf8');
    const altered = edit(text);
    assert.notEqual(altered, text, `${name}: altered`);
    writeFileSync(f, altered);
  };
  // standard-k180: one byte of the inserted bytecode; standard-k198: the template hash; standard-k218: a constructor
  // value; standard-k240: a hunk that points past the end of the bytecode (rejected while decoding).
  alter('standard-k180', (t) => t.replace('"x":[109,5,"00badb0000"', '"x":[109,5,"00badb0001"'));
  alter('standard-k198', (t) => t.replace(/("template_hash"\],"x":\[0,32,")([0-9a-f])/, (_, a, c) => a + (c === '0' ? '1' : '0')));
  alter('standard-k218', (t) => t.replace(/("p":\[5,"value"\],"v":)(\d+)/, (_, a, n) => a + String(Number(n) + 1)));
  alter('standard-k240', (t) => t.replace('"x":[109,', '"x":[99999,'));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const w = await import('./web.js');
    const { readFileSync } = await import('node:fs');
    await w.initWeb({ network: 'testnet-10', wasm: readFileSync('kaspa/web/kaspa_bg.wasm') });
    const out = {};
    for (const p of ['standard-k180', 'standard-k198', 'standard-k218', 'standard-k240', 'standard-k264']) {
      try { await w.ensurePresetArtifacts(p); out[p] = 'loaded'; } catch (e) { out[p] = e.code + ' ' + e.message; }
    }
    console.log(JSON.stringify(out));
  `], { cwd: path.join(pkg, 'dist'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const out = JSON.parse(r.stdout.trim());
  for (const p of ['standard-k180', 'standard-k198', 'standard-k218']) {
    assert.match(out[p], /^ARTIFACT_INTEGRITY .*sha256 [0-9a-f]{64} does not match the pinned [0-9a-f]{64}/, p);
  }
  assert.match(out['standard-k240'], /^ARTIFACT_INTEGRITY .*could not be decoded/);
  assert.equal(out['standard-k264'], 'loaded', 'an untouched preset still loads');
});

test('the decoder refuses malformed patches and templates', async () => {
  const build = BUILDS[0];
  const template = await loadChunk(build, 'curve-template');
  const chunk = await loadChunk(build, 'standard-k180');
  const [path0, patch] = Object.entries(chunk.files).find(([f]) => f.endsWith('.artifact.json'));
  const bad = (ops) => ({ curvePatch: 1, files: { [path0]: { ...patch, ops } } });
  assert.throws(() => decoder.decodeCurvePatchChunk(template, bad([{ p: ['contracts', 'Nope'], v: 1 }])), /not in the template/);
  assert.throws(() => decoder.decodeCurvePatchChunk(template, bad([{ p: ['schema_version'], x: [0, 1, '00'] }])), /not bytes/);
  assert.throws(() => decoder.decodeCurvePatchChunk(template, bad([{ p: ['contracts', 'Curve', 'compiled', 'bytecode'], x: [0, 1, 'zz'] }])), /malformed byte edit/);
  assert.throws(() => decoder.decodeCurvePatchChunk(template, { curvePatch: 1, files: { [path0]: { t: 'nope', ops: [] } } }), /malformed file patch/);
  assert.throws(() => decoder.decodeCurvePatchChunk(template, bad(['x'])), /malformed patch op/);
  assert.equal(decoder.applyHunks('00112233', [1, 2, 'ff', 0, 0, 'ee']), '00ffee33');
});
