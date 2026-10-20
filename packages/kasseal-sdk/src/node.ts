/**
 * Node entry: everything of the package root, plus the pinned Kaspa WASM SDK (Node build) and the bundled contract
 * artifacts. Importing it verifies every bundled artifact against the SHA-256 digests compiled into the package and
 * refuses to load on any mismatch; the Kaspa SDK files are verified the same way before the SDK is first loaded.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ArtifactMissing, installArtifactSource, type ArtifactSource } from '../../txbuilder/src/artifacts.ts';
import { SDK_VERSION, registerSdkLoader, type KaspaSdk } from '../../txbuilder/src/sdk.ts';
import { ArtifactIntegrityError, SdkIntegrityError, artifactManifest, assertArtifactDigest, kaspaSdkDigests, listFromManifest } from './integrity.ts';

export * from './index.ts';

/** Where the bundled contract artifacts are (`dist/artifacts/`). */
export const ARTIFACT_ROOT: URL = new URL('./artifacts/', import.meta.url);
/** Where the bundled Kaspa SDK builds are (`dist/kaspa/`). */
export const KASPA_ROOT: URL = new URL('./kaspa/', import.meta.url);

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function plainPath(path: string): string {
  if (path.split('/').some((s) => s === '..' || s === '' || s === '.')) throw new ArtifactIntegrityError(path, 'is not a plain relative path');
  return path;
}

/**
 * Verify every artifact the manifest lists under `root` (default: the bundled ones) and that the shipped
 * `manifest.json` equals the compiled-in manifest. Returns the verified paths; throws `ArtifactIntegrityError` on the
 * first missing or altered file.
 */
export function verifyArtifacts(root: URL = ARTIFACT_ROOT): string[] {
  const shipped = new URL('manifest.json', root);
  if (!existsSync(shipped)) throw new ArtifactIntegrityError('manifest.json', 'is missing');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(shipped, 'utf8'));
  } catch {
    throw new ArtifactIntegrityError('manifest.json', 'does not parse');
  }
  if (JSON.stringify(parsed) !== JSON.stringify(artifactManifest)) throw new ArtifactIntegrityError('manifest.json', 'differs from the manifest compiled into the package');
  const out: string[] = [];
  for (const path of Object.keys(artifactManifest.files).sort()) {
    const url = new URL(plainPath(path), root);
    if (!existsSync(url)) throw new ArtifactIntegrityError(path, 'is missing');
    assertArtifactDigest(path, sha256(readFileSync(url)));
    out.push(path);
  }
  return out;
}

/**
 * An artifact source over a verified artifact directory: each read is checked again against its pinned digest, and a
 * path the manifest does not list is missing.
 */
export function verifiedArtifactSource(root: URL = ARTIFACT_ROOT): ArtifactSource {
  verifyArtifacts(root);
  const cache = new Map<string, string>();
  return {
    readText(path: string): string {
      const hit = cache.get(path);
      if (hit !== undefined) return hit;
      if (artifactManifest.files[path] === undefined) throw new ArtifactMissing(path);
      const bytes = readFileSync(new URL(plainPath(path), root));
      assertArtifactDigest(path, sha256(bytes));
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      cache.set(path, text);
      return text;
    },
    list(dir: string): string[] {
      return listFromManifest(dir);
    },
  };
}

/** Verify the bundled Node build of the Kaspa SDK (every file against its pinned digest). Returns the verified files. */
export function verifyKaspaSdk(root: URL = KASPA_ROOT): string[] {
  const out: string[] = [];
  for (const [rel, expected] of Object.entries(kaspaSdkDigests).sort(([a], [b]) => a.localeCompare(b))) {
    if (!rel.startsWith('nodejs/')) continue;
    const url = new URL(rel, root);
    if (!existsSync(url)) throw new SdkIntegrityError(rel, 'is missing');
    const actual = sha256(readFileSync(url));
    if (actual !== expected) throw new SdkIntegrityError(rel, `sha256 ${actual} does not match the pinned ${expected}`);
    out.push(rel);
  }
  if (!out.includes('nodejs/kaspa.js') || !out.includes('nodejs/kaspa_bg.wasm')) throw new SdkIntegrityError('nodejs/', 'the pinned digests do not cover kaspa.js and kaspa_bg.wasm');
  return out;
}

let loaded: KaspaSdk | undefined;

/** Verify, then load the bundled Node build of the Kaspa SDK (memoised). */
export function loadKaspaSdk(): KaspaSdk {
  if (loaded !== undefined) return loaded;
  verifyKaspaSdk();
  const entry = fileURLToPath(new URL('nodejs/kaspa.js', KASPA_ROOT));
  const k = createRequire(import.meta.url)(entry) as KaspaSdk & { version?: () => string };
  const v = typeof k.version === 'function' ? k.version() : undefined;
  if (v !== SDK_VERSION) throw new SdkIntegrityError('nodejs/kaspa.js', `reports version ${JSON.stringify(v)}, expected ${SDK_VERSION}`);
  loaded = k;
  return k;
}

registerSdkLoader(loadKaspaSdk);
installArtifactSource(verifiedArtifactSource());
