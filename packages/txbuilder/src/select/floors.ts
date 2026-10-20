/**
 * Hard refusals on the outputs of every transaction the builder emits:
 *
 *   user token cell      value >= 0.1 KAS     (storage 4e12 / v; below it a cell costs more to move than it holds)
 *   any covenant output  value >= 0.08 KAS    (consensus: storage mass above the block limit, unminable)
 *   P2PK output          value >= 0.0201 KAS  (consensus floor 0.02 KAS plus margin)
 *   token output         not self-owned       (owner_scheme 0x04 with owner == its own covenant id is anyone-can-spend)
 *
 * `assertFloors` runs over the assembled outputs, after genesis bindings are
 * populated, so a genesis output's own covenant id is known when the
 * self-owned rule is checked. The thresholds are the builder's; the node only
 * enforces the 0.02 / 0.08 KAS consensus floors.
 */

import { assertNotSelfOwned, fromHex, TransferError } from '@kasseal/codec';
import type { AssembledTx } from '../assemble.ts';
import { COVENANT_OUTPUT_FLOOR, SOMPI_PER_KAS } from '../mass.ts';
import { OWNER_SCHEME_COVENANT_ID } from '../program.ts';

/** User token cells (owner scheme 0x00..0x03) below this are refused. */
export const MIN_USER_CELL_VALUE = SOMPI_PER_KAS / 10n;
/** Covenant outputs below this can never be mined (re-exported from the mass model). */
export const MIN_COVENANT_OUTPUT_VALUE = COVENANT_OUTPUT_FLOOR;
/** P2PK outputs (payouts, fee outputs, change) below this are refused. */
export const MIN_P2PK_OUTPUT_VALUE = 2_010_000n;

/** Which output floor a transaction broke. */
export type FloorRule = 'user-cell' | 'covenant-output' | 'p2pk-output' | 'self-owned';

/** An output is below its floor or self-owned; nothing is built. */
export class FloorViolation extends Error {
  /** The rule broken. */
  readonly rule: FloorRule;
  /** The offending output. */
  readonly outputIndex: number;
  constructor(rule: FloorRule, outputIndex: number, message: string) {
    super(message);
    this.name = 'FloorViolation';
    this.rule = rule;
    this.outputIndex = outputIndex;
  }
}

/** One output as the floor rules see it. */
export interface FloorOutput {
  readonly index: number;
  readonly label: string;
  readonly value: bigint;
  /** Covenant id the output is bound to, when it is a covenant output. */
  readonly covenantId: string | undefined;
  /** The predicted token state, when the output is a token cell. */
  readonly token: { readonly ownerScheme: number; readonly state: Parameters<typeof assertNotSelfOwned>[0] } | undefined;
}

/** Throws `FloorViolation` for the first output that breaks a rule. */
export function assertOutputFloors(txName: string, outputs: readonly FloorOutput[]): void {
  for (const o of outputs) {
    const where = `${txName}: output ${o.index} "${o.label}"`;
    if (o.covenantId === undefined) {
      if (o.value < MIN_P2PK_OUTPUT_VALUE) throw new FloorViolation('p2pk-output', o.index, `${where} of ${o.value} sompi is below the P2PK floor ${MIN_P2PK_OUTPUT_VALUE}`);
      continue;
    }
    if (o.value < MIN_COVENANT_OUTPUT_VALUE) throw new FloorViolation('covenant-output', o.index, `${where} of ${o.value} sompi is below the covenant output floor ${MIN_COVENANT_OUTPUT_VALUE} (unminable)`);
    if (o.token === undefined) continue;
    try {
      assertNotSelfOwned(o.token.state, fromHex(o.covenantId), where);
    } catch (e) {
      if (e instanceof TransferError) throw new FloorViolation('self-owned', o.index, e.message);
      throw e;
    }
    if (o.token.ownerScheme !== OWNER_SCHEME_COVENANT_ID && o.value < MIN_USER_CELL_VALUE) {
      throw new FloorViolation('user-cell', o.index, `${where} is a user cell of ${o.value} sompi, below the ${MIN_USER_CELL_VALUE} sompi minimum`);
    }
  }
}

/** The floor rules over an assembled transaction's outputs. */
export function assertFloors(a: AssembledTx): void {
  assertOutputFloors(
    a.plan.name,
    a.outputs.map((o) => {
      const covenantId = o.binding?.covenantId ?? o.cell?.covenantId;
      const token = o.cell?.predicted.kind === 'token' ? { ownerScheme: o.cell.predicted.state.owner.schemeByte, state: o.cell.predicted.state } : undefined;
      return { index: o.index, label: o.label, value: o.value, covenantId, token };
    }),
  );
}
