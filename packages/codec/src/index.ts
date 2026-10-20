export * from './errors.ts';
export * from './types.ts';
export * from './auth.ts';
export * from './push.ts';
export * from './blake3.ts';
export * from './template-hash.ts';
export * from './registry.ts';
export * from './kcc20-46.ts';
export * from './kcc0020-112.ts';
export * from './templates.ts';
export * from './blake3-keyed.ts';
export * from './blake2b.ts';
export * from './sha256.ts';
export * from './kip24.ts';
export * from './program.ts';
export * from './push-rule.ts';
export * from './number-rule.ts';
export * from './cell-state.ts';
export * from './kcc0023.ts';

import { LayoutRegistry } from './registry.ts';
import { kcc20_46 } from './kcc20-46.ts';
import { kcc0020_112 } from './kcc0020-112.ts';
import { QUARANTINED_TEMPLATES, RECOGNISED_TEMPLATES, REFERENCE_KCC0020_TEMPLATE, VERIFIED_TEMPLATES } from './templates.ts';

/** Registry preloaded with everything we have verified. */
export function createDefaultRegistry(): LayoutRegistry {
  const registry = new LayoutRegistry().registerCodec(kcc20_46).registerCodec(kcc0020_112);
  for (const t of VERIFIED_TEMPLATES) registry.registerTemplate(t);
  registry.registerTemplate(REFERENCE_KCC0020_TEMPLATE);
  for (const t of RECOGNISED_TEMPLATES) registry.registerTemplate(t);
  for (const q of QUARANTINED_TEMPLATES) registry.quarantineTemplate(q);
  return registry;
}
export * from './display-text.ts';
export * from './protected-names.ts';
