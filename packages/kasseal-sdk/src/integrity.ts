/**
 * Integrity of the bundled files: the contract artifacts and the Kaspa WASM SDK are checked against the SHA-256
 * digests compiled into this package before they are used. Any mismatch, missing or unlisted file is refused.
 */
import { ARTIFACT_MANIFEST, KASPA_SHA256 } from './generated/manifest.ts';

export interface ArtifactBuildInfo {
  readonly network: 'mainnet' | 'testnet-10';
  readonly poolTemplateHash: string;
  readonly treasurySpk: string;
  readonly compiler: string;
  /** Curve template hash per preset (the committed constructor, before a creator is instantiated). */
  readonly presets: Readonly<Record<string, string>>;
}

export interface ArtifactManifest {
  readonly format: 1;
  readonly builds: Readonly<Record<string, ArtifactBuildInfo>>;
  readonly tokenReference: { readonly path: string; readonly templateHash: string; readonly source: string };
  /** Path (relative to the artifact root) -> SHA-256 (hex) of the file's bytes. */
  readonly files: Readonly<Record<string, string>>;
}

/** The manifest compiled into this package. */
export const artifactManifest: ArtifactManifest = ARTIFACT_MANIFEST as ArtifactManifest;

/** SHA-256 of each bundled Kaspa SDK file, relative to the package's `dist/kaspa/` directory. */
export const kaspaSdkDigests: Readonly<Record<string, string>> = KASPA_SHA256;

/** A bundled contract artifact is missing, altered or not listed in the manifest. */
export class ArtifactIntegrityError extends Error {
  readonly path: string;
  readonly expected: string | undefined;
  readonly actual: string | undefined;
  constructor(path: string, detail: string, expected?: string, actual?: string) {
    super(`contract artifact ${path}: ${detail}`);
    this.name = 'ArtifactIntegrityError';
    this.path = path;
    this.expected = expected;
    this.actual = actual;
  }
}

/** A bundled Kaspa SDK file is missing or altered, or the loaded SDK reports another version. */
export class SdkIntegrityError extends Error {
  readonly file: string;
  constructor(file: string, detail: string) {
    super(`Kaspa SDK ${file}: ${detail}`);
    this.name = 'SdkIntegrityError';
    this.file = file;
  }
}

/** The pinned SHA-256 of an artifact path; refuses a path the manifest does not list. */
export function expectedArtifactDigest(path: string): string {
  const d = artifactManifest.files[path];
  if (d === undefined) throw new ArtifactIntegrityError(path, 'not listed in the package manifest');
  return d;
}

/** Throws unless `actual` is the pinned digest of `path`. */
export function assertArtifactDigest(path: string, actual: string): void {
  const expected = expectedArtifactDigest(path);
  if (actual !== expected) throw new ArtifactIntegrityError(path, `sha256 ${actual} does not match the pinned ${expected}`, expected, actual);
}

/** The artifact paths of one build (curve presets, pool) plus the shared token reference. */
export function artifactPathsOfBuild(build: string): string[] {
  if (artifactManifest.builds[build] === undefined) throw new ArtifactIntegrityError(build, 'is not a bundled build');
  const inBuild = (p: string): boolean => p.includes(`/artifacts/${build}/`);
  return Object.keys(artifactManifest.files).filter((p) => inBuild(p) || p === artifactManifest.tokenReference.path).sort();
}

/** The directory listing the builder asks for, answered from the manifest (file names directly inside `dir`). */
export function listFromManifest(dir: string): string[] {
  const prefix = `${dir.replace(/\/+$/, '')}/`;
  const names = new Set<string>();
  for (const p of Object.keys(artifactManifest.files)) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (!rest.includes('/')) names.add(rest);
  }
  return [...names].sort();
}
