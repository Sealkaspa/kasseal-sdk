#!/usr/bin/env node
// Build @kassealhq/sdk into dist/: the artifact manifest and copies of the two bundled contract builds, the pinned
// Kaspa SDK builds, the JavaScript bundles (no workspace dependencies, no comments) and the bundled declarations
// (comments stripped, stable error codes declared). `--gen-only` writes only src/generated/ (for typechecking).
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const PACKAGES = path.resolve(PKG, '..');
const DIST = path.join(PKG, 'dist');
const GEN = path.join(PKG, 'src', 'generated');
const require = createRequire(import.meta.url);
const genOnly = process.argv.includes('--gen-only');

const BUILDS = Object.freeze({ 'v1-kasseal-mainnet-2': 'mainnet', 'v1-kasseal-mainnet-2-tn10': 'testnet-10' });
const TOKEN_REFERENCE = 'codec/fixtures/argent-kcc20-reference-c8a0871.json';
const TOKEN_REFERENCE_SOURCE = 'argent-lang/kcc20-reference@c8a0871 fixtures/public-mint/artifact.json';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const fail = (msg) => { console.error(`build: ${msg}`); process.exit(1); };
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// ---------------------------------------------------------------- inputs

const curveMath = await import(pathToFileURL(path.join(PACKAGES, 'curve-math/src/index.ts')).href);
const PRESETS = curveMath.STANDARD_FAMILY.map((p) => p.name).sort();
if (PRESETS.length === 0 || !PRESETS.includes('standard')) fail('the Standard family is empty');

/** Every artifact file of the package: path relative to the artifact root -> absolute source path. */
const files = new Map();
const builds = {};
for (const [build, network] of Object.entries(BUILDS)) {
  const curveDir = `contracts/curve/v1/artifacts/${build}`;
  const poolDir = `contracts/pool/v1/artifacts/${build}`;
  const cm = readJson(path.join(PACKAGES, curveDir, 'manifest.json'));
  const pm = readJson(path.join(PACKAGES, poolDir, 'manifest.json'));
  if (cm.network !== network || pm.network !== network) fail(`${build}: manifests name network ${cm.network}/${pm.network}, expected ${network}`);
  if (cm.poolH !== pm.templateHash) fail(`${build}: curve poolH ${cm.poolH} != pool ${pm.templateHash}`);
  if (cm.treasurySpk !== pm.treasurySpk) fail(`${build}: curve and pool treasuries differ`);
  for (const f of ['pool.artifact.json', 'pool.ctor.json']) {
    const src = path.join(PACKAGES, poolDir, f);
    if (sha256(readFileSync(src)) !== pm.sha256[f]) fail(`${build}: ${f} does not match its frozen manifest`);
    files.set(`${poolDir}/${f}`, src);
  }
  const presets = {};
  for (const p of PRESETS) {
    const t = cm.presets[p];
    if (t === undefined) fail(`${build}: preset ${p} is not in the frozen manifest`);
    presets[p] = t.templateHash;
    for (const f of [`curve.${p}.artifact.json`, `curve.ctor.${p}.json`]) {
      const src = path.join(PACKAGES, curveDir, f);
      if (!existsSync(src)) fail(`${build}: ${f} is missing`);
      files.set(`${curveDir}/${f}`, src);
    }
  }
  builds[build] = {
    network,
    poolTemplateHash: pm.templateHash,
    treasurySpk: pm.treasurySpk,
    compiler: `${cm.compiler.name} ${cm.compiler.tag} ${cm.compiler.commit}`,
    presets,
  };
}
files.set(TOKEN_REFERENCE, path.join(PACKAGES, TOKEN_REFERENCE));

const codecTemplates = await import(pathToFileURL(path.join(PACKAGES, 'codec/src/templates.ts')).href);
const manifest = {
  format: 1,
  builds,
  tokenReference: { path: TOKEN_REFERENCE, templateHash: codecTemplates.REFERENCE_KCC0020_TEMPLATE_HASH, source: TOKEN_REFERENCE_SOURCE },
  files: Object.fromEntries([...files.keys()].sort().map((k) => [k, sha256(readFileSync(files.get(k)))])),
};
for (const k of Object.keys(manifest.files)) {
  if (k.endsWith('.sil')) fail(`${k}: sources are never bundled`);
  const m = /\/artifacts\/([^/]+)\//.exec(k);
  if (m && !(m[1] in BUILDS)) fail(`${k}: not one of the bundled builds`);
}

