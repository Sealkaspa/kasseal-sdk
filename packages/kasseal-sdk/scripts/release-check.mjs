#!/usr/bin/env node
// Every release check, in order, on the tarball npm would publish: build, pack, package checks (files, licences,
// manifest, SDK digests, exports, types, size), leak scans (the tarball and the whole repository), byte parity with
// the builder loaded from this repository's sources (using the packed dist), and the package tests. Any failure, or
// any check that cannot run, exits non-zero.
import path from 'node:path';
import { checkPackage } from './check-package.mjs';
import { scanPackage, scanRepo } from './check-leaks.mjs';
import { checkParity } from './check-parity.mjs';
import { CheckFailed, PKG, packAndUnpack, run } from './lib.mjs';

const step = (name) => console.log(`\n== ${name}`);

try {
  step('build');
  process.stdout.write(run(process.execPath, [path.join(PKG, 'scripts', 'build.mjs')], { cwd: PKG }));

  step('pack');
  const { tarball, root, info } = packAndUnpack();
  console.log(`  ${info.filename}: ${info.entryCount} files, ${(info.size / 1e6).toFixed(2)} MB packed, ${(info.unpackedSize / 1e6).toFixed(2)} MB unpacked`);

  step('package');
  for (const line of checkPackage(root, tarball)) console.log(`  ${line}`);

  for (const [name, scan] of [['leak scan (package)', () => scanPackage(root)], ['leak scan (repository)', () => scanRepo()]]) {
    step(name);
    const leaks = scan();
    if (leaks.findings.length > 0) {
      for (const f of leaks.findings.slice(0, 100)) console.error(`  ${f.file}:${f.line} [${f.rule}] ${JSON.stringify(f.hit)} ... ${f.ctx}`);
      throw new CheckFailed(`${name}: ${leaks.findings.length} finding(s)`);
    }
    console.log(`  ${leaks.scanned} text files of ${leaks.files} scanned, no findings (binaries skipped)`);
  }

  step('byte parity (packed dist vs the builder from source)');
  for (const r of checkParity(path.join(root, 'dist'))) console.log(`  ${r}`);

  step('tests');
  const out = run(process.execPath, ['--test', ...['node', 'web'].map((t) => path.join(PKG, 'test', `${t}.test.mjs`))], { cwd: PKG });
  const summary = out.split('\n').filter((l) => /^# (tests|pass|fail)/.test(l));
  for (const l of summary) console.log(`  ${l}`);

  console.log('\nrelease checks: all passed');
} catch (e) {
  console.error(`\nrelease checks FAILED\n${e instanceof CheckFailed ? e.message : e?.stack ?? e}`);
  process.exit(1);
}
