/**
 * An independent pre-sign check of where a built transaction sends tokens.
 *
 * A token output is a P2SH output: the wallet sees only the hash of the token program, never the owner inside its
 * state, so a compromised front end could build a buy whose tokens go to another key and the user would still sign.
 * `checkTokenRecipients` re-derives every token output from the state the builder claims for it and refuses the
 * transaction unless all of these hold:
 *
 *   1. every output bound to a checked token lineage (`tokenIds`: T, and L on a v1 pool) is claimed by a produced
 *      cell of the transaction's optimistic delta; nothing token-bound is left unexplained;
 *   2. every claimed cell sits at an output that exists, is bound to a checked lineage, and whose script is exactly
 *      `p2sh(tokenProgram(state))`: the state claimed is the state the output commits to;
 *   3. each claimed owner is the connected key (`userXOnly`, scheme 0x00) or one of the named covenants
 *      (`covenantOwners`, scheme 0x04: the curve, the pool), nothing else.
 *
 * It reads only the transaction's own SafeJSON and the committed token template, so it holds whatever built the
 * transaction. It throws `TokenRecipientRefused` with the output index and the reason.
 */
import { bytesEqual, fromHex, toHex } from '@kasseal/codec';
import { p2shScript } from './blake2b.ts';
import { OWNER_SCHEME_COVENANT_ID, OWNER_SCHEME_P2PK_SCHNORR, tokenProgram, type TokenTemplate } from './program.ts';
import type { BuiltTx } from './types.ts';

/** A built transaction sends tokens somewhere the caller did not name, or claims a state its output does not commit to. */
export class TokenRecipientRefused extends Error {
  /** The offending output, when one is to blame. */
  readonly outputIndex: number | undefined;
  constructor(outputIndex: number | undefined, detail: string) {
    super(`token recipients refused${outputIndex === undefined ? '' : ` at output ${outputIndex}`}: ${detail}`);
    this.name = 'TokenRecipientRefused';
    this.outputIndex = outputIndex;
  }
}

/** What `checkTokenRecipients` accepts as a token recipient. */
export interface TokenRecipientRules {
  /** The token lineages whose outputs are checked (T; on a v1 pool also the LP-share lineage L). */
  readonly tokenIds: readonly string[];
  /** The connected account's x-only key (32 bytes, or its hex). */
  readonly userXOnly: Uint8Array | string;
  /** Covenant ids that may own token outputs (the curve C, the pool P), hex. */
  readonly covenantOwners: readonly string[];
}

interface SafeJsonOutput {
  readonly value?: string | number;
  readonly scriptPublicKey?: string;
  readonly covenant?: { readonly authorizingInput?: number; readonly covenantId?: string } | null;
}

const lower = (s: string): string => s.toLowerCase();

/** Refuses `built` unless every token output is explained and owned by the user or a named covenant (see above). */
export function checkTokenRecipients(built: BuiltTx, rules: TokenRecipientRules, token: TokenTemplate): void {
  const covenants = new Set(rules.covenantOwners.map(lower));
  const user = typeof rules.userXOnly === 'string' ? fromHex(rules.userXOnly) : rules.userXOnly;
  if (user.length !== 32) throw new TokenRecipientRefused(undefined, 'the user key is not a 32-byte x-only key');
  for (const { index: i, owner } of claimedTokenOutputs(built, rules.tokenIds, token)) {
    if (owner.schemeByte === OWNER_SCHEME_P2PK_SCHNORR) {
      if (!bytesEqual(owner.identifier, user)) throw new TokenRecipientRefused(i, `tokens go to key ${toHex(owner.identifier)}, not the connected key`);
    } else if (owner.schemeByte === OWNER_SCHEME_COVENANT_ID) {
      if (!covenants.has(toHex(owner.identifier))) throw new TokenRecipientRefused(i, `tokens go to covenant ${toHex(owner.identifier)}, which this transaction does not name`);
    } else {
      throw new TokenRecipientRefused(i, `owner scheme 0x${owner.schemeByte.toString(16).padStart(2, '0')} is neither the connected key nor a named covenant`);
    }
  }
}

