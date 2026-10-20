/**
 * The Node artifact source: the artifact files on disk, read on demand.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { ArtifactMissing, type ArtifactSource } from './artifacts.ts';

/** The default artifact root, relative to this module. */
export const PACKAGES_DIR = new URL('../../', import.meta.url);

/** An artifact source reading files under `root`; a path that leaves `root` is refused. */
export function fileArtifactSource(root: URL = PACKAGES_DIR): ArtifactSource {
  const at = (path: string): URL => {
    if (path.split('/').some((s) => s === '..')) throw new Error(`artifact path ${path} leaves the packages directory`);
    return new URL(path, root);
  };
  return {
    readText(path: string): string {
      const url = at(path);
      if (!existsSync(url)) throw new ArtifactMissing(path);
      return readFileSync(url, 'utf8');
    },
    list(dir: string): string[] {
      return readdirSync(at(dir.endsWith('/') ? dir : `${dir}/`)).sort();
    },
  };
}
