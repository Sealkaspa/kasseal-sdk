// Build-time adjustments of the bundled sources, so that the published files carry no internal references. None of
// them changes what a transaction contains; the byte-parity check proves that against the in-repository builder.

/**
 * Message text: [source file suffix, exact text, replacement]. Applied when the text is present; the leak scan
 * catches anything that is not covered here. Empty: the sources carry the published text.
 */
export const SOURCE_REPLACEMENTS = [];

/** Modules replaced in the bundle: [source file suffix, contents]. Empty. */
export const MODULE_STUBS = [];

/** Declaration text: [exact text, replacement]. Output roles left out of the published `OutputRole` type. */
export const DTS_REPLACEMENTS = [
  [" | 'company' | 'vault' | 'deposit' | 'splitter' | 'order' | 'pot' | 'dist-key' | 'filler' | 'refund';", ';'],
];

/** Declaration members removed: [interface name, member line]. Empty. */
export const DTS_REMOVED_MEMBERS = [];

export function esbuildScrubPlugin() {
  return {
    name: 'kassealhq-scrub',
    setup(b) {
      b.onLoad({ filter: /\.ts$/ }, async (args) => {
        const file = args.path.replace(/\\/g, '/');
        const stub = MODULE_STUBS.find(([suffix]) => file.endsWith(`/${suffix}`));
        if (stub) return { contents: stub[1], loader: 'ts' };
        const reps = SOURCE_REPLACEMENTS.filter(([suffix]) => file.endsWith(`/${suffix}`));
        if (reps.length === 0) return undefined;
        const { readFile } = await import('node:fs/promises');
        let text = await readFile(args.path, 'utf8');
        for (const [, from, to] of reps) text = text.split(from).join(to);
        return { contents: text, loader: 'ts' };
      });
    },
  };
}

/** Apply the declaration adjustments; returns the text and how many of each were applied. */
export function scrubDeclarations(text) {
  let applied = 0;
  for (const [from, to] of DTS_REPLACEMENTS) {
    if (text.includes(from)) {
      text = text.split(from).join(to);
      applied++;
    }
  }
  for (const [iface, member] of DTS_REMOVED_MEMBERS) {
    const re = new RegExp(`(interface ${iface} \\{[^}]*?)\\n\\s*${member.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    if (re.test(text)) {
      text = text.replace(re, '$1');
      applied++;
    }
  }
  return { text, applied };
}
