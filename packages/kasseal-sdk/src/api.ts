/**
 * A `UtxoSources` over the public Kasseal REST API. It only fetches: the builder checks every cell it is given again
 * (program, state, lineage, amounts) and refuses anything that does not verify, so a wrong or hostile answer can make
 * a build fail, never build a different trade.
 */
import { fromHex } from '../../codec/src/push.ts';
import { curveStateFromJson, poolStateFromJson, tokenStateFromJson } from '../../txbuilder/src/program.ts';
import type { PoolCellState } from '../../codec/src/cell-state.ts';
import type { FundingUtxo } from '../../txbuilder/src/assemble.ts';
import type { CovenantCell, CurveHead, UtxoSources } from '../../txbuilder/src/types.ts';
import { AddressError, addressPrefixOf, decodeAddress } from '../../txbuilder/src/wallet/address.ts';
import { assertNetwork, type KassealNetwork } from './networks.ts';

/** An API answer other than a success (after the waits for 429 and 503 ran out). */
export class ApiError extends Error {
  /** The request path, relative to the base URL. */
  readonly path: string;
  /** HTTP status. */
  readonly status: number;
  /** The problem document the API returned, when it returned one. */
  readonly problem: unknown;
  constructor(path: string, status: number, problem: unknown) {
    super(`${path}: HTTP ${status}`);
    this.name = 'ApiError';
    this.path = path;
    this.status = status;
    this.problem = problem;
  }
}

/** The curve or pool head is changing hands: read again in about a second. Nothing was built. */
export class HeadMoving extends Error {
  constructor() {
    super('the curve or pool head is changing hands; read again');
    this.name = 'HeadMoving';
  }
}

/** Options of `createApiSources`. */
export interface ApiSourcesOptions {
  /** The API base URL, for example `https://app.kasseal.com/v1` on mainnet. There is no default. */
  readonly baseUrl: string;
  /** `mainnet` or `testnet-10`: funding is only read for addresses of this network. */
  readonly network: KassealNetwork;
  /** The token lineage T you trade (its covenant id). The curve head and its cells are read by token. */
  readonly tokenId: string;
  /** Your x-only public key, hex: cells owned by it are read as `pk:<key>`. */
  readonly ownKey: string;
  /** Build on the pending tip when the API serves one (default true). Deposits and withdrawals may prefer false. */
  readonly useTip?: boolean;
  /** How many times a 429 or 503 answer is waited out and asked again (default 5). */
  readonly attempts?: number;
  /** The fetch to use (default: the global `fetch`). */
  readonly fetch?: typeof fetch;
}

interface CellWire {
  outpoint: { txid: string; index: number };
  amount: string;
  covenantId: string;
  redeemScript: string;
  templateHash: string;
  state: unknown;
  confirmed: boolean;
}

interface HeadWire extends CellWire {
  headSpent?: true;
}

interface CurveHeadWire extends HeadWire {
  tip?: { curve: CellWire; supply: CellWire; via: string[] };
}

interface PoolCellWire extends HeadWire {
  tip?: { pool: CellWire; reserve: CellWire; inventory?: CellWire; via: string[] };
}

