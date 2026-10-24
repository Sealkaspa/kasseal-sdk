/**
 * Decoding of the web curve-preset chunks. The curve presets of a build differ only in a few constants, so the web
 * build stores one template per build (the full artifact and constructor files of a reference preset) and, per preset,
 * a patch against it. Decoding rebuilds the exact file texts; the caller then checks each text against the pinned
 * SHA-256 of the manifest, exactly as for a file stored whole. Nothing here is trusted: a wrong template or patch
 * yields a text whose digest does not match, or an error.
 *
 * Encoding (produced by scripts/web-chunks.mjs at build time):
 * - A compact value is JSON in which every non-empty array of integers 0..255 is written `{ "$hex": "<hex>" }`.
 * - A template document is `{ doc, indent, eol, wrap }`. Its text is `renderJson(expand(doc), indent, wrap) + eol`:
 *   the layout of `JSON.stringify(value, null, indent)`, except for the arrays `wrap` lists as `[path, n]`, which are
 *   written on one line (`n` = 0) or `n` items per line.
 * - A file patch is `{ t, ops }`: `t` names the template document, each op is applied to its compact value in order.
 *   `{ p, v }` replaces the value at path `p` with `v`. `{ p, x }` edits the bytes at `p` (a `$hex` value): `x` is a
 *   flat list of hunks `gap, deleted, insertedHex`, where `gap` counts the bytes kept since the previous hunk.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface TemplateDocument {
  readonly doc: Json;
  readonly indent: number;
  readonly eol: string;
  readonly wrap: readonly (readonly [readonly (string | number)[], number])[];
}

export type PatchOp = { readonly p: readonly (string | number)[]; readonly v: Json } | { readonly p: readonly (string | number)[]; readonly x: readonly (number | string)[] };

export interface FilePatch {
  readonly t: string;
  readonly ops: readonly PatchOp[];
}

/** The template of a build's curve presets. */
export interface CurveTemplateChunk {
  readonly curveTemplate: 1;
  readonly docs: Readonly<Record<string, TemplateDocument>>;
}

