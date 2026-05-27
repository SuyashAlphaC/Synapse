#!/usr/bin/env node
/**
 * Multi-agent flagship: record a cross-agent memory read on-chain.
 *
 *   synapse-cross-agent-read \
 *     --reader 0x<vaultA> --writer 0x<vaultB> \
 *     --session-key-path ./vaultA.key \
 *     [--memory-id <id>] [--query "shared strategy signal"]
 *
 * Two vaults that share a MemWal namespace can read each other's memory.
 * This script demonstrates that end-to-end:
 *   1. (default) recall a memory from the shared namespace with the READER's
 *      delegate — i.e. actually read a memory the WRITER persisted; or
 *      `--memory-id` to attest a specific memory directly.
 *   2. submit `coordination::record_cross_agent_read(reader, writer, id)`,
 *      signed by the reader's session key. The Move VM enforces shared
 *      namespace + writer-not-revoked, then emits `CrossAgentReadEvent` —
 *      which the indexer + dashboard audit timeline render as an
 *      agent-to-agent edge.
 *
 * Reader session key + MemWal delegate come from the same `.key` file the
 * dashboard downloads at mint. Needs gas on the reader's session address.
 */
import { Transaction } from '@mysten/sui/transactions';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { createMemWalClient, recall } from '@synapse-core/memwal-bridge';
import { loadAgentState } from '../state.js';
import { loadSessionKeypair, loadMemwalDelegateFromKeyFile } from '../keypair.js';
import { createLogger } from '../logger.js';

const logger = createLogger('synapse-cross-agent-read');

interface CliArgs {
  reader?: string;
  writer?: string;
  sessionKeyPath?: string;
  memoryId?: string;
  query: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = process.env;

  const reader = required(args.reader ?? env.SYNAPSE_READER_VAULT, '--reader');
  const writer = required(args.writer ?? env.SYNAPSE_WRITER_VAULT, '--writer');
  const packageId = required(env.SYNAPSE_PACKAGE_ID, 'SYNAPSE_PACKAGE_ID');
  const packageHistory = env.SYNAPSE_PACKAGE_HISTORY
    ? env.SYNAPSE_PACKAGE_HISTORY.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : [packageId];
  const fullnodeUrl = env.SYNAPSE_FULLNODE_URL ?? getJsonRpcFullnodeUrl('testnet');
  const network = (env.SYNAPSE_WALRUS_NETWORK ?? 'testnet') === 'mainnet' ? 'mainnet' : 'testnet';

  const sessionKeyArgs = {
    ...(args.sessionKeyPath ? { sessionKeyPath: args.sessionKeyPath } : {}),
    ...(env.SYNAPSE_SESSION_KEY ? { sessionKeyEnv: env.SYNAPSE_SESSION_KEY } : {}),
  };
  const signer = await loadSessionKeypair(sessionKeyArgs);
  const client = new SuiJsonRpcClient({ url: fullnodeUrl, network });

  // Resolve the memory id to attest: an explicit override, or a live recall
  // from the shared namespace using the reader's delegate.
  const memoryId = args.memoryId
    ? args.memoryId
    : await recallSharedMemory({ client, packageId, packageHistory, reader, network, query: args.query, sessionKeyArgs });

  logger.info({ reader, writer, memoryId }, 'recording cross-agent read');

  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::coordination::record_cross_agent_read`,
    arguments: [tx.object(reader), tx.object(writer), tx.pure.vector('u8', new TextEncoder().encode(memoryId))],
  });

  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer,
    options: { showEvents: true, showEffects: true },
  });
  await client.waitForTransaction({ digest: result.digest });

  const status = result.effects?.status.status;
  const event = (result.events ?? []).find((e) => e.type.endsWith('::coordination::CrossAgentReadEvent'));
  if (status !== 'success' || !event) {
    logger.error({ digest: result.digest, status }, 'cross-agent read did not emit CrossAgentReadEvent');
    process.exitCode = 1;
    return;
  }
  logger.info(
    { digest: result.digest, event: event.parsedJson },
    'CrossAgentReadEvent emitted — shared-context edge recorded on-chain',
  );
}

async function recallSharedMemory(args: {
  client: SuiJsonRpcClient;
  packageId: string;
  packageHistory: readonly string[];
  reader: string;
  network: 'testnet' | 'mainnet';
  query: string;
  sessionKeyArgs: { sessionKeyPath?: string; sessionKeyEnv?: string };
}): Promise<string> {
  const delegateKeyHex = await loadMemwalDelegateFromKeyFile(args.sessionKeyArgs);
  if (!delegateKeyHex) {
    throw new Error(
      'No MemWal delegate found. Pass --memory-id <id> to attest a specific memory, ' +
        'or use a .key file that bundles the MemWal delegate.',
    );
  }
  const state = await loadAgentState({
    client: args.client,
    agentId: args.reader,
    packageId: args.packageId,
    packageHistory: args.packageHistory,
  });
  const relayerUrl = args.network === 'testnet' ? 'https://relayer.staging.memwal.ai' : undefined;
  const memwal = createMemWalClient({
    identity: state.identity,
    credentials: { delegateKeyHex, ...(relayerUrl ? { serverUrl: relayerUrl } : {}) },
  });
  const result = await recall({ client: memwal, query: args.query, limit: 1 });
  const top = result.results[0];
  if (!top) {
    throw new Error(
      `No memory found in the shared namespace for query "${args.query}". ` +
        'Have the writer vault persist a memory first, or pass --memory-id.',
    );
  }
  return top.blob_id;
}

function parseArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = { query: 'shared strategy signal' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--reader' && next) (parsed.reader = next), i++;
    else if (arg === '--writer' && next) (parsed.writer = next), i++;
    else if (arg === '--session-key-path' && next) (parsed.sessionKeyPath = next), i++;
    else if (arg === '--memory-id' && next) (parsed.memoryId = next), i++;
    else if (arg === '--query' && next) (parsed.query = next), i++;
  }
  return parsed;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'cross-agent read failed');
  process.exitCode = 1;
});
