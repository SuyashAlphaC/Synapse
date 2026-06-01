#!/usr/bin/env node
/**
 * Indexer service entrypoint.
 *
 * Boots a `SynapseIndexer` against the configured Sui network + package ID,
 * starts the polling loop, and exposes the GraphQL endpoint on `$PORT`.
 *
 * Required env:
 *   SYNAPSE_PACKAGE_ID    deployed synapse_core package
 *   SYNAPSE_NETWORK       mainnet | testnet | devnet | localnet
 *
 * Optional:
 *   PORT                  default 4000
 *   HOST                  default 127.0.0.1 (set 0.0.0.0 to expose publicly)
 *   SYNAPSE_POLL_MS       default 2000
 *   SYNAPSE_PAGE_SIZE     default 50
 */

import { SynapseIndexer, startServer } from '../index.js';

type Network = 'mainnet' | 'testnet' | 'devnet' | 'localnet';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[synapse-indexer] missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

function parseNetwork(value: string | undefined): Network {
  if (value === 'mainnet' || value === 'testnet' || value === 'devnet' || value === 'localnet') {
    return value;
  }
  console.error(`[synapse-indexer] invalid SYNAPSE_NETWORK: ${value ?? '(empty)'}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const packageId = required('SYNAPSE_PACKAGE_ID');
  const network = parseNetwork(process.env['SYNAPSE_NETWORK']);
  const port = Number(process.env['PORT'] ?? 4000);
  const host = process.env['HOST'] ?? '127.0.0.1';
  const pollIntervalMs = Number(process.env['SYNAPSE_POLL_MS'] ?? 2000);
  const pageSize = Number(process.env['SYNAPSE_PAGE_SIZE'] ?? 50);

  const indexer = new SynapseIndexer({
    network,
    packageId,
    pollIntervalMs,
    pageSize,
  });
  indexer.start();

  const server = await startServer({ indexer, port, host });

  const shutdown = async (signal: string) => {
    console.log(`[synapse-indexer] received ${signal}, shutting down…`);
    indexer.stop();
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('[synapse-indexer] failed to start:', err);
  process.exitCode = 1;
});