// The template hashes the builder computes from these files are the frozen manifests' (checked through the in-repo builder).
{
  const tb = await import(pathToFileURL(path.join(PACKAGES, 'txbuilder/src/index.node.ts')).href);
  for (const [build, info] of Object.entries(builds)) {
    for (const p of PRESETS) {
      const ctx = tb.createContext(p, info.network, 'v1', build);
      if (ctx.curve.templateHash !== info.presets[p]) fail(`${build} ${p}: template hash ${ctx.curve.templateHash} != manifest ${info.presets[p]}`);
      if (ctx.pool.templateHash !== info.poolTemplateHash) fail(`${build}: pool template hash ${ctx.pool.templateHash} != manifest`);
    }
    if (tb.loadTokenTemplate().templateHash !== manifest.tokenReference.templateHash) fail('token reference template hash differs');
  }
}

// Kaspa SDK: the vendored files, checked against packages/sdk/SHA256SUMS.
const SDK = path.join(PACKAGES, 'sdk');
const sums = new Map();
for (const line of readFileSync(path.join(SDK, 'SHA256SUMS'), 'utf8').split('\n')) {
  const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
  if (m) sums.set(m[2], m[1]);
}
const kaspa = {};
for (const flavour of ['nodejs', 'web']) {
  const dir = path.join(SDK, 'vendor', flavour, 'kaspa');
  for (const f of readdirSync(dir).sort()) {
    const rel = `vendor/${flavour}/kaspa/${f}`;
    const expected = sums.get(rel);
    if (expected === undefined) fail(`${rel} is not listed in SHA256SUMS`);
    if (sha256(readFileSync(path.join(dir, f))) !== expected) fail(`${rel} does not match SHA256SUMS`);
    kaspa[`${flavour}/${f}`] = expected;
  }
}

// ---------------------------------------------------------------- generated sources

rmSync(GEN, { recursive: true, force: true });
mkdirSync(path.join(GEN, 'web'), { recursive: true });
writeFileSync(path.join(GEN, 'manifest.ts'), [
  '// Generated by scripts/build.mjs. Do not edit.',
  `export const ARTIFACT_MANIFEST: unknown = ${JSON.stringify(manifest, null, 1)};`,
  `export const KASPA_SHA256: Readonly<Record<string, string>> = ${JSON.stringify(kaspa, null, 1)};`,
  '',
].join('\n'));
// Web modules per build: `base` (pool and token reference, `{ path: text }`), `curve-template` (the reference preset's
// curve files) and one per curve preset (a patch against the template; src/web-chunks.ts). Every preset chunk is
// decoded here and must give back each file byte for byte.
const webChunks = await import(pathToFileURL(path.join(PKG, 'scripts', 'web-chunks.mjs')).href);
const webDecode = await import(pathToFileURL(path.join(PKG, 'src', 'web-chunks.ts')).href);
const CURVE_TEMPLATE_PRESET = 'standard';
const webSizes = {};
for (const build of Object.keys(BUILDS)) {
  const write = (name, obj) => {
    const text = `export default ${JSON.stringify(obj)};\n`;
    writeFileSync(path.join(GEN, 'web', `${build}--${name}.js`), text);
    return text.length;
  };
  const textOf = (p) => readFileSync(files.get(p), 'utf8');
  write('base', Object.fromEntries([`contracts/pool/v1/artifacts/${build}/pool.artifact.json`, `contracts/pool/v1/artifacts/${build}/pool.ctor.json`, TOKEN_REFERENCE].map((p) => [p, textOf(p)])));
  const curvePaths = (p) => ({ artifact: `contracts/curve/v1/artifacts/${build}/curve.${p}.artifact.json`, ctor: `contracts/curve/v1/artifacts/${build}/curve.ctor.${p}.json` });
  const { template, patches } = webChunks.encodeCurvePresets(
    Object.fromEntries(PRESETS.map((p) => [p, Object.fromEntries(Object.entries(curvePaths(p)).map(([kind, f]) => [kind, textOf(f)]))])),
    CURVE_TEMPLATE_PRESET,
  );
  const sizes = { template: write('curve-template', template), presets: 0, largest: 0 };
  for (const p of PRESETS) {
    const chunk = { curvePatch: 1, files: Object.fromEntries(Object.entries(curvePaths(p)).map(([kind, f]) => [f, patches[p][kind]])) };
    const decoded = webDecode.decodeCurvePatchChunk(template, JSON.parse(JSON.stringify(chunk)));
    for (const f of Object.values(curvePaths(p))) {
      const want = readFileSync(files.get(f));
      if (decoded[f] === undefined || !Buffer.from(decoded[f], 'utf8').equals(want)) fail(`${build} ${p}: the web chunk does not give back ${f} byte for byte`);
      if (sha256(Buffer.from(decoded[f], 'utf8')) !== manifest.files[f]) fail(`${build} ${p}: the web chunk's ${f} does not match the manifest`);
    }
    const n = write(p, chunk);
    sizes.presets += n;
    sizes.largest = Math.max(sizes.largest, n);
  }
  webSizes[build] = sizes;
}
for (const [build, s] of Object.entries(webSizes)) {
  console.log(`web chunks ${build}: curve template ${s.template} B, ${PRESETS.length} preset patches ${s.presets} B (largest ${s.largest} B), every file given back byte for byte`);
}
if (genOnly) {
  console.log(`generated: ${Object.keys(manifest.files).length} artifact files, ${Object.keys(kaspa).length} SDK files`);
  process.exit(0);
}

