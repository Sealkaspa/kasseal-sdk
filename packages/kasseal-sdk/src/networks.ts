/**
 * Networks, contract builds and API endpoints of the public SDK, and the network-explicit wrappers of the context and
 * builder factories.
 */
import { createContext as createContextAny, type BuilderContext } from '../../txbuilder/src/cells.ts';
import { createTxBuilder as createTxBuilderAny, type KassealTxBuilder, type TxBuilderOptions as AnyTxBuilderOptions } from '../../txbuilder/src/builder.ts';

/** The networks this package builds for. */
export type KassealNetwork = 'mainnet' | 'testnet-10';

export const NETWORKS: readonly KassealNetwork[] = Object.freeze(['mainnet', 'testnet-10'] as const);

/**
 * The contract build new launches use on each network: Kasseal-mainnet-3, with the creator window (on a curve nothing
 * has traded on, only the creator can buy until the curve is about 20 seconds old).
 */
export const BUILD_OF_NETWORK: Readonly<Record<KassealNetwork, string>> = Object.freeze({
  mainnet: 'v1-kasseal-mainnet-3',
  'testnet-10': 'v1-kasseal-mainnet-3-tn10',
});

/**
 * Every contract build this package trades on each network, the launch build first. A token keeps the build it was
 * launched on: tokens launched before Kasseal-mainnet-3 trade on Kasseal-mainnet-2 (the same pool program).
 */
export const BUILDS_OF_NETWORK: Readonly<Record<KassealNetwork, readonly string[]>> = Object.freeze({
  mainnet: Object.freeze(['v1-kasseal-mainnet-3', 'v1-kasseal-mainnet-2']),
  'testnet-10': Object.freeze(['v1-kasseal-mainnet-3-tn10', 'v1-kasseal-mainnet-2-tn10']),
});

/** The contract builds bundled with this package. */
export const SUPPORTED_BUILDS: readonly string[] = Object.freeze([...BUILDS_OF_NETWORK.mainnet, ...BUILDS_OF_NETWORK['testnet-10']]);

/** Public API base URLs. There is no default: pass the base URL of the network you use explicitly. */
export const API_BASE_URLS: Readonly<Partial<Record<KassealNetwork, string>>> = Object.freeze({
  mainnet: 'https://app.kasseal.com/v1',
  'testnet-10': 'https://testnet.kasseal.com/v1',
});

/** A network id this package does not build for. */
export class UnsupportedNetwork extends Error {
  readonly networkId: string;
  constructor(networkId: string) {
    super(`network ${JSON.stringify(networkId)} is not supported: use 'mainnet' or 'testnet-10'`);
    this.name = 'UnsupportedNetwork';
    this.networkId = networkId;
  }
}

/** A contract build that is not one of the given network's. */
export class UnsupportedBuild extends Error {
  readonly build: string;
  readonly networkId: string;
  constructor(build: string, networkId: string) {
    super(`contract build ${JSON.stringify(build)} is not a ${networkId} build (${(BUILDS_OF_NETWORK[networkId as KassealNetwork] ?? []).join(', ') || 'none'})`);
    this.name = 'UnsupportedBuild';
    this.build = build;
    this.networkId = networkId;
  }
}

export function isKassealNetwork(networkId: unknown): networkId is KassealNetwork {
  return networkId === 'mainnet' || networkId === 'testnet-10';
}

export function assertNetwork(networkId: unknown): asserts networkId is KassealNetwork {
  if (!isKassealNetwork(networkId)) throw new UnsupportedNetwork(String(networkId));
}

/** The contract build new launches use on a network (`BUILD_OF_NETWORK`). */
export function buildOf(networkId: KassealNetwork): string {
  assertNetwork(networkId);
  return BUILD_OF_NETWORK[networkId];
}

/**
 * The builder context of a curve preset on one of a network's contract builds (curve, pool and token templates, read
 * from the bundled artifacts). `version` is always `'v1'`; `build` defaults to the network's launch build and must be
 * one of `BUILDS_OF_NETWORK[networkId]`.
 */
export function createContext(preset: string, networkId: KassealNetwork, version: 'v1' = 'v1', build: string = buildOf(networkId)): BuilderContext {
  assertNetwork(networkId);
  if (!BUILDS_OF_NETWORK[networkId].includes(build)) throw new UnsupportedBuild(build, networkId);
  return createContextAny(preset, networkId, version, build);
}

/** The trading, liquidity and claim methods of the builder. */
export type PublicTxBuilder = Pick<KassealTxBuilder,
  | 'buildBuy' | 'buildSell' | 'buildSwap' | 'buildScriptSell' | 'buildConsolidate' | 'buildSplit' | 'buildSweep'
  | 'buildBindLp' | 'buildAddLiquidity' | 'buildRemoveLiquidity' | 'planDeposit' | 'planWithdrawal' | 'buildExactCell'
  | 'curveParams' | 'finalize' | 'estimate'>;

const PUBLIC_METHODS: readonly (keyof PublicTxBuilder)[] = Object.freeze([
  'buildBuy', 'buildSell', 'buildSwap', 'buildScriptSell', 'buildConsolidate', 'buildSplit', 'buildSweep',
  'buildBindLp', 'buildAddLiquidity', 'buildRemoveLiquidity', 'planDeposit', 'planWithdrawal', 'buildExactCell',
  'curveParams', 'finalize', 'estimate',
] as const);

export interface TxBuilderOptions extends Omit<AnyTxBuilderOptions, 'networkId' | 'presets'> {
  /** The network the transactions are for; required. */
  readonly networkId: KassealNetwork;
}

/** The asynchronous builder over your UTXO sources, for one network. */
export function createTxBuilder(options: TxBuilderOptions): PublicTxBuilder {
  assertNetwork(options.networkId);
  for (const c of options.contexts ?? []) {
    if (c.networkId !== options.networkId) throw new UnsupportedNetwork(c.networkId);
    if (!BUILDS_OF_NETWORK[options.networkId].includes(String(c.pool.revision))) throw new UnsupportedBuild(String(c.pool.revision), options.networkId);
  }
  const { presets: _ignored, ...rest } = options as AnyTxBuilderOptions;
  const inner = createTxBuilderAny({ ...rest, networkId: options.networkId });
  const out: Partial<Record<keyof PublicTxBuilder, unknown>> = {};
  for (const m of PUBLIC_METHODS) {
    const f = inner[m] as unknown;
    if (typeof f !== 'function') throw new Error(`builder method ${m} is missing`);
    out[m] = (f as (...a: unknown[]) => unknown).bind(inner);
  }
  return Object.freeze(out) as PublicTxBuilder;
}