/** One curve preset of a build, as patches against the build's template: artifact path -> patch. */
export interface CurvePatchChunk {
  readonly curvePatch: 1;
  readonly files: Readonly<Record<string, FilePatch>>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function isCurvePatchChunk(v: unknown): v is CurvePatchChunk {
  return isObject(v) && v.curvePatch === 1 && isObject(v.files);
}

export function isCurveTemplateChunk(v: unknown): v is CurveTemplateChunk {
  return isObject(v) && v.curveTemplate === 1 && isObject(v.docs);
}

/** A path's key in a `wrap` map. */
export const pathKey = (path: readonly (string | number)[]): string => JSON.stringify(path);

/**
 * `value` laid out as `JSON.stringify(value, null, indent)` (indent >= 1), except the arrays at the paths of `wrap`:
 * `n` = 0 writes the array on one line, `n` > 0 writes `n` items per line. `spans`, when given, receives the text span
 * of every array.
 */
export function renderJson(value: unknown, indent: number, wrap: ReadonlyMap<string, number>, spans?: Map<string, readonly [number, number]>): string {
  if (!Number.isInteger(indent) || indent < 1) throw new Error('unsupported indent');
  let out = '';
  const pad = (depth: number): string => ' '.repeat(indent * depth);
  const rec = (v: unknown, depth: number, path: (string | number)[]): void => {
    if (Array.isArray(v)) {
      const start = out.length;
      const key = pathKey(path);
      const n = wrap.get(key);
      if (v.length === 0) {
        out += '[]';
      } else if (n === 0) {
        out += '[';
        v.forEach((x, i) => { if (i > 0) out += ', '; rec(x, depth + 1, [...path, i]); });
        out += ']';
      } else {
        out += '[\n';
        v.forEach((x, i) => {
          if (i > 0) out += n === undefined || i % n === 0 ? `,\n${pad(depth + 1)}` : ', ';
          else out += pad(depth + 1);
          rec(x, depth + 1, [...path, i]);
        });
        out += `\n${pad(depth)}]`;
      }
      spans?.set(key, [start, out.length]);
    } else if (typeof v === 'object' && v !== null) {
      const keys = Object.keys(v);
      if (keys.length === 0) {
        out += '{}';
        return;
      }
      out += '{\n';
      keys.forEach((k, i) => {
        if (i > 0) out += ',\n';
        out += `${pad(depth + 1)}${JSON.stringify(k)}: `;
        rec((v as Record<string, unknown>)[k], depth + 1, [...path, k]);
      });
      out += `\n${pad(depth)}}`;
    } else {
      const t = JSON.stringify(v);
      if (t === undefined) throw new Error('not a JSON value');
      out += t;
    }
  };
  rec(value, 0, []);
  return out;
}

const HEX = /^(?:[0-9a-f]{2})*$/;

function bytesOfHex(hex: string): number[] {
  if (!HEX.test(hex)) throw new Error('malformed hex');
  const out = new Array<number>(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** The plain JSON value of a compact value (`$hex` objects back to byte arrays). */
export function expandCompact(v: Json): Json {
  if (Array.isArray(v)) return v.map(expandCompact);
  if (isObject(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === '$hex') {
      const hex = v.$hex;
      if (typeof hex !== 'string' || hex.length === 0) throw new Error('malformed $hex value');
      return bytesOfHex(hex);
    }
    const out: { [key: string]: Json } = {};
    for (const k of keys) out[k] = expandCompact(v[k] as Json);
    return out;
  }
  return v;
}

/** Apply byte-edit hunks to a hex string. */
export function applyHunks(hex: string, hunks: readonly (number | string)[]): string {
  if (!HEX.test(hex) || !Array.isArray(hunks) || hunks.length % 3 !== 0) throw new Error('malformed byte edit');
  const length = hex.length / 2;
  let out = '';
  let pos = 0;
  for (let i = 0; i < hunks.length; i += 3) {
    const gap = hunks[i];
    const del = hunks[i + 1];
    const ins = hunks[i + 2];
    if (!Number.isSafeInteger(gap) || !Number.isSafeInteger(del) || typeof ins !== 'string' || !HEX.test(ins)) throw new Error('malformed byte edit');
    const g = gap as number;
    const d = del as number;
    if (g < 0 || d < 0 || pos + g + d > length) throw new Error('byte edit out of range');
    out += hex.slice(2 * pos, 2 * (pos + g)) + ins;
    pos += g + d;
  }
  return out + hex.slice(2 * pos);
}

function clone(v: Json): Json {
  return JSON.parse(JSON.stringify(v)) as Json;
}

function applyOp(root: Json, op: PatchOp): Json {
  if (!isObject(op) || !Array.isArray(op.p)) throw new Error('malformed patch op');
  const path = op.p;
  const replace = (current: Json): Json => {
    if ('v' in op) return clone(op.v);
    if (!isObject(current) || typeof current.$hex !== 'string' || Object.keys(current).length !== 1) throw new Error('byte edit on a value that is not bytes');
    const hex = applyHunks(current.$hex, op.x);
    if (hex.length === 0) throw new Error('byte edit leaves no bytes');
    return { $hex: hex };
  };
  if (path.length === 0) return replace(root);
  let parent: Json = root;
  for (let i = 0; i < path.length - 1; i++) parent = child(parent, path[i]!);
  const last = path[path.length - 1]!;
  const current = child(parent, last);
  const next = replace(current);
  if (Array.isArray(parent)) parent[last as number] = next;
  else (parent as Record<string, Json>)[last as string] = next;
  return root;
}

function child(v: Json, key: string | number): Json {
  if (Array.isArray(v) && typeof key === 'number' && Number.isInteger(key) && key >= 0 && key < v.length) return v[key]!;
  if (isObject(v) && typeof key === 'string' && Object.hasOwn(v, key)) return v[key] as Json;
  throw new Error('patch path not in the template');
}

/** The text of a template document after applying a file patch. */
export function decodeFile(template: CurveTemplateChunk, patch: FilePatch): string {
  const t = isObject(patch) && typeof patch.t === 'string' && Object.hasOwn(template.docs, patch.t) ? template.docs[patch.t] : undefined;
  if (t === undefined || !Array.isArray(patch.ops)) throw new Error('malformed file patch');
  if (!Number.isInteger(t.indent) || t.indent < 1 || t.indent > 10 || typeof t.eol !== 'string' || !Array.isArray(t.wrap)) throw new Error('malformed template document');
  const wrap = new Map<string, number>();
  for (const entry of t.wrap) {
    if (!Array.isArray(entry) || !Array.isArray(entry[0]) || !Number.isInteger(entry[1]) || entry[1] < 0) throw new Error('malformed template layout');
    wrap.set(pathKey(entry[0]), entry[1]);
  }
  let doc = clone(t.doc);
  for (const op of patch.ops) doc = applyOp(doc, op);
  return renderJson(expandCompact(doc), t.indent, wrap) + t.eol;
}

/** Every file of a preset chunk, as text: artifact path -> text. */
export function decodeCurvePatchChunk(template: CurveTemplateChunk, chunk: CurvePatchChunk): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, patch] of Object.entries(chunk.files)) out[path] = decodeFile(template, patch);
  return out;
}
