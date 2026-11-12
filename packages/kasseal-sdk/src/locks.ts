/**
 * Token locks: loading the lock build in any entry, recognising its programs, and the shortest lock per network.
 * Pure logic: the builders, the state codec and the vesting arithmetic are the in-repository lock modules, re-exported
 * by `index.ts`.
 *
 * Contract rules and app rules. The lock contract and its factory enforce the state (1 to 100 tranches, a timestamp
 * start, cliff >= start, positive period, total <= 10^18, the exact deposit, the end cap), not the size or the length
 * of a lock: they know neither the token's supply nor the time of the creation. `buildLockCreate` and
 * `checkLockCreateTx` apply Kasseal's app rules on top (at least 0.05 % of the supply, the last release between the
 * minimum duration and 2 years after `now`, nothing claimable at creation), the rules Kasseal's indexer counts a lock
 * as locked by. The minimum duration is the builder's 7 days unless the caller passes `minDurationMs`.
 */
import { ensurePresetArtifacts } from '../../txbuilder/src/artifacts.ts';
import { LOCK_MIN_DURATION_MS, LOCK_MIN_DURATION_MS_TESTNET, loadLockV1, type LockV1Set } from '../../txbuilder/src/lock.ts';
import { templateHash } from '../../codec/src/template-hash.ts';
import { assertNetwork, type KassealNetwork } from './networks.ts';

/** The on-demand artifact group of the token-lock build in the web entries (`ensurePresetArtifacts` loads it too). */
export const LOCK_ARTIFACT_GROUP = 'token-lock-v1';

/**
 * The token-lock build (lock and factory programs, entry tags, the token template), loaded and cross-checked against
 * its manifest. In the Node entry the files are installed on import; in a web entry, after `initWeb`, this loads the
 * lock chunk first (checked against the pinned SHA-256 of every file). Use it before any lock builder or decoder.
 */
export async function loadLockSet(): Promise<LockV1Set> {
  await ensurePresetArtifacts(LOCK_ARTIFACT_GROUP);
  return loadLockV1();
}

/** What a program is, for the lock build: the lock (lineage K), a creator's factory, or neither. */
export type LockProgramKind = 'lock' | 'lock-factory';

function hasTemplate(program: Uint8Array, t: LockV1Set['lock'] | LockV1Set['factory']): boolean {
  return program.length === t.bytecode.length && templateHash(program.subarray(0, t.stateOffset), program.subarray(t.stateOffset + t.stateLength)) === t.templateHash;
}

/**
 * Whether a redeem script is the lock program (`LOCK_H`) or a factory program (`FACTORY_H`), recognised by its
 * template hash with the state left out (140 bytes at offset 1 for a lock, the 37-byte creator script for a factory).
 * Recognition only: decode a lock's state with `lockStateOfProgram` (or `lockCellOf` for a served cell), which also
 * refuses a state that does not re-encode.
 */
export function lockProgramKind(set: LockV1Set, program: Uint8Array): LockProgramKind | undefined {
  if (hasTemplate(program, set.lock)) return 'lock';
  if (hasTemplate(program, set.factory)) return 'lock-factory';
  return undefined;
}

/**
 * The shortest lock Kasseal's app offers by default on a network, for `minDurationMs`: 7 days on mainnet
 * (`LOCK_MIN_DURATION_MS`, also the builder's default), 10 minutes on testnet-10 (`LOCK_MIN_DURATION_MS_TESTNET`).
 * Neither is a contract rule.
 */
export function lockMinDurationMsOf(network: KassealNetwork): bigint {
  assertNetwork(network);
  return network === 'mainnet' ? LOCK_MIN_DURATION_MS : LOCK_MIN_DURATION_MS_TESTNET;
}
