/**
 * Per-network configuration for Synapse Core clients. Values reflect the
 * official Mysten Labs / Walrus / MemWal service URLs as of May 2026.
 *
 * Sources:
 *   - Sui fullnode URLs: https://docs.sui.io/guides/developer/getting-started/connect
 *   - Walrus aggregators: https://docs.wal.app/docs/system-overview/public-aggregators-and-publishers
 *   - MemWal relayer: https://docs.memwal.ai/
 */

import { getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import type { SuiNetwork, SynapseNetworkConfig } from './types.js';

/**
 * Build a default configuration for the given network. Callers should
 * override `synapseCorePackageId` once the Move package is deployed.
 */
export function defaultNetworkConfig(network: SuiNetwork): SynapseNetworkConfig {
  switch (network) {
    case 'mainnet':
      return {
        network,
        synapseCorePackageId: '0x0',
        fullnodeUrl: getJsonRpcFullnodeUrl('mainnet'),
        walrusAggregatorUrl: 'https://aggregator.walrus-mainnet.walrus.space',
        walrusPublisherUrl: 'https://publisher.walrus-mainnet.walrus.space',
        memwalRelayerUrl: 'https://relayer.memwal.ai',
      };
    case 'testnet':
      return {
        network,
        synapseCorePackageId: '0x0',
        fullnodeUrl: getJsonRpcFullnodeUrl('testnet'),
        walrusAggregatorUrl: 'https://aggregator.walrus-testnet.walrus.space',
        walrusPublisherUrl: 'https://publisher.walrus-testnet.walrus.space',
        memwalRelayerUrl: 'https://relayer.memwal.ai',
      };
    case 'devnet':
      return {
        network,
        synapseCorePackageId: '0x0',
        fullnodeUrl: getJsonRpcFullnodeUrl('devnet'),
        walrusAggregatorUrl: 'https://aggregator.walrus-testnet.walrus.space',
        walrusPublisherUrl: 'https://publisher.walrus-testnet.walrus.space',
        memwalRelayerUrl: 'https://relayer.memwal.ai',
      };
    case 'localnet':
      return {
        network,
        synapseCorePackageId: '0x0',
        fullnodeUrl: getJsonRpcFullnodeUrl('localnet'),
        walrusAggregatorUrl: 'http://127.0.0.1:31415',
        walrusPublisherUrl: 'http://127.0.0.1:31416',
        memwalRelayerUrl: 'http://127.0.0.1:8080',
      };
  }
}

/**
 * Fully-qualified Move module identifiers under the `synapse_core` package.
 * Use these constants when constructing PTB `moveCall` targets so callers
 * don't need to hard-code strings.
 */
export const SYNAPSE_MODULES = {
  agent: 'agent',
  wallet: 'wallet',
  artifacts: 'artifacts',
  coordination: 'coordination',
  messagingBridge: 'messaging_bridge',
  attestation: 'attestation',
  deepbookAdapter: 'deepbook_adapter',
  strategyRegistry: 'strategy_registry',
  decisionAttestation: 'decision_attestation',
} as const;

export type SynapseModuleKey = keyof typeof SYNAPSE_MODULES;

/** Build a `package::module::function` target string for `tx.moveCall`. */
export function target(
  packageId: string,
  module: SynapseModuleKey,
  fn: string,
): `${string}::${string}::${string}` {
  // Guard the unconfigured default. The network configs ship `0x0` until the
  // operator sets a real deployed package; without this, every moveCall would
  // silently build `0x0::…` and fail opaquely at submit time.
  if (!packageId || /^0x0+$/.test(packageId)) {
    throw new Error(
      `Synapse package ID is not configured (got "${packageId}"). Set synapseCorePackageId in your network config before building transactions.`,
    );
  }
  return `${packageId}::${SYNAPSE_MODULES[module]}::${fn}` as `${string}::${string}::${string}`;
}
