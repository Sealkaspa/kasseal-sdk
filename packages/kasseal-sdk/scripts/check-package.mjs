#!/usr/bin/env node
// Package checks on the packed tarball: file allow-list, package.json, licence files, the artifact manifest (hashes
// match, only the two bundled builds, template hashes recomputed), the Kaspa SDK digests, `exports` resolving in
// Node, the declarations typechecking for a consumer, the root entry staying side-effect free, and a size report.
// Usage: check-package.mjs [unpacked package dir] (default: pack now).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CheckFailed, PKG, fail, packAndUnpack, run, tempDir, walk } from './lib.mjs';

const BUILDS = ['v1-kasseal-mainnet-2', 'v1-kasseal-mainnet-2-tn10'];
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

export function checkPackage(root, tarball) {
  const report = [];
  const files = walk(root);

  // Allow-list.
  const allowed = /^(package\.json|README\.md|CHANGELOG\.md|SECURITY\.md|STABILITY\.md|LICENSE|THIRD_PARTY_NOTICES|docs\/[a-z-]+\.md|examples\/(README\.md|[a-z-]+\.ts|lib\/[a-z-]+\.ts)|dist\/.+)$/;
  for (const f of files) {
    if (!allowed.test(f)) fail('files', `${f} is not in the allow-list`);
    if (/\.(sil|map|tsbuildinfo)$/.test(f) || (/\.ts$/.test(f) && !/\.d\.ts$/.test(f) && !f.startsWith('examples/'))) fail('files', `${f} must not ship`);
    if (/(^|\/)(test|tests|__tests__|scripts|src)\//.test(f)) fail('files', `${f} must not ship`);
    if (/INTERNAL/i.test(f)) fail('files', `${f} is internal and must not ship`);
  }
  for (const need of ['README.md', 'CHANGELOG.md', 'SECURITY.md', 'STABILITY.md', 'docs/errors.md', 'docs/launch-proof.md', 'examples/README.md']) {
    if (!files.includes(need)) fail('files', `${need} is missing`);
  }
  // Every relative link of a shipped Markdown file resolves to a shipped file.
  for (const f of files.filter((x) => x.endsWith('.md'))) {
    const text = readFileSync(path.join(root, f), 'utf8');
    for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue;
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(f), target)).replace(/\/$/, '');
      if (!files.includes(rel) && !files.some((x) => x.startsWith(`${rel}/`))) fail('files', `${f} links to ${target}, which does not ship`);
    }
  }
  report.push(`files: ${files.length}, all in the allow-list; internal notes excluded; every relative Markdown link resolves`);

  // package.json.
  const pj = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pj.name !== '@kassealhq/sdk' || pj.license !== 'MIT' || pj.type !== 'module' || pj.private) fail('package.json', 'name, licence, type or private flag wrong');
  for (const k of ['dependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies']) {
    if (pj[k] !== undefined && Object.keys(pj[k]).length > 0) fail('package.json', `${k} must be empty (the package is self-contained)`);
  }
  if (JSON.stringify(Object.keys(pj.exports).sort()) !== JSON.stringify(['.', './node', './package.json', './web'])) fail('package.json', `exports ${Object.keys(pj.exports)}`);
  if (JSON.stringify(pj).includes('workspace:')) fail('package.json', 'a workspace reference remains');
  report.push(`package.json: ${pj.name}@${pj.version}, ${pj.license}, no runtime dependencies`);

  // Licences.
  const lic = readFileSync(path.join(root, 'LICENSE'), 'utf8');
  if (!lic.startsWith('MIT License') || !lic.includes('Copyright (c) 2026 Kasseal')) fail('licence', 'LICENSE is not the MIT licence of Kasseal');
  const notices = readFileSync(path.join(root, 'THIRD_PARTY_NOTICES'), 'utf8');
  for (const need of ['rusty-kaspa', 'kcc20-reference', 'ISC License', 'Copyright (c) 2022-2024 Kaspa developers']) {
    if (!notices.includes(need)) fail('licence', `THIRD_PARTY_NOTICES does not mention ${need}`);
  }
  for (const f of ['dist/kaspa/nodejs/LICENSE', 'dist/kaspa/web/LICENSE']) {
    if (!readFileSync(path.join(root, f), 'utf8').startsWith('ISC License')) fail('licence', `${f} is not the upstream ISC licence`);
  }
  report.push('licences: LICENSE (MIT), THIRD_PARTY_NOTICES, both upstream ISC licences present');

  // Artifact manifest.
  const art = path.join(root, 'dist', 'artifacts');
  const manifest = JSON.parse(readFileSync(path.join(art, 'manifest.json'), 'utf8'));
  if (JSON.stringify(Object.keys(manifest.builds).sort()) !== JSON.stringify(BUILDS)) fail('manifest', `builds ${Object.keys(manifest.builds)}`);
  const listed = new Set(Object.keys(manifest.files));
  for (const [p, d] of Object.entries(manifest.files)) {
    const f = path.join(art, p);
    if (!existsSync(f)) fail('manifest', `${p} is missing`);
    if (sha256(readFileSync(f)) !== d) fail('manifest', `${p} does not match its digest`);
  }
  for (const f of walk(art)) {
    if (f === 'manifest.json') continue;
    if (!listed.has(f)) fail('manifest', `${f} is shipped but not listed`);
    const m = /\/artifacts\/([^/]+)\//.exec(f);
    if (m && !BUILDS.includes(m[1])) fail('manifest', `${f} belongs to another build`);
    if (!/\.json$/.test(f)) fail('manifest', `${f} is not a compiled artifact`);
  }
  // Every web artifact chunk is one of the two builds.
  for (const f of files.filter((x) => x.startsWith('dist/chunks/v'))) {
    if (!BUILDS.some((b) => path.basename(f).startsWith(`${b}--`))) fail('manifest', `${f} is a chunk of another build`);
  }
  // Template hashes recomputed by the packed builder equal the manifest's, and the load-time verification passes.
  const deep = run(process.execPath, ['--input-type=module', '-e', `
    const m = await import(${JSON.stringify(pathToFileURL(path.join(root, 'dist', 'node.js')).href)});
    const verified = m.verifyArtifacts();
    let n = 0;
    for (const [build, info] of Object.entries(m.artifactManifest.builds)) {
      for (const [preset, h] of Object.entries(info.presets)) {
        const ctx = m.createContext(preset, info.network, 'v1', build);
        if (ctx.curve.templateHash !== h) throw new Error(build + ' ' + preset + ': template hash differs');
        if (ctx.pool.templateHash !== info.poolTemplateHash) throw new Error(build + ': pool template hash differs');
        n++;
      }
    }
    if (m.loadTokenTemplate().templateHash !== m.artifactManifest.tokenReference.templateHash) throw new Error('token template differs');
    console.log(JSON.stringify({ verified: verified.length, contexts: n }));
  `]);
  const d = JSON.parse(deep);
  report.push(`manifest: ${BUILDS.join(' + ')} only, ${d.verified} files verified at load, ${d.contexts} curve templates and both pools recomputed to the manifest's hashes`);

  // Kaspa SDK files: the compiled-in digests and the vendored SHA256SUMS agree with the shipped bytes.
  const sums = new Map();
  for (const line of readFileSync(path.join(PKG, '..', 'sdk', 'SHA256SUMS'), 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?vendor\/(nodejs|web)\/kaspa\/(.+)$/.exec(line.trim());
    if (m) sums.set(`${m[2]}/${m[3]}`, m[1]);
  }
  const digests = JSON.parse(run(process.execPath, ['--input-type=module', '-e', `
    const m = await import(${JSON.stringify(pathToFileURL(path.join(root, 'dist', 'index.js')).href)});
    console.log(JSON.stringify(m.kaspaSdkDigests));
  `]));
  const kaspaFiles = walk(path.join(root, 'dist', 'kaspa')).filter((f) => f !== 'sdk-types.d.ts');
  if (kaspaFiles.length !== sums.size) fail('kaspa', `${kaspaFiles.length} files shipped, ${sums.size} pinned`);
  for (const f of kaspaFiles) {
    const actual = sha256(readFileSync(path.join(root, 'dist', 'kaspa', f)));
    if (actual !== sums.get(f) || actual !== digests[f]) fail('kaspa', `${f} does not match its pinned digest`);
  }
  report.push(`kaspa SDK: ${kaspaFiles.length} files match SHA256SUMS and the compiled-in digests`);

  // exports resolve in Node, from a consumer project; deep paths stay closed; the root entry has no side effects.
  const consumer = tempDir('consumer');
  mkdirSync(path.join(consumer, 'node_modules', '@kassealhq'), { recursive: true });
  symlinkSync(root, path.join(consumer, 'node_modules', '@kassealhq', 'sdk'), 'dir');
  writeFileSync(path.join(consumer, 'package.json'), '{ "type": "module", "private": true }\n');
  writeFileSync(path.join(consumer, 'resolve.mjs'), `
    const root = await import('@kassealhq/sdk');
    if (root.sdkAvailable()) throw new Error('the root entry installed an SDK');
    let refused = '';
    try { root.createContext('standard', 'mainnet'); } catch (e) { refused = e.code; }
    if (refused !== 'ARTIFACT_SOURCE_NOT_INSTALLED') throw new Error('the root entry installed artifacts: ' + refused);
    const node = await import('@kassealhq/sdk/node');
    const web = await import('@kassealhq/sdk/web');
    const pj = (await import('@kassealhq/sdk/package.json', { with: { type: 'json' } })).default;
    if (typeof node.createTxBuilder !== 'function' || typeof web.initWeb !== 'function' || pj.name !== '@kassealhq/sdk') throw new Error('exports incomplete');
    if (node.ProofNotBound !== root.ProofNotBound || web.ProofNotBound !== root.ProofNotBound) throw new Error('entries do not share classes');
    let closed = false;
    try { await import('@kassealhq/sdk/dist/node.js'); } catch (e) { closed = e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'; }
    if (!closed) throw new Error('a deep path resolved');
    console.log(JSON.stringify({ root: Object.keys(root).length, node: Object.keys(node).length, web: Object.keys(web).length }));
  `);
  const counts = JSON.parse(run(process.execPath, ['resolve.mjs'], { cwd: consumer }));
  report.push(`exports: '.', './node', './web', './package.json' resolve; deep paths refused; root entry side-effect free (${counts.root} root exports)`);

  // Declarations: a consumer typechecks against the shipped types with NodeNext resolution.
  writeFileSync(path.join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noImplicitAny: false, noEmit: true, skipLibCheck: false, lib: ['ES2023', 'DOM'], types: [] },
    files: ['consumer.ts'],
  }));
  writeFileSync(path.join(consumer, 'consumer.ts'), `
    import { createTxBuilder, verifyArtifacts, type BuiltTx, type UtxoSources } from '@kassealhq/sdk/node';
    import { initWeb, type InitWebOptions } from '@kassealhq/sdk/web';
    import { errorCode, ProofNotBound, swapKasForTokens, maxWithSlippage, type KassealNetwork } from '@kassealhq/sdk';
    const network: KassealNetwork = 'testnet-10';
    declare const sources: UtxoSources;
    const b = createTxBuilder({ networkId: network, sources });
    const p: Promise<BuiltTx> = b.buildSweep({ covenantId: '00', venue: 'pool', funder: 'x' });
    const code: 'PROOF_NOT_BOUND' = (null as unknown as ProofNotBound).code;
    const o: InitWebOptions = { network };
    void [p, code, o, initWeb, verifyArtifacts, errorCode, swapKasForTokens, maxWithSlippage];
  `);
  const tsc = path.join(PKG, 'node_modules', 'typescript', 'bin', 'tsc');
  try {
    run(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: consumer });
    report.push('types: a NodeNext consumer typechecks against the shipped declarations (skipLibCheck off; noImplicitAny off for the upstream Kaspa declarations)');
  } catch (e) {
    fail('types', e.message);
  }

  // The shipped examples typecheck against the packed package (Node types for `process` and `Buffer`).
  writeFileSync(path.join(consumer, 'tsconfig.examples.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noImplicitAny: false, noEmit: true, skipLibCheck: false,
      allowImportingTsExtensions: true, lib: ['ES2023', 'DOM'], types: ['node'], typeRoots: [path.join(PKG, 'node_modules', '@types')],
    },
    include: [path.join(root, 'examples', '**', '*.ts')],
  }));
  try {
    run(process.execPath, [tsc, '-p', 'tsconfig.examples.json'], { cwd: consumer });
    report.push(`examples: ${files.filter((f) => f.startsWith('examples/') && f.endsWith('.ts')).length} shipped example files typecheck against the packed package`);
  } catch (e) {
    fail('examples', e.message);
  }

  // Size report.
  const sizeOf = (prefix) => files.filter((f) => f.startsWith(prefix)).reduce((a, f) => a + statSync(path.join(root, f)).size, 0);
  const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;
  const total = sizeOf('');
  const js = files.filter((f) => f.endsWith('.js') && !f.startsWith('dist/kaspa/') && !f.startsWith('dist/chunks/v')).reduce((a, f) => a + statSync(path.join(root, f)).size, 0);
  const dts = files.filter((f) => f.endsWith('.d.ts') && !f.startsWith('dist/kaspa/')).reduce((a, f) => a + statSync(path.join(root, f)).size, 0);
  report.push(`size: tarball ${tarball ? mb(statSync(tarball).size) : 'n/a'}, unpacked ${mb(total)} = Kaspa SDK ${mb(sizeOf('dist/kaspa/'))} + artifacts (Node) ${mb(sizeOf('dist/artifacts/'))} + artifact chunks (web) ${mb(sizeOf('dist/chunks/v'))} + code ${mb(js)} + declarations ${mb(dts)}`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const packed = process.argv[2] ? { root: process.argv[2], tarball: undefined } : packAndUnpack();
    for (const line of checkPackage(packed.root, packed.tarball)) console.log(`  ${line}`);
    console.log('package: ok');
  } catch (e) {
    console.error(e instanceof CheckFailed ? e.message : e);
    process.exit(1);
  }
}
