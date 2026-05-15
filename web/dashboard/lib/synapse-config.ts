/**
 * Live deployment configuration for the Synapse Vault dashboard.
 *
 * Updated whenever the Move package is republished. Re-export this constant
 * from a single place so every PTB builder and event subscriber agrees on
 * the package ID and network.
 */

import { getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';

export type Network = 'mainnet' | 'testnet' | 'devnet' | 'localnet';

/**
 * Active network the dashboard targets. Override at runtime via
 * `NEXT_PUBLIC_SYNAPSE_NETWORK=mainnet` once mainnet is published.
 */
export const NETWORK = (process.env['NEXT_PUBLIC_SYNAPSE_NETWORK'] as Network) ?? 'testnet';

/**
 * Sui Move package ID for `synapse_core`.
 * Testnet deployment, May 2026 — marketplace + reputation revision.
 */
export const SYNAPSE_PACKAGE_ID =
  process.env['NEXT_PUBLIC_SYNAPSE_PACKAGE_ID'] ??
  '0x7b3f59e42edbf2189df644e63162d0b9a2c2984755bab9d3e9557c4ddd4aa67c';

/** UpgradeCap object ID — kept here for traceability, not used at runtime. */
export const SYNAPSE_UPGRADE_CAP =
  '0x12d4f7b948f2433b2332b63955290ebfec5d674779fb3006c4c9ce831ad48563';

/**
 * Optional hosted indexer GraphQL endpoint. When set, the audit timeline +
 * inspector prefer it over direct `queryEvents` calls — the GraphQL path
 * paginates better and supports cross-agent joins. When unset (default),
 * the dashboard reads events directly from the Sui fullnode and everything
 * still works.
 *
 * Configure via `NEXT_PUBLIC_SYNAPSE_INDEXER_URL=https://…/graphql` in
 * `.env.local`.
 */
export const SYNAPSE_INDEXER_URL: string | null =
  process.env['NEXT_PUBLIC_SYNAPSE_INDEXER_URL'] ?? null;

/**
 * Default Sui full-node URL for the active network. Use this when
 * constructing a standalone `SuiClient` outside of @mysten/dapp-kit
 * (e.g., in event indexer logic).
 */
export const SUI_FULLNODE_URL = getJsonRpcFullnodeUrl(NETWORK);

/**
 * Sui explorer base URL for transaction + object links displayed in the UI.
 */
export const SUI_EXPLORER_BASE =
  NETWORK === 'mainnet'
    ? 'https://suiscan.xyz/mainnet'
    : NETWORK === 'testnet'
      ? 'https://suiscan.xyz/testnet'
      : `https://suiscan.xyz/${NETWORK}`;

export function explorerTxUrl(digest: string): string {
  return `${SUI_EXPLORER_BASE}/tx/${digest}`;
}

export function explorerObjectUrl(id: string): string {
  return `${SUI_EXPLORER_BASE}/object/${id}`;
}

export function explorerAddressUrl(addr: string): string {
  return `${SUI_EXPLORER_BASE}/address/${addr}`;
}

/**
 * Fully-qualified `target` for a Move call. Use everywhere we construct PTBs.
 */
export function synapseTarget(
  module:
    | 'agent'
    | 'wallet'
    | 'artifacts'
    | 'coordination'
    | 'messaging_bridge'
    | 'attestation'
    | 'deepbook_adapter'
    | 'strategy_registry',
  fn: string,
): `${string}::${string}::${string}` {
  return `${SYNAPSE_PACKAGE_ID}::${module}::${fn}` as `${string}::${string}::${string}`;
}
