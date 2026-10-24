// Encoding of the web curve-preset chunks: one template per build (the artifact and constructor files of a reference
// preset, byte arrays as hex) and, per preset, a patch against it. The format and the decoder are in
// src/web-chunks.ts; build.mjs decodes every chunk it writes and fails unless each text is byte-identical to its file.

import { pathKey, renderJson } from '../src/web-chunks.ts';

/** A non-empty array of integers 0..255. */
const isBytes = (v) => Array.isArray(v) && v.length > 0 && v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255);
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const toHex = (bytes) => Buffer.from(bytes).toString('hex');

/** The compact value of a JSON value: every byte array becomes `{ $hex }`. */
export function compact(v) {
  if (isBytes(v)) return { $hex: toHex(v) };
  if (Array.isArray(v)) return v.map(compact);
  if (isObject(v)) {
    if (Object.hasOwn(v, '$hex')) throw new Error('a source object has a $hex key');
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, compact(x)]));
  }
  return v;
}

/** Paths of the byte arrays of a JSON value, in document order. */
function byteArrayPaths(v, path = [], out = []) {
  if (isBytes(v)) out.push(path);
  else if (Array.isArray(v)) v.forEach((x, i) => byteArrayPaths(x, [...path, i], out));
  else if (isObject(v)) for (const [k, x] of Object.entries(v)) byteArrayPaths(x, [...path, k], out);
  return out;
}

/**
 * How a file's text lays out its parsed JSON: `{ indent, eol, wrap }` for `renderJson` (src/web-chunks.ts), or
 * undefined when no such layout reproduces the text exactly. Each byte array is tried, in document order, as one item
 * per line, on one line, or `n` items per line, keeping the first layout whose text matches the file up to its end.
 */
