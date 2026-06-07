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
 * Testnet deployment, May 2026.
 *  - v1 (`0x70db8ce7…`) — initial deploy
 *  - v1 (`0x7b3f59e4…`) — strategy_registry + marketplace + reputation
 *  - v2 (`0x5da36d89…`) — operational budget (set_operational_cap +
 *    pull_operational_funds<T>) for vault-self-funding autonomy
 *  - v3 (`0xd849b7b2…`) — per-vault Walrus execution consent
 *    (set_walrus_consent + accepts_walrus_execution dynamic field)
 *
 * The active value below is the latest. Existing AgentIdentity objects
 * minted under previous package versions remain readable because the
 * upgrade kept the struct layout intact (new state lives in dynamic
 * fields).
 */
export const SYNAPSE_PACKAGE_ID =
  process.env['NEXT_PUBLIC_SYNAPSE_PACKAGE_ID'] ??
  '0xe95241a800a97841e7676437cc83c9761e6d30e42ab8bdd590d49fd40e22a797';

/** UpgradeCap object ID — kept here for traceability, not used at runtime. */
export const SYNAPSE_UPGRADE_CAP =
  '0x12d4f7b948f2433b2332b63955290ebfec5d674779fb3006c4c9ce831ad48563';

/**
 * First-version `synapse_seal` package ID — the Seal access-policy namespace
 * (`policy::seal_approve`). Empty until you publish `move/synapse_seal` and
 * set `NEXT_PUBLIC_SYNAPSE_SEAL_PACKAGE_ID`. When empty, the decrypt UI shows
 * a "Seal not configured" hint instead of attempting decryption.
 */
export const SYNAPSE_SEAL_PACKAGE_ID =
  process.env['NEXT_PUBLIC_SYNAPSE_SEAL_PACKAGE_ID'] ??
  '0x14a1cbc600affc135510237ad779f19f924dfb2a6ee068b9b85f2c59d69bc91a';

/**
 * Every package version we've ever deployed for `synapse_core`, newest
 * first. Sui events are typed by the package that originally emitted
 * them — so a Strategy published under v1 has v1-typed
 * `StrategyPublishedEvent`, and querying only the v2 type misses it.
 * Every read-side scan (marketplace, owned-vaults, audit timeline)
 * iterates this list and unions results so the dashboard surfaces
 * objects from every era.
 *
 * Append to the *front* when republishing/upgrading. Never remove
 * entries — historical events remain forever.
 */
export const SYNAPSE_PACKAGE_HISTORY: readonly string[] = [
  '0xe95241a800a97841e7676437cc83c9761e6d30e42ab8bdd590d49fd40e22a797', // v6 (strategy-agnostic attestation)
  '0x0240a49e849d2349a9ee403e6e08d897ce97c82dd0a1a9d9ebdb9ea4357de086', // v5 (royalty per-epoch cap)
  '0x85215709ab6e9db9494042a1405d75c942a3f827b2750e1be58bcd17b34a1534', // v4 (enclave attestation)
  '0xd849b7b281cdc030daf4e2269a36e85e285edd44849b481eb6da49aed1978f01', // v3 (walrus consent)
  '0x5da36d892956a4659415e245126a3964dd5aa6cf19ec2fdf6332bf828a4c58ed', // v2 (operational budget)
  '0x7b3f59e42edbf2189df644e63162d0b9a2c2984755bab9d3e9557c4ddd4aa67c', // v1 (marketplace + reputation)
];

/** Registered testnet `Enclave<DecisionEnclave>` — prefill for hosted runtime UI. */
export const SYNAPSE_TESTNET_ENCLAVE_OBJECT_ID =
  '0x2e170c4465913426e8a1a934fac1cc93b863dd28205778bf2d3cff11deeaf4be';

/**
 * HTTP base URL for Synapse's shared testnet decision enclave (Path A dev box).
 * Override via `NEXT_PUBLIC_SYNAPSE_TESTNET_ENCLAVE_URL` when the endpoint moves.
 */
export const SYNAPSE_TESTNET_ENCLAVE_URL =
  process.env['NEXT_PUBLIC_SYNAPSE_TESTNET_ENCLAVE_URL'] ??
  'http://54.166.136.55:3000';

/** Deploy + on-chain registration guide for self-hosted Nautilus enclaves. */
export const SYNAPSE_ENCLAVE_DOCS_URL =
  'https://github.com/SuyashAlphaC/Synapse/blob/main/enclave/README.md';

/**
 * MemWal Move contract IDs (per network). Sourced from
 * https://docs.memwal.ai/contract/overview. The dashboard uses these
 * to call `account::add_delegate_key` at mint time, registering the
 * vault's freshly-generated delegate against the user's MemWal
 * account so the runtime can recall/remember without further setup.
 */
export const MEMWAL_PACKAGE_ID =
  NETWORK === 'mainnet'
    ? '0xcee7a6fd8de52ce645c38332bde23d4a30fd9426bc4681409733dd50958a24c6'
    : '0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6';

export const MEMWAL_REGISTRY_ID =
  NETWORK === 'mainnet'
    ? '0x0da982cefa26864ae834a8a0504b904233d49e20fcc17c373c8bed99c75a7edd'
    : '0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437';

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
  packageId: string = SYNAPSE_PACKAGE_ID,
): `${string}::${string}::${string}` {
  return `${packageId}::${module}::${fn}` as `${string}::${string}::${string}`;
}
