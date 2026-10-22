#!/usr/bin/env node
// Leak scan for internal references (audit and decision IDs, owner notes, internal paths and layout, infrastructure
// addresses, hostnames and env names, key material, local paths, wording that must not ship), run over two sets:
//   - the packed package: every text file of the tarball npm would publish;
//   - the repository: every file of this repository (sources, tests, scripts, docs, workflow, data), except
//     dependencies, build output and this scanner itself (its rule table and planted self-test strings).
// Usage: check-leaks.mjs [unpacked package dir] (default: pack now) | check-leaks.mjs --repo
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { CheckFailed, PKG, fail, packAndUnpack, walk } from './lib.mjs';

const require = createRequire(import.meta.url);

const BINARY = /\.(wasm|png|jpg|gif|ico|woff2?|tgz)$/;

/**
 * Words that must never ship but cannot be listed here without publishing them (names, private project names, wording
 * of unreleased features): read from the JSON file named by LEAK_RULES_FILE (default: private-leak-rules.json beside this script), an array of [name, source, flags]. The
 * file is kept outside this repository; the publisher runs the scan with it before every release. Without it only the
 * rules below apply. An optional fourth field `prose` limits a rule to prose, as COMMENT_RULES.
 */
const PRIVATE = (() => {
  // Default: private-leak-rules.json beside this script, present only in the publisher's copy (ignored by git here).
  const local = path.join(path.dirname(new URL(import.meta.url).pathname), 'private-leak-rules.json');
  const file = process.env.LEAK_RULES_FILE ?? (existsSync(local) ? local : undefined);
  if (!file) return [];
  return JSON.parse(readFileSync(file, 'utf8')).map(([name, source, flags, scope]) => ({ rule: [name, new RegExp(source, flags)], prose: scope === 'prose' }));
})();
/** Private rules for all text, and those (scope `prose`) that apply only to prose like COMMENT_RULES. */
const PRIVATE_RULES = PRIVATE.filter((r) => !r.prose).map((r) => r.rule);
const PRIVATE_PROSE_RULES = PRIVATE.filter((r) => r.prose).map((r) => r.rule);