export function textForm(text) {
  const parsed = JSON.parse(text);
  const paths = byteArrayPaths(parsed);
  for (const indent of [2, 1, 4, 3]) {
    for (const eol of ['\n', '', '\r\n']) {
      const wrap = new Map();
      let ok = true;
      for (const p of paths) {
        const key = pathKey(p);
        let start = 0;
        const fits = (n) => {
          if (n === undefined) wrap.delete(key);
          else wrap.set(key, n);
          const spans = new Map();
          const out = renderJson(parsed, indent, wrap, spans);
          const [s, end] = spans.get(key);
          start = s;
          return out.slice(0, end) === text.slice(0, end);
        };
        // One item per line, one line, or as many per line as the file's first line of the array holds.
        if (fits(undefined) || fits(0)) continue;
        const firstLine = /^\[\n *([^\n]*)\n/.exec(text.slice(start))?.[1] ?? '';
        if (!fits(firstLine.split(', ').length)) { ok = false; break; }
      }
      if (ok && renderJson(parsed, indent, wrap) + eol === text) {
        return { indent, eol, wrap: [...wrap].map(([k, n]) => [JSON.parse(k), n]) };
      }
    }
  }
  return undefined;
}

/** A template document of a file: `{ doc, indent, eol, wrap }`. */
export function templateDocument(text) {
  const form = textForm(text);
  if (form === undefined) throw new Error('no layout reproduces the file exactly');
  return { doc: compact(JSON.parse(text)), ...form };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Patch ops turning compact value `a` (the template's) into `b`. */
export function diff(a, b, path = [], ops = []) {
  if (same(a, b)) return ops;
  const aHex = isObject(a) && typeof a.$hex === 'string' ? a.$hex : undefined;
  const bHex = isObject(b) && typeof b.$hex === 'string' ? b.$hex : undefined;
  if (aHex !== undefined && bHex !== undefined) {
    const x = byteHunks(Buffer.from(aHex, 'hex'), Buffer.from(bHex, 'hex'));
    const edit = { p: path, x };
    const set = { p: path, v: b };
    ops.push(JSON.stringify(edit).length < JSON.stringify(set).length ? edit : set);
    return ops;
  }
  if (isObject(a) && isObject(b) && aHex === undefined && bHex === undefined && same(Object.keys(a), Object.keys(b))) {
    for (const k of Object.keys(a)) diff(a[k], b[k], [...path, k], ops);
    return ops;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    for (let i = 0; i < a.length; i++) diff(a[i], b[i], [...path, i], ops);
    return ops;
  }
  ops.push({ p: path, v: b });
  return ops;
}

/**
 * Byte-edit hunks turning `a` into `b` (Myers' shortest edit script), as the flat list `gap, deleted, insertedHex`.
 * Hunks separated by at most `MERGE_GAP` kept bytes are merged when that is shorter.
 */
export function byteHunks(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  // Backtrack into single-byte edits: deletion of a[i], or insertion of b[j] before a[i].
  const edits = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[off + k - 1] < vd[off + k + 1]) ? k + 1 : k - 1;
    const prevX = vd[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; }
    if (prevK === k + 1) edits.push({ at: prevX, ins: b[prevY] });
    else edits.push({ at: prevX, del: true });
    x = prevX;
    y = prevY;
  }
  edits.reverse();
  // Coalesce into hunks { at, del, ins[] }.
  const hunks = [];
  for (const e of edits) {
    const h = hunks[hunks.length - 1];
    if (h !== undefined && e.at === h.at + h.del) {
      if (e.del) h.del++;
      else h.ins.push(e.ins);
    } else {
      hunks.push({ at: e.at, del: e.del ? 1 : 0, ins: e.del ? [] : [e.ins] });
    }
  }
  // Merge hunks separated by a short run of kept bytes when the merged hunk is shorter.
  const merged = [];
  for (const h of hunks) {
    const last = merged[merged.length - 1];
    const gap = last === undefined ? Infinity : h.at - (last.at + last.del);
    if (gap <= MERGE_GAP) {
      const kept = [...a.subarray(last.at + last.del, h.at)];
      last.ins.push(...kept, ...h.ins);
      last.del += gap + h.del;
    } else {
      merged.push({ at: h.at, del: h.del, ins: [...h.ins] });
    }
  }
  const out = [];
  let pos = 0;
  for (const h of merged) {
    out.push(h.at - pos, h.del, toHex(h.ins));
    pos = h.at + h.del;
  }
  if (!Buffer.from(applyHunksHex(toHex(a), out), 'hex').equals(Buffer.from(b))) throw new Error('byte hunks do not reproduce the target');
  return out;
}

/** Kept-byte runs this short between two hunks are folded into one hunk (2 hex chars per byte vs. a hunk's overhead). */
const MERGE_GAP = 2;

function applyHunksHex(hex, hunks) {
  let out = '';
  let pos = 0;
  for (let i = 0; i < hunks.length; i += 3) {
    out += hex.slice(2 * pos, 2 * (pos + hunks[i])) + hunks[i + 2];
    pos += hunks[i] + hunks[i + 1];
  }
  return out + hex.slice(2 * pos);
}

/**
 * Template and patches of one build's curve presets.
 * @param {Record<string, Record<string, string>>} presets preset -> { kind -> text } (kind: 'artifact' | 'ctor')
 * @param {string} reference the reference preset
 * @returns {{ template: object, patches: Record<string, Record<string, { t: string, ops: object[] }>> }} patches: preset -> kind -> patch
 */
export function encodeCurvePresets(presets, reference) {
  const ref = presets[reference];
  if (ref === undefined) throw new Error(`reference preset ${reference} is missing`);
  const docs = Object.fromEntries(Object.entries(ref).map(([kind, text]) => [kind, templateDocument(text)]));
  const patches = {};
  for (const [preset, files] of Object.entries(presets)) {
    patches[preset] = {};
    for (const [kind, text] of Object.entries(files)) {
      const t = docs[kind];
      if (t === undefined) throw new Error(`${preset}: no template for ${kind}`);
      const form = textForm(text);
      if (form === undefined || JSON.stringify([form.indent, form.eol, form.wrap]) !== JSON.stringify([t.indent, t.eol, t.wrap])) throw new Error(`${preset} ${kind}: layout differs from the template's`);
      patches[preset][kind] = { t: kind, ops: diff(t.doc, compact(JSON.parse(text))) };
    }
  }
  return { template: { curveTemplate: 1, docs }, patches };
}
