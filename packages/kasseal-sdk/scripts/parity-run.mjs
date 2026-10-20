#!/usr/bin/env node
// One side of the byte-parity check: `dist` builds with the published Node entry, `repo` with the sources in this
// repository (loaded directly, not bundled). Prints `{ "<network> <scenario>": { txid, txJson } }` as JSON.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scenario } from './parity-scenario.mjs';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const side = process.argv[2];
let B;
if (side === 'dist') {
  B = await import(pathToFileURL(path.resolve(PKG, process.argv[3] ?? 'dist', 'node.js')).href);
} else if (side === 'repo') {
  const at = (p) => import(pathToFileURL(path.resolve(PKG, '..', p)).href);
  const [txb, codec, math] = await Promise.all([at('txbuilder/src/index.node.ts'), at('codec/src/index.ts'), at('curve-math/src/index.ts')]);
  B = { ...math, ...codec, ...txb };
} else {
  console.error('usage: parity-run.mjs dist [distDir] | repo');
  process.exit(2);
}
const result = await scenario(B);
process.stdout.write(JSON.stringify(result));