/** [name, pattern] pairs that apply to all text; every match fails the check unless an allowance below covers it. */
export const RULES = [
  ...PRIVATE_RULES,
  ['audit or decision id', /\b[A-Z]{1,4}[0-9]?-[0-9]{1,3}[a-z]?\b|\b[A-Z]{2}-[A-Z][0-9]{1,2}\b/g],
  ['owner note', /owner (decision|20[0-9]{2})|owner 20/gi],
  ['internal doc path', /docs\/(audit|plan)|\baudit\/|research\//g],
  ['private repo path', /\b(services|tooling|apps)\/[a-z]/g],
  ['contract source', /\b[\w-]*\.sil\b/g],
  ['IPv4 address', /\b(?:\d{1,3}\.){3}\d{1,3}\b/g],
  ['server address prefix', /\b187\.\d/g],
  ['ssh', /\bssh\b|ssh-(rsa|ed25519)|\.ssh\//gi],
  ['node host name', /kasseal-kaspad/gi],
  ['infrastructure env name', /\b(KASSEAL|VITE_KASSEAL)_[A-Z0-9_]+/g],
  ['local path', /\/Users\/|\/home\/[a-z]|\/private\/tmp\/|[A-Z]:\\\\Users/g],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b[xtk]prv[1-9A-HJ-NP-Za-km-z]{50,}|private[_ ]?key\s*[:=]\s*['"][0-9a-fA-F]{64}['"]/gi],
  ['seed phrase', /\b(mnemonic|seed[_ ]?phrase)\s*[:=]\s*['"`][a-z]+( [a-z]+){11,}/gi],
  ['internal hostname', /\b(?:[a-z0-9-]+\.)+kasseal\.[a-z]{2,}\b/gi],
  ['kaspa.org hostname', /\b(?:[a-z0-9-]+\.)+kaspa\.org\b/gi],
  ['hostname', /\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|xyz|cloud|ca|sh|ai)\b(?:\/[A-Za-z0-9_.-]+)?/gi],
];

/**
 * Rules for prose: every non-code text file and the comments of code files (the first two also the string literals of
 * code), never built output.
 */
export const COMMENT_RULES = [
  ...PRIVATE_PROSE_RULES,
  ['build nickname', /\b[Bb]uild [A-Z]\b|\b[Tt]wins?\b|\bTWIN\b/g],
  ['short audit id', /\b[SG][0-9]{1,2}\b(?![-.][0-9])/g],
];

/** Matches that are fine, per rule: [rule, file pattern, match pattern, reason]. */
export const ALLOW = [
  ['audit or decision id', /./, /^(KCC|KIP|KRC|SHA|UTF|BIP|ISO|RFC|ES|P2PK|P2SH|LP)-\d+/, 'standard and protocol names'],
  ['audit or decision id', /./, /^(Z0-9|VS\d+-\d+)$/, 'a character class and Unicode variation selectors'],
  ['infrastructure env name', /^packages\/codec\/src\/protected-names\.ts$/, /^KASSEAL_RESERVED$/, 'a reserved-ticker list, not an environment variable'],
  ['private repo path', /^packages\/txbuilder\/src\/wallet\/message\.ts$/, /^apps\/b$/, 'a path in the public Kaspire wallet repository'],
  ['IPv4 address', /./, /^(127\.0\.0\.1|0\.0\.0\.0)$/, 'loopback in the Kaspa SDK'],
  ['contract source', /(^|\/)(dist\/(artifacts\/contracts\/.*\.artifact\.json|chunks\/v1-kasseal-mainnet-2[^/]*\.js)|packages\/contracts\/.*\.artifact\.json)$/, /^(Curve|Pool)\.sil$/, 'the compiler\'s source_path field inside a compiled artifact'],
  ['contract source', /^packages\/(codec|curve-math|txbuilder)\/src\//, /^(curve|pool|kcc20)\.sil$/, 'source comments naming the contract a constant or rule comes from'],
  ['contract source', /^packages\/kasseal-sdk\/scripts\/build\.mjs$/, /^\.sil$/, 'the build\'s guard that no source is bundled'],
  ['internal hostname', /./, /^app\.kasseal\.com$/i, 'the public app and API host'],
  ['kaspa.org hostname', /./, /^(api|api-tn10)\.kaspa\.org$/i, 'the public Kaspa REST API'],
  ['hostname', /./, /^(app\.kasseal\.com|kasseal\.com|(api|api-tn10)\.kaspa\.org)(\/|$)/i, 'the public Kasseal and Kaspa API hosts'],
  ['hostname', /./, /^github\.com\/(Sealkaspa|kaspanet|argent-lang|BLAKE3-team|forbole|kasware-wallet)$/i, 'this repository and the public upstream projects it names'],
  ['hostname', /^README\.md$/, /^img\.shields\.io\//i, 'the README badges (npm version, licence) from the public shields.io service'],
  ['hostname', /./, /^raw\.githubusercontent\.com\/argent-lang$/i, 'the KCC-20 reference fixture\'s source'],
  ['hostname', /./, /^((www|registry|docs)\.)?npmjs\.(com|org)(\/|$)/i, 'the npm registry'],
  ['hostname', /./, /^(docs\.kasware\.xyz|semver\.org)(\/|$)/i, 'public wallet and versioning documentation'],
  ['short audit id', /./, /^[A-Z]0$/, 'hex-style names'],
];

/** Files whose rule hits are not reported: [file pattern, rules, reason]. */
const EXEMPT = [
  [/^(dist\/kaspa|packages\/sdk\/vendor)\//, new Set(['hostname']), 'the unmodified, hash-pinned Kaspa SDK release'],
];

/** Context the `.sil` allowance needs: only `"source_path": "sil/Curve.sil"` (or Pool), raw or JSON-escaped. */
const SIL_CONTEXT = /source_path\\?"\s*:\s*\\?"sil\/(Curve|Pool)\.sil$/;

/** Rules that only apply to the literals and comments of code (outside them a dash is subtraction). */
const LITERAL_ONLY_IN_CODE = new Set(['audit or decision id']);
/** Prose rules that also apply to the literals of code. */
const PROSE_IN_LITERALS = new Set(['build nickname', 'short audit id']);

const CODE = /\.(ts|mts|cts|js|mjs|cjs)$/;

/** Literal texts and comments of a code file, each with its offset, from a full parse (not a regex). */
function codePieces(text, rel) {
  const ts = require('typescript');
  const kind = /\.(ts|mts|cts)$/.test(rel) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(`x${path.extname(rel)}`, text, ts.ScriptTarget.Latest, true, kind);
  const literals = [];
  const comments = new Map();
  const addComments = (pos) => {
    for (const r of [...(ts.getLeadingCommentRanges(text, pos) ?? []), ...(ts.getTrailingCommentRanges(text, pos) ?? [])]) {
      comments.set(r.pos, { start: r.pos, text: text.slice(r.pos, r.end) });
    }
  };
  const visit = (n) => {
    addComments(n.pos);
    addComments(n.end);
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isRegularExpressionLiteral(n)) {
      literals.push({ start: n.getStart(sf), text: n.getText(sf) });
    }
    for (const c of n.getChildren(sf)) visit(c);
  };
  visit(sf);
  // A leading `#!` line and any comment the walk missed at the very end.
  addComments(0);
  return { literals, comments: [...comments.values()] };
}

export function scanText(rel, text) {
  const findings = [];
  const isCode = CODE.test(rel);
  const isBuilt = /^dist\//.test(rel) || /(^|\/)(dist\/kaspa|packages\/sdk\/vendor)\//.test(rel);
  const pieces = isCode ? codePieces(text, rel) : undefined;
  const whole = [{ start: 0, text }];
  const exempt = new Set(EXEMPT.filter(([file]) => file.test(rel)).flatMap(([, rules]) => [...rules]));
  const sets = [
    ...RULES.map(([rule, re]) => [rule, re, isCode && LITERAL_ONLY_IN_CODE.has(rule) ? [...pieces.literals, ...pieces.comments] : whole]),
    ...(isBuilt ? [] : COMMENT_RULES.map(([rule, re]) => [rule, re, !isCode ? whole : PROSE_IN_LITERALS.has(rule) ? [...pieces.literals, ...pieces.comments] : pieces.comments])),
  ];
  for (const [rule, re, parts] of sets) {
    if (exempt.has(rule)) continue;
    for (const piece of parts) for (const m0 of piece.text.matchAll(re)) {
      const m = { 0: m0[0], index: piece.start + m0.index };
      const hit = m[0];
      const allowed = ALLOW.some(([r, file, match]) => r === rule && file.test(rel) && match.test(hit));
      if (allowed && rule === 'contract source' && /^(Curve|Pool)\.sil$/.test(hit)) {
        const around = text.slice(Math.max(0, m.index - 40), m.index + hit.length);
        if (SIL_CONTEXT.test(around)) continue;
      } else if (allowed) {
        continue;
      }
      const line = text.slice(0, m.index).split('\n').length;
      const ctx = text.slice(Math.max(0, m.index - 30), m.index + hit.length + 30).replace(/\s+/g, ' ');
      findings.push({ file: rel, line, rule, hit, ctx });
    }
  }
  return findings;
}

/** The scanner must still catch planted leaks (and not flag subtraction in code); throws otherwise. */
export function selfTest() {
  const planted = [
    ['dist/x.js', 'const a=`below the minimum (D-9)`;const b=s[S-15];', ['audit or decision id']],
    ['dist/x.js', 'throw new Error("see docs/plan/x.md, owner 2026-10-20")', ['owner note', 'internal doc path']],
    ['dist/x.js', 'const u="ssh deploy@187.1.2.3";', ['IPv4 address', 'server address prefix', 'ssh']],
    ['dist/x.js', 'const k=process.env.KASSEAL_EXAMPLE_KEY;const h="https://api.kasseal.com";', ['infrastructure env name', 'internal hostname', 'hostname']],
    ['dist/x.js', 'const p="/Users/x/y";const s="pool.sil";', ['local path', 'contract source']],
    ['dist/x.js', 'const ok="https://app.kasseal.com/v1";const k="KCC-20";const l="127.0.0.1";', []],
    ['docs/x.md', 'Fixed in FC-1, see docs/audit/x.md (owner 2026-10-20).', ['audit or decision id', 'internal doc path', 'owner note']],
    ['examples/x.ts', 'const k = process.env.KASSEAL_DEPLOY_KEY; // apps/web/src', ['infrastructure env name', 'private repo path']],
    ['src/x.ts', '// the twin of build M, see OC-A1 and S6\nconst x = a - B - 1; const twin = 1;', ['build nickname', 'audit or decision id', 'short audit id']],
    ['src/x.ts', 'const p = "decoded against S1/S2 cells of build M";', ['short audit id', 'short audit id', 'build nickname']],
    ['README.md', 'Node on kasseal-kaspad at node.example.dev, see github.com/someone/repo; ok: github.com/Sealkaspa/kasseal-sdk', ['node host name', 'hostname', 'hostname']],
    ['packages/sdk/vendor/web/kaspa/kaspa.js', 'const u = "https://docs.rs/x"; // build B twin', []],
  ];
  for (const [file, text, rules] of planted) {
    const got = scanText(file, text).map((f) => f.rule).sort();
    const want = [...rules].sort();
    const uniq = (a) => [...new Set(a)];
    const ok = want.length > uniq(want).length ? JSON.stringify(got) === JSON.stringify(want) : JSON.stringify(uniq(got)) === JSON.stringify(want);
    if (!ok) fail('leak scan self-test', `${JSON.stringify(text)}: found ${got.join(', ') || 'nothing'}, expected ${want.join(', ') || 'nothing'}`);
  }
}

function scanFiles(root, files) {
  const findings = [];
  let scanned = 0;
  for (const rel of files) {
    if (BINARY.test(rel)) continue;
    scanned++;
    findings.push(...scanText(rel, readFileSync(path.join(root, rel), 'utf8')));
    findings.push(...scanText('(path)', rel).map((f) => ({ ...f, file: rel, line: 0 })));
  }
  return { files: files.length, scanned, findings };
}

export function scanPackage(root) {
  selfTest();
  return scanFiles(root, walk(root));
}

/** The repository root: two levels above this package. */
export const REPO = path.resolve(PKG, '..', '..');

/** Directories never scanned (dependencies, build output, generated sources, version control). */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'generated']);
/** This scanner: its rule table and planted self-test strings are leaks by design. */
const SELF = 'packages/kasseal-sdk/scripts/check-leaks.mjs';
/** The private word list itself (git-ignored here); it holds exactly the words the scan looks for. */
const PRIVATE_LIST = 'packages/kasseal-sdk/scripts/private-leak-rules.json';

function repoFiles(root, rel = '') {
  const out = [];
  for (const name of readdirSync(path.join(root, rel)).sort()) {
    const r = rel === '' ? name : `${rel}/${name}`;
    if (statSync(path.join(root, r)).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...repoFiles(root, r));
    } else if (r !== SELF && r !== PRIVATE_LIST && !/\.tgz$/.test(name)) {
      out.push(r);
    }
  }
  return out;
}

export function scanRepo(root = REPO) {
  selfTest();
  return scanFiles(root, repoFiles(root));
}

function report(label, { files, scanned, findings }) {
  if (findings.length > 0) {
    for (const f of findings.slice(0, 200)) console.error(`  ${f.file}:${f.line} [${f.rule}] ${JSON.stringify(f.hit)} ... ${f.ctx}`);
    if (findings.length > 200) console.error(`  ... and ${findings.length - 200} more`);
    fail(label, `${findings.length} finding(s) in ${new Set(findings.map((f) => f.file)).size} file(s)`);
  }
  console.log(`${label}: ok (${scanned} text files of ${files} scanned, binaries skipped)`);
}

async function main() {
  if (process.argv[2] === '--repo') {
    report('leak scan (repository)', scanRepo());
    return;
  }
  const root = process.argv[2] ?? packAndUnpack().root;
  report('leak scan (package)', scanPackage(root));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e instanceof CheckFailed ? e.message : e); process.exit(1); });
}
