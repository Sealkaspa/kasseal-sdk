/**
 * Authorization requirements produced by a layout's ownership check.
 *
 * A codec works on state bytes and has no transaction. It therefore states
 * WHAT must authorize a spend; a transaction-level validator proves it.
 * Keeping these apart stops us from ever "verifying" a signature we cannot see.
 */

import type { OwnerSemantic } from './types.ts';

/** What must authorize spending a token cell, by the kind of owner the cell names. */
export type AuthRequirement =
  | { readonly kind: 'signature'; readonly semantic: Extract<OwnerSemantic, 'pubkey'>; readonly pubkey: Uint8Array }
  | { readonly kind: 'signature-with-pubkey-reveal'; readonly semantic: Extract<OwnerSemantic, 'p2pkh-schnorr' | 'p2pkh-ecdsa'>; readonly pubkeyHash: Uint8Array }
  | { readonly kind: 'p2sh-input'; readonly semantic: Extract<OwnerSemantic, 'script-hash'>; readonly scriptHash: Uint8Array }
  | { readonly kind: 'covenant-input'; readonly semantic: Extract<OwnerSemantic, 'covenant-id'>; readonly covenantId: Uint8Array };

/** The authorization a cell owned by `owner` requires. */
export function describeAuth(owner: { schemeByte: number; semantic: OwnerSemantic; identifier: Uint8Array }): AuthRequirement {
  switch (owner.semantic) {
    case 'pubkey':
      return { kind: 'signature', semantic: 'pubkey', pubkey: owner.identifier };
    case 'p2pkh-schnorr':
    case 'p2pkh-ecdsa':
      return { kind: 'signature-with-pubkey-reveal', semantic: owner.semantic, pubkeyHash: owner.identifier };
    case 'script-hash':
      return { kind: 'p2sh-input', semantic: 'script-hash', scriptHash: owner.identifier };
    case 'covenant-id':
      return { kind: 'covenant-input', semantic: 'covenant-id', covenantId: owner.identifier };
  }
}