// ---------------------------------------------------------------- dist

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
for (const [rel, src] of files) {
  const dst = path.join(DIST, 'artifacts', rel);
  mkdirSync(path.dirname(dst), { recursive: true });
  cpSync(src, dst);
}
writeFileSync(path.join(DIST, 'artifacts', 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
for (const flavour of ['nodejs', 'web']) cpSync(path.join(SDK, 'vendor', flavour, 'kaspa'), path.join(DIST, 'kaspa', flavour), { recursive: true });
writeFileSync(path.join(DIST, 'kaspa', 'sdk-types.d.ts'), "export type KaspaSdk = typeof import('./nodejs/kaspa.js');\n");

// JavaScript.
const esbuild = require('esbuild-wasm');
const scrub = await import(pathToFileURL(path.join(PKG, 'scripts', 'scrub.mjs')).href);
const KASPA_WEB = /sdk\/vendor\/web\/kaspa\/kaspa\.js$/;
// The browser entries: `web` (both builds), one per network that reaches only its own build's artifact chunks, and
// one per network without the bundled Kaspa SDK (`web-lite-*`, for apps that pass their own).
const WEB_ENTRIES = {
  web: 'src/web.ts', 'web-mainnet': 'src/web-mainnet.ts', 'web-testnet-10': 'src/web-testnet-10.ts',
  'web-lite-mainnet': 'src/web-lite-mainnet.ts', 'web-lite-testnet-10': 'src/web-lite-testnet-10.ts',
};
const BUNDLES_KASPA = ['web', 'web-mainnet', 'web-testnet-10'];
const result = await esbuild.build({
  absWorkingDir: PKG,
  entryPoints: { index: 'src/index.ts', node: 'src/node.ts', ...WEB_ENTRIES },
  outdir: DIST,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  chunkNames: 'chunks/[name]-[hash]',
  legalComments: 'none',
  charset: 'utf8',
  sourcemap: false,
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: false,
  keepNames: true,
  treeShaking: true,
  metafile: true,
  logLevel: 'warning',
  external: ['node:*'],
  plugins: [scrub.esbuildScrubPlugin(), {
    name: 'kaspa-web-external',
    setup(b) {
      b.onResolve({ filter: KASPA_WEB }, () => ({ path: './kaspa/web/kaspa.js', external: true }));
    },
  }],
});
// No workspace or other bare imports may remain in the output.
for (const [out, meta] of Object.entries(result.metafile.outputs)) {
  for (const imp of meta.imports) {
    if (!imp.external) continue;
    if (imp.path.startsWith('node:')) continue;
    if (imp.path === './kaspa/web/kaspa.js' && BUNDLES_KASPA.some((e) => out === `dist/${e}.js`)) continue;
    fail(`${out} imports ${imp.path}`);
  }
}

// Declarations.
const { rollup } = require('rollup');
const { dts } = require('rollup-plugin-dts');
const KASPA_TYPES = {
  '@kasseal/sdk': './kaspa/sdk-types.js',
  '@kasseal/sdk/vendor/nodejs/kaspa/kaspa.js': './kaspa/nodejs/kaspa.js',
};
const bundle = await rollup({
  input: { index: path.join(PKG, 'src/index.ts'), node: path.join(PKG, 'src/node.ts'), ...Object.fromEntries(Object.entries(WEB_ENTRIES).map(([k, v]) => [k, path.join(PKG, v)])) },
  external: (id) => id in KASPA_TYPES || KASPA_WEB.test(id) || id.startsWith('node:'),
  plugins: [dts({
    respectExternal: true,
    tsconfig: path.join(PKG, 'tsconfig.json'),
    compilerOptions: { removeComments: true, stripInternal: true },
  })],
  onwarn(w, warn) {
    if (w.code === 'CIRCULAR_DEPENDENCY') return;
    warn(w);
  },
});
await bundle.write({
  dir: DIST,
  format: 'es',
  entryFileNames: '[name].d.ts',
  chunkFileNames: 'types-[hash].d.ts',
  paths: (id) => KASPA_TYPES[id] ?? (KASPA_WEB.test(id) ? './kaspa/web/kaspa.js' : id),
});
await bundle.close();

// Strip any comment left in our declarations and declare the stable error codes.
const errors = await import(pathToFileURL(path.join(PKG, 'scripts', 'error-codes.mjs')).href);
const codes = errors.errorCodeTable(path.join(PKG, 'src', 'errors.ts'));
const dtsFiles = readdirSync(DIST).filter((f) => f.endsWith('.d.ts'));
// Classes another class extends declare their code as string (a subclass narrows it to its own literal).
const extendedNames = new Set();
for (const f of dtsFiles) for (const m of readFileSync(path.join(DIST, f), 'utf8').matchAll(/declare (?:abstract )?class \w+(?:<[^{]*?>)? extends (\w+)/g)) extendedNames.add(m[1]);
const declared = new Set();
let dtsAdjusted = 0;
for (const f of dtsFiles) {
  const p = path.join(DIST, f);
  const scrubbed = scrub.scrubDeclarations(stripComments(readFileSync(p, 'utf8')));
  dtsAdjusted += scrubbed.applied;
  let text = scrubbed.text;
  text = text.replace(/declare (abstract )?class (\w+)(<[^{]*?>)?( extends [^{]+)? \{\n/g, (m, _a, name) => {
    const c = codes.get(name);
    if (c === undefined) return m;
    declared.add(name);
    const t = extendedNames.has(name) ? 'string' : `'${c.code}'`;
    const fields = [`    readonly errorCode: ${t};`];
    if (!c.numeric) fields.push(`    readonly code: ${t};`);
    return `${m}${fields.join('\n')}\n`;
  });
  writeFileSync(p, text);
}
for (const name of codes.keys()) if (!declared.has(name)) fail(`declarations: error class ${name} not found to declare its code`);
// No comment may remain in the emitted JavaScript (esbuild keeps some in non-minified output; whitespace minification drops them).
for (const f of walkJs(DIST)) {
  const js = readFileSync(f, 'utf8');
  if (/\/\*\*|^\s*\/\/ /m.test(js)) fail(`${path.relative(PKG, f)} still contains a comment`);
}

for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES', 'README.md']) if (!existsSync(path.join(PKG, f))) fail(`${f} is missing`);

const size = (dir) => readdirSync(dir).reduce((a, f) => {
  const p = path.join(dir, f);
  return a + (statSync(p).isDirectory() ? size(p) : statSync(p).size);
}, 0);
console.log(`declarations: ${dtsAdjusted} adjustment(s) applied`);
console.log(`built dist/: ${Object.keys(manifest.files).length} artifact files (${Object.keys(BUILDS).join(', ')}; ${PRESETS.length} presets each), ${Object.keys(kaspa).length} SDK files, ${(size(DIST) / 1e6).toFixed(1)} MB`);

function walkJs(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return p.endsWith(`${path.sep}kaspa`) ? [] : walkJs(p);
    return p.endsWith('.js') ? [p] : [];
  });
}

/** Remove comments from declaration text (string-aware). */
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}