interface AddressUtxosWire {
  utxos: { outpoint: { txid: string; index: number }; amount: string; scriptPublicKey: { version: number; script: string }; blockDaaScore: string; isCoinbase: boolean }[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const keyOf = (o: { txid: string; index: number }): string => `${o.txid}:${o.index}`;

const cellOf = <S>(w: CellWire, state: S, confirmed = w.confirmed): CovenantCell<S> => ({
  outpoint: { txid: w.outpoint.txid, index: w.outpoint.index },
  amount: BigInt(w.amount),
  covenantId: w.covenantId,
  redeemScript: fromHex(w.redeemScript),
  templateHash: w.templateHash,
  state,
  confirmed,
});

/**
 * What the builder reads, from the public API. With `useTip`, a pool or curve read returns the end of the chain of
 * pending trades, so a trade goes out at once; if a pending link is dropped, the transaction built on it is refused
 * with it and nothing is charged. `lastFunding()` returns the wallet UTXOs of the last `funding` read (the pin for a
 * safe retry). Coinbase outputs are never offered as funding.
 */
export function createApiSources(options: ApiSourcesOptions): UtxoSources & { lastFunding: () => readonly FundingUtxo[] } {
  assertNetwork(options.network);
  if (typeof options.baseUrl !== 'string' || !/^https?:\/\/[^/]/.test(options.baseUrl)) throw new TypeError('baseUrl must be an http(s) URL');
  const base = options.baseUrl.replace(/\/+$/, '');
  const prefix = addressPrefixOf(options.network);
  const attempts = options.attempts ?? 5;
  const doFetch = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const useTip = options.useTip ?? true;
  const ownKey = options.ownKey.toLowerCase();
  let poolTipReserve: { poolId: string; cell: CellWire } | undefined;
  let curveTipSupply: CellWire | undefined;
  let funding: FundingUtxo[] = [];

  async function get<T>(path: string): Promise<T> {
    for (let i = 0; ; i++) {
      const res = await doFetch(`${base}${path}`, { headers: { accept: 'application/json' } });
      if (res.ok) return (await res.json()) as T;
      const problem = (await res.json().catch(() => null)) as { retryAfterMs?: unknown } | null;
      if ((res.status === 429 || res.status === 503) && i + 1 < attempts) {
        const wait = typeof problem?.retryAfterMs === 'number' && problem.retryAfterMs >= 0 ? Math.min(problem.retryAfterMs, 30_000) : 1_000;
        await sleep(wait + Math.floor(Math.random() * 250));
        continue;
      }
      throw new ApiError(path, res.status, problem);
    }
  }

  const ownerParam = (key: string): string => {
    if (key.startsWith('script:')) return key;
    return key.toLowerCase() === ownKey ? `pk:${key}` : `covenant:${key}`;
  };

  return {
    lastFunding: () => funding,

    async funding(address) {
      if (decodeAddress(address).prefix !== prefix) throw new AddressError(`${address} is not a ${options.network} address`);
      const w = await get<AddressUtxosWire>(`/address/${encodeURIComponent(address)}/utxos`);
      funding = w.utxos
        .filter((u) => !u.isCoinbase && u.scriptPublicKey.version === 0)
        .map((u) => ({
          outpoint: { txid: u.outpoint.txid, index: u.outpoint.index },
          amount: BigInt(u.amount),
          spk: fromHex(u.scriptPublicKey.script),
          daaScore: BigInt(u.blockDaaScore),
          address,
        }));
      return funding;
    },

    async tokenCells(T, key) {
      const owner = ownerParam(key);
      const listed = (await get<{ cells: CellWire[] }>(`/tokens/${T}/cells?owner=${encodeURIComponent(owner)}`)).cells
        .map((w) => cellOf(w, tokenStateFromJson(w.state)));
      // On a pending pool tip, the tip's reserve is offered first; the builder still takes only the cell the state pins.
      if (poolTipReserve !== undefined && owner === `covenant:${poolTipReserve.poolId}` && poolTipReserve.cell.covenantId === T) {
        const first = cellOf(poolTipReserve.cell, tokenStateFromJson(poolTipReserve.cell.state), false);
        return [first, ...listed.filter((c) => keyOf(c.outpoint) !== keyOf(first.outpoint))];
      }
      return listed;
    },

    async covenantCells() {
      const w = await get<{ supply?: CellWire; reserve?: CellWire }>(`/tokens/${options.tokenId}/covenant-cells`);
      const supply = curveTipSupply ?? w.supply;
      if (supply === undefined || w.reserve === undefined) throw new HeadMoving();
      return { supply: cellOf(supply, tokenStateFromJson(supply.state)), reserve: cellOf(w.reserve, tokenStateFromJson(w.reserve.state)) };
    },

    async curveHead(): Promise<CurveHead> {
      const w = await get<CurveHeadWire>(`/tokens/${options.tokenId}/curve-head`);
      if (w.headSpent === true) throw new HeadMoving();
      const tip = useTip ? w.tip : undefined;
      curveTipSupply = tip?.supply;
      const c = tip?.curve ?? w;
      return cellOf(c, curveStateFromJson(c.state), tip === undefined ? w.confirmed : false);
    },

    async poolCell(poolId) {
      const w = await get<PoolCellWire>(`/pools/${poolId}/cell`);
      if (w.headSpent === true) throw new HeadMoving();
      const tip = useTip ? w.tip : undefined;
      poolTipReserve = tip === undefined ? undefined : { poolId, cell: tip.reserve };
      const c = tip?.pool ?? w;
      return cellOf<PoolCellState>(c, poolStateFromJson(c.state), tip === undefined ? w.confirmed : false);
    },

    async feerate() {
      // The builder refuses a rate outside its own bounds, so the API cannot pick an excessive fee.
      return BigInt((await get<{ feerateSompiPerGram: string }>('/fees')).feerateSompiPerGram);
    },
  };
}
