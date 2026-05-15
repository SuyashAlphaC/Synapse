import { getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import type { Strategy } from '../types.js';
import { conservativeRebalancer } from '../strategies/conservative-rebalancer.js';
import {
  DEEPBOOK_PACKAGE_ID_TESTNET,
  SUI_TYPE_TAG_TESTNET,
  SUI_USDC_POOL_ID_TESTNET,
  USDC_TYPE_TAG_TESTNET,
} from './deepbook.js';

export interface RuntimeConfig {
  /** Deployed synapse_core package ID. */
  packageId: string;
  /** AgentIdentity object ID this runtime operates. */
  agentId: string;
  /** Sui RPC fullnode URL. */
  fullnodeUrl: string;
  /** Walrus network ('testnet' or 'mainnet'). */
  walrusNetwork: 'testnet' | 'mainnet';
  /** Strategy to run. */
  strategy: Strategy;
  /** Path to the session keypair file (base64 32-byte secret). */
  sessionKeyPath: string;
  /** MemWal credentials. If absent, runtime runs without memory recall. */
  memwal?: { delegateKeyHex: string; relayerUrl?: string };
  /** Tick interval in milliseconds. Default 600_000 (10 min). */
  tickIntervalMs?: number;
  /** Max consecutive tick failures before exit. Default 5. */
  maxConsecutiveFailures?: number;
  /** Walrus storage epochs for audit reports. Default 5. */
  walrusEpochs?: number;
  /**
   * Optional JSON override mapping `Strategy` object IDs to runtime slugs.
   * Wired through `SYNAPSE_STRATEGY_REGISTRY_JSON`. Lets operators teach the
   * runtime about newly-published strategies without recompiling.
   */
  strategyRegistryJson?: string;
}

export function loadFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const packageId = required(env.SYNAPSE_PACKAGE_ID, 'SYNAPSE_PACKAGE_ID');
  const agentId = required(env.SYNAPSE_AGENT_ID, 'SYNAPSE_AGENT_ID');
  const sessionKeyPath = required(env.SYNAPSE_SESSION_KEY_PATH, 'SYNAPSE_SESSION_KEY_PATH');
  const fullnodeUrl = env.SYNAPSE_FULLNODE_URL ?? getJsonRpcFullnodeUrl('testnet');
  const walrusNetwork = parseWalrusNetwork(env.SYNAPSE_WALRUS_NETWORK);

  const delegateKey = env.MEMWAL_DELEGATE_KEY ?? env.SYNAPSE_MEMWAL_DELEGATE_KEY;
  const relayerUrl = env.MEMWAL_RELAYER_URL ?? env.SYNAPSE_MEMWAL_RELAYER_URL;
  const memwal =
    delegateKey !== undefined
      ? {
          delegateKeyHex: required(delegateKey, 'MEMWAL_DELEGATE_KEY'),
          ...(relayerUrl !== undefined ? { relayerUrl } : {}),
        }
      : undefined;

  return {
    packageId,
    agentId,
    fullnodeUrl,
    walrusNetwork,
    sessionKeyPath,
    strategy: conservativeRebalancer({
      baseTypeTag: SUI_TYPE_TAG_TESTNET,
      baseSymbol: 'SUI',
      quoteTypeTag: USDC_TYPE_TAG_TESTNET,
      quoteSymbol: 'DBUSDC',
      targetBaseWeight: numberFromEnv(env.SYNAPSE_TARGET_BASE_WEIGHT, 0.5),
      driftThreshold: numberFromEnv(env.SYNAPSE_DRIFT_THRESHOLD, 0.05),
      poolId: env.SYNAPSE_DEEPBOOK_POOL_ID ?? SUI_USDC_POOL_ID_TESTNET,
      slippageTolerance: numberFromEnv(env.SYNAPSE_SLIPPAGE_TOLERANCE, 0.005),
    }),
    ...(memwal ? { memwal } : {}),
    ...(env.SYNAPSE_TICK_INTERVAL_MS
      ? { tickIntervalMs: Number(env.SYNAPSE_TICK_INTERVAL_MS) }
      : {}),
    ...(env.SYNAPSE_MAX_FAILURES ? { maxConsecutiveFailures: Number(env.SYNAPSE_MAX_FAILURES) } : {}),
    ...(env.SYNAPSE_WALRUS_EPOCHS ? { walrusEpochs: Number(env.SYNAPSE_WALRUS_EPOCHS) } : {}),
    ...(env.SYNAPSE_STRATEGY_REGISTRY_JSON
      ? { strategyRegistryJson: env.SYNAPSE_STRATEGY_REGISTRY_JSON }
      : {}),
  };
}

export function deepbookPackageForRuntime(_config: RuntimeConfig): string {
  return DEEPBOOK_PACKAGE_ID_TESTNET;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseWalrusNetwork(value: string | undefined): 'testnet' | 'mainnet' {
  if (value === undefined || value === 'testnet') return 'testnet';
  if (value === 'mainnet') return 'mainnet';
  throw new Error(`SYNAPSE_WALRUS_NETWORK must be "testnet" or "mainnet"; got ${value}`);
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric env value: ${value}`);
  return parsed;
}
