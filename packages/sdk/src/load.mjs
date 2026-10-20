// @kasseal/sdk — load the vendored rusty-kaspa WASM SDK only after every
// vendored file has been verified against SHA256SUMS.
//
// Pinned release: rusty-kaspa v2.1.0, asset kaspa-wasm32-sdk-v2.1.0.zip.
// See ../README.md for provenance and ../SHA256SUMS for the digests.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Package root (the directory holding SHA256SUMS and vendor/). */
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Upstream version the vendored build must report. */
export const SDK_VERSION = '2.1.0';
/** Node entry point, relative to the package root. */
export const NODE_ENTRY = 'vendor/nodejs/kaspa/kaspa.js';
/** Files the node build cannot function without; SHA256SUMS must list them. */
export const REQUIRED_NODE_FILES = Object.freeze([
  'vendor/nodejs/kaspa/kaspa.js',
  'vendor/nodejs/kaspa/kaspa_bg.wasm',
]);

/** Thrown when a vendored file is missing, altered, or unlisted. */
export class SdkIntegrityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SdkIntegrityError';
    Object.assign(this, details);
  }
}

/** Parse `<sha256>  <path>` lines (shasum format). Returns Map<path, sha256>. */
export function parseSums(text) {
  const sums = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line);
    if (!m) throw new SdkIntegrityError(`SHA256SUMS: unparseable line: ${JSON.stringify(raw)}`);
    sums.set(m[2].trim(), m[1].toLowerCase());
  }
  return sums;
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Hash every `vendor/` entry listed in SHA256SUMS under `root` and compare.
 * The zip entry is skipped (the archive is not vendored, only its digest is
 * recorded). Throws SdkIntegrityError on the first missing or mismatched file,
 * or if SHA256SUMS does not cover the files the node build needs.
 * Returns the list of verified relative paths.
 */
export function verifyVendor(root = PACKAGE_ROOT) {
  const sumsPath = path.join(root, 'SHA256SUMS');
  if (!existsSync(sumsPath)) throw new SdkIntegrityError(`SHA256SUMS not found at ${sumsPath}`);
  const sums = parseSums(readFileSync(sumsPath, 'utf8'));

  for (const req of REQUIRED_NODE_FILES) {
    if (!sums.has(req)) throw new SdkIntegrityError(`SHA256SUMS does not list required file ${req}`, { file: req });
  }

  const verified = [];
  for (const [rel, expected] of sums) {
    if (!rel.startsWith('vendor/')) continue; // the zip digest is informational
    const abs = path.join(root, rel);
    if (!existsSync(abs)) throw new SdkIntegrityError(`vendored file missing: ${rel}`, { file: rel });
    const actual = sha256File(abs);
    if (actual !== expected) {
      throw new SdkIntegrityError(
        `sha256 mismatch for ${rel}: expected ${expected}, got ${actual}`,
        { file: rel, expected, actual },
      );
    }
    verified.push(rel);
  }
  return verified;
}

const cache = new Map();

/**
 * Verify the vendored files, then require the node build and return the
 * module (the `kaspa` namespace: RpcClient, PrivateKey, createTransactions, ...).
 * Also asserts the module reports SDK_VERSION. Result is memoised per root.
 */
export function loadSdk({ root = PACKAGE_ROOT } = {}) {
  const key = path.resolve(root);
  if (cache.has(key)) return cache.get(key);
  verifyVendor(key);
  const k = createRequire(import.meta.url)(path.join(key, NODE_ENTRY));
  const v = typeof k.version === 'function' ? k.version() : undefined;
  if (v !== SDK_VERSION) {
    throw new SdkIntegrityError(`SDK reports version ${JSON.stringify(v)}, expected ${SDK_VERSION}`);
  }
  cache.set(key, k);
  return k;
}

export default loadSdk;
