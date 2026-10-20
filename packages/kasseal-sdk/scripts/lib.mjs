// Shared helpers of the release checks.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG = fileURLToPath(new URL('..', import.meta.url));

export class CheckFailed extends Error {}

export function fail(check, msg) {
  throw new CheckFailed(`${check}: ${msg}`);
}

/** Run a command; throws with its output unless it exits 0. Returns stdout. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.error) throw new CheckFailed(`${cmd} ${args.join(' ')}: ${r.error.message}`);
  if (r.status !== 0) throw new CheckFailed(`${cmd} ${args.join(' ')} exited ${r.status}\n${r.stdout ?? ''}${r.stderr ?? ''}`);
  return r.stdout;
}

export function tempDir(label) {
  return mkdtempSync(path.join(tmpdir(), `kassealhq-sdk-${label}-`));
}

/**
 * Pack the package as npm would publish it and unpack the tarball. Returns the tarball path and the unpacked
 * package directory (`<dir>/package`).
 */
export function packAndUnpack() {
  const dir = tempDir('pack');
  const out = run('npm', ['pack', '--json', '--pack-destination', dir], { cwd: PKG });
  const info = JSON.parse(out)[0];
  const tarball = path.join(dir, info.filename);
  run('tar', ['-xzf', tarball, '-C', dir]);
  return { tarball, root: path.join(dir, 'package'), info };
}

/** Every file under `root`, relative, with `/`. */
export function walk(root, rel = '') {
  const out = [];
  for (const name of readdirSync(path.join(root, rel)).sort()) {
    const r = rel === '' ? name : `${rel}/${name}`;
    if (statSync(path.join(root, r)).isDirectory()) out.push(...walk(root, r));
    else out.push(r);
  }
  return out;
}
