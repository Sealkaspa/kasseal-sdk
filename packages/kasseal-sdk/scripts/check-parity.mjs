#!/usr/bin/env node
// Byte parity: the published Node entry and the in-repository builder build the same transactions (txid and txJson)
// from the same fixed, fake inputs. Fails closed: any error on either side, a missing scenario or any difference fails.
// Usage: check-parity.mjs [dist dir] (default: this package's dist/).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CheckFailed, PKG, fail, run } from './lib.mjs';
import { PARITY_NETWORKS, SCENARIOS } from './parity-scenario.mjs';

export function checkParity(distDir = path.join(PKG, 'dist')) {
  const runner = path.join(PKG, 'scripts', 'parity-run.mjs');
  const side = (args) => {
    let out;
    try {
      out = run(process.execPath, [runner, ...args], { cwd: PKG });
    } catch (e) {
      fail('parity', `the ${args[0]} side did not run: ${e.message}`);
    }
    try {
      return JSON.parse(out);
    } catch {
      fail('parity', `the ${args[0]} side printed no result`);
    }
    return undefined;
  };
  const dist = side(['dist', path.resolve(distDir)]);
  const repo = side(['repo']);
  const expected = PARITY_NETWORKS.flatMap(([, build]) => SCENARIOS.map((s) => `${build} ${s}`)).sort();
  for (const [name, r] of [['dist', dist], ['repo', repo]]) {
    const keys = Object.keys(r).sort();
    if (JSON.stringify(keys) !== JSON.stringify(expected)) fail('parity', `${name} built ${keys.join(', ')}; expected ${expected.join(', ')}`);
  }
  const rows = [];
  for (const k of expected) {
    const a = dist[k];
    const b = repo[k];
    if (typeof a.txid !== 'string' || !/^[0-9a-f]{64}$/.test(a.txid) || typeof a.txJson !== 'string' || a.txJson.length < 100) fail('parity', `${k}: no transaction`);
    if (a.txid !== b.txid) fail('parity', `${k}: txid ${a.txid} (dist) != ${b.txid} (repo)`);
    if (a.txJson !== b.txJson) fail('parity', `${k}: txJson differs (dist ${a.txJson.length} chars, repo ${b.txJson.length})`);
    rows.push(`${k.padEnd(46)} ${a.txid}`);
  }
  return rows;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const rows = checkParity(process.argv[2]);
    for (const r of rows) console.log(`  ${r}`);
    console.log(`parity: ok (${rows.length} transactions identical)`);
  } catch (e) {
    console.error(e instanceof CheckFailed ? e.message : e);
    process.exit(1);
  }
}
