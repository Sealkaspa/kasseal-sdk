// The error-code table of src/errors.ts, read from its source: class name -> { code, numeric }.
import { readFileSync } from 'node:fs';

export function errorCodeTable(file) {
  const src = readFileSync(file, 'utf8');
  const table = /const TABLE[^=]*=\s*\[([\s\S]*?)\n\];/.exec(src);
  const numeric = /const NUMERIC_CODE[^=]*=\s*\[([^\]]*)\]/.exec(src);
  if (!table || !numeric) throw new Error(`${file}: error table not found`);
  const numericNames = new Set(numeric[1].split(',').map((s) => s.trim()).filter(Boolean));
  const out = new Map();
  for (const m of table[1].matchAll(/\[(\w+), '([A-Z0-9_]+)'\]/g)) out.set(m[1], { code: m[2], numeric: numericNames.has(m[1]) });
  if (out.size < 10) throw new Error(`${file}: error table too small (${out.size})`);
  return out;
}