/** One owner a token output may have: a scheme byte and the 32-byte identifier (hex). */
export interface TokenOwnerRule {
  /** KCC-20 owner scheme byte. */
  readonly scheme: number;
  /** 32-byte owner identifier, hex. */
  readonly identifier: string;
}

/**
 * The same check for transactions with no connected key: every token output must be claimed by a produced cell whose
 * state its script commits to (rules 1 and 2 above), and each owner must be one of `owners` exactly (scheme and
 * identifier).
 */
export function checkTokenOwners(built: BuiltTx, tokenIds: readonly string[], owners: readonly TokenOwnerRule[], token: TokenTemplate): void {
  const allowed = new Set(owners.map((o) => `${o.scheme}:${lower(o.identifier)}`));
  for (const { index: i, owner } of claimedTokenOutputs(built, tokenIds, token)) {
    const k = `${owner.schemeByte}:${toHex(owner.identifier)}`;
    if (!allowed.has(k)) {
      throw new TokenRecipientRefused(i, `tokens go to owner ${toHex(owner.identifier)} under scheme 0x${owner.schemeByte.toString(16).padStart(2, '0')}, which this transaction does not name`);
    }
  }
}

/** Rules 1 and 2: every token-bound output claimed, every claim the output's own state. Returns each claim's owner. */
function claimedTokenOutputs(built: BuiltTx, tokenIds: readonly string[], token: TokenTemplate): { index: number; owner: { schemeByte: number; identifier: Uint8Array } }[] {
  const ids = new Set(tokenIds.map(lower));
  let outputs: readonly SafeJsonOutput[];
  try {
    const j = JSON.parse(built.txJson) as { outputs?: unknown };
    if (!Array.isArray(j.outputs)) throw new Error('no outputs');
    outputs = j.outputs as SafeJsonOutput[];
  } catch {
    throw new TokenRecipientRefused(undefined, 'the transaction does not parse');
  }

  const claimed = new Map<number, (typeof built.optimistic.cells.produced)[number]>();
  for (const p of built.optimistic.cells.produced) {
    if (p.outpoint.txid !== built.txid) throw new TokenRecipientRefused(p.outpoint.index, 'a produced cell names another transaction');
    if (claimed.has(p.outpoint.index)) throw new TokenRecipientRefused(p.outpoint.index, 'two cells claim the same output');
    claimed.set(p.outpoint.index, p);
  }

  outputs.forEach((o, i) => {
    const bound = typeof o.covenant?.covenantId === 'string' && ids.has(lower(o.covenant.covenantId));
    if (bound && !claimed.has(i)) throw new TokenRecipientRefused(i, 'a token output that no produced cell explains');
  });

  const out: { index: number; owner: { schemeByte: number; identifier: Uint8Array } }[] = [];
  for (const [i, cell] of claimed) {
    const o = outputs[i];
    if (o === undefined) throw new TokenRecipientRefused(i, 'a produced cell claims an output the transaction does not have');
    const id = o.covenant?.covenantId;
    if (typeof id !== 'string' || !ids.has(lower(id))) throw new TokenRecipientRefused(i, 'a produced cell claims an output that is not bound to the token');
    let program: Uint8Array;
    try {
      program = tokenProgram(token, cell.state);
    } catch (e) {
      throw new TokenRecipientRefused(i, `the claimed state does not encode: ${e instanceof Error ? e.message : String(e)}`);
    }
    const spk = typeof o.scriptPublicKey === 'string' && /^0000([0-9a-f]{2})+$/i.test(o.scriptPublicKey) ? fromHex(o.scriptPublicKey.slice(4)) : null;
    if (spk === null || !bytesEqual(spk, p2shScript(program))) throw new TokenRecipientRefused(i, 'the output script is not the claimed token state');
    out.push({ index: i, owner: cell.state.owner });
  }
  return out;
}
