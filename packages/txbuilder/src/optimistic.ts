/**
 * A client's optimistic view of its own transactions: each transaction's `OptimisticDelta` is applied on
 * `submitted`, committed on `accepted`, dropped once confirmed, and rolled
 * back on `lost-race` / `failed`.
 *
 * Chained trades: a second trade by the same user is built against the
 * predicted head (`curveHead`, `poolHead`), the predicted token cells and the
 * first trade's change (`fundingView`); mempool chaining is allowed. A
 * transaction that spends an output of another live row depends on it, and
 * rolling a row back rolls back everything that depends on it, transitively;
 * `rollback` returns those dependents so the app rebuilds them against the
 * new head.
 *
 * Invariants (property-tested):
 *   - no two live rows consume the same outpoint (an own double spend is refused at `apply`);
 *   - a row is live only while every row it depends on is live;
 *   - `reserved()` is exactly the union of the live rows' consumed and reserved outpoints;
 *   - apply followed by rollback restores every view exactly.
 *
 * The server holds no optimistic state; this store is the client half of the
 * reconciliation contract (`onHead`, `onConflict`).
 */

import type { TokenState } from '@kasseal/codec';
import { outpointKey, type FundingUtxo, type Outpoint } from './assemble.ts';
import type { CurveState, PoolCellState } from './program.ts';
import type { BuiltTx, OptimisticDelta, Sompi } from './types.ts';

/** Where a live row stands: submitted, or accepted into a block. */
export type RowStatus = 'pending' | 'accepted';

/** One live transaction the store tracks. */
export interface PendingTx {
  /** Transaction id. */
  readonly txid: string;
  /** Where it stands. */
  readonly status: RowStatus;
  /** Outpoints it spends. */
  readonly consumes: readonly Outpoint[];
  /** The singleton continuation this transaction predicts, if it moves one. */
  readonly predictedHead?: { readonly kind: 'curve' | 'pool'; readonly covenantId: string; readonly outpoint: Outpoint };
  /** When it was submitted (caller's clock, ms). */
  readonly submittedAt: number;
  /** Live rows whose outputs this transaction spends. */
  readonly dependsOn: readonly string[];
  /** Its optimistic delta. */
  readonly delta: OptimisticDelta;
}

/** A predicted cell. */
export interface OptimisticCell<S> {
  /** Its outpoint. */
  readonly outpoint: Outpoint;
  /** Its predicted state. */
  readonly state: S;
  /** Its KAS value. */
  readonly amount: Sompi;
}

/** A predicted singleton head (curve or pool). */
export interface HeadView<S> extends OptimisticCell<S> {
  /** Live rows the prediction passes through, oldest first (empty: the base is the head). */
  readonly via: readonly string[];
}

/** A delta conflicts with the live rows (an own double spend, or a delta that does not match its transaction). */
export class OptimisticConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptimisticConflict';
  }
}

/** What `apply` needs of a built transaction. */
export type DeltaSource = Pick<BuiltTx, 'txid' | 'consumes' | 'optimistic'>;

function predictedHeadOf(d: OptimisticDelta): PendingTx['predictedHead'] {
  if (d.curve) return { kind: 'curve', covenantId: d.curve.covenantId, outpoint: d.curve.toOutpoint };
  if (d.pool) return { kind: 'pool', covenantId: d.pool.poolId, outpoint: d.pool.toOutpoint };
  const g = d.genesis?.[0];
  return g ? { kind: g.kind, covenantId: g.covenantId, outpoint: g.outpoint } : undefined;
}

/** Every outpoint a delta says its transaction consumes. */
function consumedByDelta(d: OptimisticDelta): Outpoint[] {
  return [
    ...(d.curve ? [d.curve.fromOutpoint] : []),
    ...(d.pool ? [d.pool.fromOutpoint] : []),
    ...d.cells.consumed,
    ...(d.terminated ?? []).map((t) => t.outpoint),
  ];
}

/** The optimistic store: apply on submit, commit on accept, roll back on loss, with chained-trade views. */
export class OptimisticStore {
  readonly #rows = new Map<string, PendingTx>();

