/**
 * Networks, contract builds and API endpoints of the public SDK, and the network-explicit wrappers of the context and
 * builder factories.
 */
import { createContext as createContextAny, type BuilderContext } from '../../txbuilder/src/cells.ts';
import { createTxBuilder as createTxBuilderAny, type KassealTxBuilder, type TxBuilderOptions as AnyTxBuilderOptions } from '../../txbuilder/src/builder.ts';

/** The networks this package builds for. */
export type KassealNetwork = 'mainnet' | 'testnet-10';

export const NETWORKS: readonly KassealNetwork[] = Object.freeze(['mainnet', 'testnet-10'] as const);

/** The contract build each network uses. */
export const BUILD_OF_NETWORK: Readonly<Record<KassealNetwork, string>> = Object.freeze({
  mainnet: 'v1-kasseal-mainnet-2',
  'testnet-10': 'v1-kasseal-mainnet-2-tn10',
});

/** The contract builds bundled with this package. */
export const SUPPORTED_BUILDS: readonly string[] = Object.freeze([BUILD_OF_NETWORK.mainnet, BUILD_OF_NETWORK['testnet-10']]);

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

/** A contract build that is not the given network's. */
export class UnsupportedBuild extends Error {
  readonly build: string;
  readonly networkId: string;
  constructor(build: string, networkId: string) {
    super(`contract build ${JSON.stringify(build)} is not the ${networkId} build (${BUILD_OF_NETWORK[networkId as KassealNetwork] ?? 'none'})`);
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

/** The contract build of a network. */
export function buildOf(networkId: KassealNetwork): string {
  assertNetwork(networkId);
  return BUILD_OF_NETWORK[networkId];
}

/**
 * The builder context of a curve preset on a network's contract build (curve, pool and token templates, read from the
 * bundled artifacts). `version` is always `'v1'`; `build` defaults to the network's build and must be it.
 */
export function createContext(preset: string, networkId: KassealNetwork, version: 'v1' = 'v1', build: string = buildOf(networkId)): BuilderContext {
  assertNetwork(networkId);
  if (build !== BUILD_OF_NETWORK[networkId]) throw new UnsupportedBuild(build, networkId);
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
    if (c.pool.revision !== BUILD_OF_NETWORK[options.networkId]) throw new UnsupportedBuild(String(c.pool.revision), options.networkId);
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
