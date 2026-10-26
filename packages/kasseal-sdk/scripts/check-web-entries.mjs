#!/usr/bin/env node
// Web entry import graphs: every file a bundler or extension packager reaches from each browser entry (static
// imports, re-exports and dynamic `import()` alike). A per-network entry must reach the artifact chunks of its own
// contract build only, and every chunk of that build; `web.js` reaches both builds. Prints the bytes reachable from
// each entry. Usage: check-web-entries.mjs [dist dir] (default: this package's dist/).
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CheckFailed, PKG, fail } from './lib.mjs';

/** Browser entry file -> the builds whose artifact chunks it may reach (null: every bundled build). */
export const WEB_ENTRIES = Object.freeze({
  'web.js': null,
  'web-mainnet.js': ['v1-kasseal-mainnet-2', 'v1-kasseal-mainnet-3'],
  'web-testnet-10.js': ['v1-kasseal-mainnet-2-tn10', 'v1-kasseal-mainnet-3-tn10'],
  'web-lite-mainnet.js': ['v1-kasseal-mainnet-2', 'v1-kasseal-mainnet-3'],
  'web-lite-testnet-10.js': ['v1-kasseal-mainnet-2-tn10', 'v1-kasseal-mainnet-3-tn10'],
});
/** Entries that bundle no Kaspa SDK: they must reach neither `kaspa.js` nor reference `kaspa_bg.wasm` as a file. */
export const LITE_ENTRIES = Object.freeze(['web-lite-mainnet.js', 'web-lite-testnet-10.js']);
const BUILDS = ['v1-kasseal-mainnet-2', 'v1-kasseal-mainnet-2-tn10', 'v1-kasseal-mainnet-3', 'v1-kasseal-mainnet-3-tn10'];
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(["'])(\.{1,2}\/[^"']+)\1/g;

/** The files reachable from `entry` (relative to `dist`), with their sizes. */
export function reachable(dist, entry) {
  const seen = new Map();
  const stack = [entry];
  while (stack.length > 0) {
    const rel = stack.pop();
    if (seen.has(rel)) continue;
    const abs = path.join(dist, rel);
    if (!existsSync(abs)) fail('web entries', `${entry} reaches ${rel}, which does not exist`);
    seen.set(rel, statSync(abs).size);
    if (!rel.endsWith('.js')) continue;
    for (const [, , spec] of readFileSync(abs, 'utf8').matchAll(IMPORT)) {
      stack.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)));
    }
  }
  return seen;
}

/** The artifact chunk's build, or undefined for a code chunk. */
function chunkBuild(rel) {
  const m = /^chunks\/(.+?)--[^/]+$/.exec(rel);
  if (m === null) return undefined;
  if (!BUILDS.includes(m[1])) fail('web entries', `${rel} is a chunk of an unknown build`);
  return m[1];
}

export function checkWebEntries(dist = path.join(PKG, 'dist')) {
  const manifest = JSON.parse(readFileSync(path.join(dist, 'artifacts', 'manifest.json'), 'utf8'));
  const chunksPerBuild = Object.fromEntries(BUILDS.map((b) => [b, Object.keys(manifest.builds[b].presets).length + 2])); // base, curve template, one per preset
  const report = [];
  const results = {};
  for (const [entry, allowed] of Object.entries(WEB_ENTRIES)) {
    const files = reachable(dist, entry);
    const perBuild = Object.fromEntries(BUILDS.map((b) => [b, { chunks: 0, bytes: 0 }]));
    let code = 0;
    for (const [rel, size] of files) {
      const b = chunkBuild(rel);
      if (b === undefined) code += size;
      else { perBuild[b].chunks++; perBuild[b].bytes += size; }
    }
    for (const b of BUILDS) {
      const want = allowed === null || allowed.includes(b);
      if (!want && perBuild[b].chunks > 0) fail('web entries', `${entry} reaches ${perBuild[b].chunks} chunk(s) of ${b}`);
      if (want && perBuild[b].chunks !== chunksPerBuild[b]) fail('web entries', `${entry} reaches ${perBuild[b].chunks} of the ${chunksPerBuild[b]} chunks of ${b}`);
    }
    if (LITE_ENTRIES.includes(entry)) {
      if ([...files.keys()].some((f) => f.startsWith('kaspa/'))) fail('web entries', `${entry} reaches the bundled Kaspa SDK`);
      // A bundler emits an asset for `new URL('…', import.meta.url)`; the digest table only names the file.
      for (const f of files.keys()) if (f.endsWith('.js') && /new URL\([^)]*kaspa_bg\.wasm[^)]*import\.meta\.url/.test(readFileSync(path.join(dist, f), 'utf8'))) fail('web entries', `${f} (reached from ${entry}) references kaspa_bg.wasm`);
    } else if (!files.has('kaspa/web/kaspa.js')) fail('web entries', `${entry} does not reach the Kaspa web SDK`);
    const total = [...files.values()].reduce((a, n) => a + n, 0);
    results[entry] = { files: files.size, total, code, perBuild };
    const builds = BUILDS.filter((b) => perBuild[b].chunks > 0).map((b) => `${b} ${perBuild[b].chunks} chunks ${perBuild[b].bytes} B`).join(', ');
    report.push(`${entry}: ${files.size} files, ${total} B reachable (code incl. kaspa.js ${code} B; ${builds})`);
  }
  return { report, results };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { report } = checkWebEntries(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
    for (const line of report) console.log(`  ${line}`);
    console.log('web entries: ok');
  } catch (e) {
    console.error(e instanceof CheckFailed ? e.message : e);
    process.exit(1);
  }
}