  /** Live rows in application order. */
  pending(): readonly PendingTx[] {
    return [...this.#rows.values()];
  }

  /** The live row of `txid`, if any. */
  get(txid: string): PendingTx | undefined {
    return this.#rows.get(txid);
  }

  /** On `submitted`: record the delta. Refuses an own double spend and a delta that does not match the transaction. */
  apply(tx: DeltaSource, submittedAt: number): PendingTx {
    if (this.#rows.has(tx.txid)) throw new OptimisticConflict(`${tx.txid} is already applied`);
    const consumes = tx.consumes.map((o) => ({ txid: o.txid, index: o.index }));
    const keys = new Set(consumes.map(outpointKey));
    if (keys.size !== consumes.length) throw new OptimisticConflict(`${tx.txid} consumes an outpoint twice`);
    for (const o of consumedByDelta(tx.optimistic)) {
      if (!keys.has(outpointKey(o))) throw new OptimisticConflict(`${tx.txid}: the delta consumes ${outpointKey(o)}, which the transaction does not spend`);
    }
    for (const o of tx.optimistic.funding.reserved) {
      if (!keys.has(outpointKey(o)) && o.txid !== tx.txid) throw new OptimisticConflict(`${tx.txid}: reserves ${outpointKey(o)}, neither spent nor produced by it`);
    }
    for (const row of this.#rows.values()) {
      const clash = row.consumes.find((o) => keys.has(outpointKey(o)));
      if (clash) throw new OptimisticConflict(`${tx.txid} spends ${outpointKey(clash)}, already spent by our ${row.txid}`);
    }
    const dependsOn = [...new Set(consumes.filter((o) => this.#rows.has(o.txid)).map((o) => o.txid))];
    const head = predictedHeadOf(tx.optimistic);
    const row: PendingTx = { txid: tx.txid, status: 'pending', consumes, ...(head ? { predictedHead: head } : {}), submittedAt, dependsOn, delta: tx.optimistic };
    this.#rows.set(tx.txid, row);
    return row;
  }

  /** On `accepted`: the row stays (its outputs may still be spent by chained rows) until `drop` on confirmation. */
  commit(txid: string): void {
    const row = this.#require(txid);
    if (row.dependsOn.some((d) => this.#rows.get(d)?.status === 'pending')) throw new OptimisticConflict(`${txid} accepted before a transaction it spends`);
    if (row.status === 'pending') this.#rows.set(txid, { ...row, status: 'accepted' });
  }

  /** On `confirmed` (depth >= 10): forget the row; the API's view now contains it. */
  drop(txid: string): void {
    const row = this.#require(txid);
    if (row.status !== 'accepted') throw new OptimisticConflict(`${txid} is dropped before acceptance`);
    this.#rows.delete(txid);
    for (const [k, r] of this.#rows) if (r.dependsOn.includes(txid)) this.#rows.set(k, { ...r, dependsOn: r.dependsOn.filter((d) => d !== txid) });
  }

  /**
   * On `lost-race` / `failed`: remove the row and every live row that depends on it, transitively. Returns the removed
   * txids, the given one first, then its dependents in application order (the transactions to rebuild).
   */
  rollback(txid: string): string[] {
    const row = this.#require(txid);
    if (row.status === 'accepted') throw new OptimisticConflict(`${txid} was accepted; an accepted transaction is not rolled back`);
    const doomed = new Set([txid]);
    for (const r of this.#rows.values()) if (r.dependsOn.some((d) => doomed.has(d))) doomed.add(r.txid);
    const order = [txid, ...[...this.#rows.keys()].filter((k) => k !== txid && doomed.has(k))];
    for (const k of order) this.#rows.delete(k);
    return order;
  }

  /**
   * Our own replacement took the place of `oldTxid`: the new row consumes the same outpoints. Rows that
   * spent the old transaction's outputs lose them (the txid changed) and are rolled back; their txids are returned.
   */
  replace(oldTxid: string, next: DeltaSource, submittedAt: number): string[] {
    const old = this.#require(oldTxid);
    if (old.status !== 'pending') throw new OptimisticConflict(`${oldTxid} is not pending`);
    const a = old.consumes.map(outpointKey).sort();
    const b = next.consumes.map(outpointKey).sort();
    if (a.length !== b.length || a.some((k, i) => k !== b[i])) throw new OptimisticConflict('a replacement must spend the same outpoints');
    const removed = this.rollback(oldTxid);
    try {
      this.apply(next, submittedAt);
    } catch (e) {
      this.#rows.set(oldTxid, old);
      throw e;
    }
    return removed.slice(1);
  }

  /** Outpoints the funding and cell selectors must skip: everything live rows spend or reserve. */
  reserved(): Set<string> {
    const out = new Set<string>();
    for (const r of this.#rows.values()) {
      for (const o of r.consumes) out.add(outpointKey(o));
      for (const o of r.delta.funding.reserved) out.add(outpointKey(o));
    }
    return out;
  }

  /** The predicted curve head: `base` (the API's head, if any) advanced through live rows. Undefined once a live row ends the lineage. */
  curveHead(covenantId: string, base?: OptimisticCell<CurveState>): HeadView<CurveState> | undefined {
    return this.#head('curve', covenantId, base);
  }

  poolHead(poolId: string, base?: OptimisticCell<PoolCellState>): HeadView<PoolCellState> | undefined {
    return this.#head('pool', poolId, base);
  }

  /** Token cells: `base` without what live rows consume, plus what they produce and nothing live consumes. */
  tokenCells(base: readonly OptimisticCell<TokenState>[]): OptimisticCell<TokenState>[] {
    const spent = this.#spent();
    const out = base.filter((c) => !spent.has(outpointKey(c.outpoint)));
    const present = new Set(out.map((c) => outpointKey(c.outpoint)));
    for (const r of this.#rows.values()) {
      for (const p of r.delta.cells.produced) {
        const k = outpointKey(p.outpoint);
        if (!spent.has(k) && !present.has(k)) {
          out.push({ outpoint: p.outpoint, state: p.state, amount: p.amount });
          present.add(k);
        }
      }
    }
    return out;
  }

  /**
   * Funding for the next transaction: `base` without reserved outpoints, plus the change (or payout) of live rows
   * that nothing live spends, as UTXOs of `owner` (mempool chaining). `pendingDaaScore` is recorded on those entries;
   * neither the txid nor the sighash covers it.
   */
  fundingView(base: readonly FundingUtxo[], owner: { readonly address: string; readonly spk: Uint8Array }, pendingDaaScore = 0n): FundingUtxo[] {
    const reserved = this.reserved();
    const out = base.filter((u) => !reserved.has(outpointKey(u.outpoint)));
    const present = new Set(out.map((u) => outpointKey(u.outpoint)));
    for (const r of this.#rows.values()) {
      const c = r.delta.funding.change;
      if (!c) continue;
      const k = outpointKey(c.outpoint);
      if (reserved.has(k) || present.has(k)) continue;
      out.push({ outpoint: c.outpoint, amount: c.amount, spk: owner.spk, daaScore: pendingDaaScore, address: owner.address });
      present.add(k);
    }
    return out;
  }

  /**
   * A `curve.head` (or pool head) event: `createdBy` produced the new head by consuming `consumed`. Our own
   * row is committed; every pending row that spent one of those outpoints lost the race and is rolled back with its
   * dependents.
   */
  onHead(event: { readonly createdBy: string; readonly consumed: readonly Outpoint[] }): { accepted: string[]; lost: string[] } {
    const accepted: string[] = [];
    const own = this.#rows.get(event.createdBy);
    if (own) {
      this.commit(event.createdBy);
      accepted.push(event.createdBy);
    }
    return { accepted, lost: this.#loseTo(event.createdBy, event.consumed) };
  }

  /** A `tx.conflict {outpoint, winnerTxid}` event: our pending rows spending `outpoint` lost before acceptance. */
  onConflict(event: { readonly outpoint: Outpoint; readonly winnerTxid: string }): string[] {
    return this.#loseTo(event.winnerTxid, [event.outpoint]);
  }

  #loseTo(winner: string, consumed: readonly Outpoint[]): string[] {
    const keys = new Set(consumed.map(outpointKey));
    const lost: string[] = [];
    for (const r of [...this.#rows.values()]) {
      if (r.txid === winner || r.status !== 'pending' || !this.#rows.has(r.txid)) continue;
      if (r.consumes.some((o) => keys.has(outpointKey(o)))) lost.push(...this.rollback(r.txid));
    }
    return lost;
  }

  #require(txid: string): PendingTx {
    const row = this.#rows.get(txid);
    if (!row) throw new OptimisticConflict(`${txid} is not a live row`);
    return row;
  }

  #spent(): Set<string> {
    const out = new Set<string>();
    for (const r of this.#rows.values()) for (const o of r.consumes) out.add(outpointKey(o));
    return out;
  }

  #head<S extends CurveState | PoolCellState>(kind: 'curve' | 'pool', id: string, base: OptimisticCell<S> | undefined): HeadView<S> | undefined {
    let cur: OptimisticCell<S> | undefined = base;
    const via: string[] = [];
    if (cur === undefined) {
      for (const r of this.#rows.values()) {
        const g = r.delta.genesis?.find((x) => x.kind === kind && x.covenantId === id);
        if (g) {
          cur = { outpoint: g.outpoint, state: g.state as S, amount: g.amount };
          via.push(r.txid);
          break;
        }
      }
      if (cur === undefined) return undefined;
    }
    for (let guard = 0; guard <= this.#rows.size; guard++) {
      const at = outpointKey(cur.outpoint);
      let next: { row: PendingTx; cell: OptimisticCell<S> } | undefined;
      for (const r of this.#rows.values()) {
        const t = kind === 'curve' ? r.delta.curve : r.delta.pool;
        const tid = t === undefined ? undefined : 'covenantId' in t ? t.covenantId : t.poolId;
        if (t && tid === id && outpointKey(t.fromOutpoint) === at) {
          next = { row: r, cell: { outpoint: t.toOutpoint, state: t.state as S, amount: t.amount } };
          break;
        }
        if (r.delta.terminated?.some((x) => x.kind === kind && x.covenantId === id && outpointKey(x.outpoint) === at)) return undefined;
      }
      if (next === undefined) return { ...cur, via };
      via.push(next.row.txid);
      cur = next.cell;
    }
    throw new OptimisticConflict(`${kind} ${id}: the predicted chain loops`);
  }
}
