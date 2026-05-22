#!/usr/bin/env node
/**
 * Headless runtime entrypoint.
 *
 *   synapse-vault-runtime [--once]
 *                         [--secrets-dir /run/secrets]
 *                         [--agent-id 0x…] [--package-id 0x…]
 *                         [--session-key-path /path/to/.key]
 *                         [--memwal-delegate <hex>]
 *
 * - Default: long-lived loop, one tick every SYNAPSE_TICK_INTERVAL_MS.
 * - `--once`: a single tick + exit (Fargate / cron model).
 * - `--secrets-dir`: resolve session key + MemWal delegate from files
 *   under that directory (Docker/Fly/Railway secret mount convention).
 *   No flag = env vars (backward compat with existing AWS deploys).
 *
 * Graceful shutdown: SIGINT/SIGTERM finishes the in-flight tick before
 * exit so a container restart never leaves a half-signed PTB behind.
 */
import { VaultRuntime } from '../runtime.js';
import { bootstrapConfig } from '../bootstrap.js';
import { createLogger } from '../logger.js';
import { sendAlert } from '../alerts.js';

const logger = createLogger('synapse-vault-runtime-cli');

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const overrides: { agentId?: string; packageId?: string; sessionKeyPath?: string } = {};
  if (args.agentId) overrides.agentId = args.agentId;
  if (args.packageId) overrides.packageId = args.packageId;
  if (args.sessionKeyPath) overrides.sessionKeyPath = args.sessionKeyPath;

  const env = { ...process.env };
  if (args.memwalDelegate) env.MEMWAL_DELEGATE_KEY = args.memwalDelegate;

  const bootstrapOpts: Parameters<typeof bootstrapConfig>[0] = { env, overrides };
  if (args.secretsDir) bootstrapOpts.secretsDir = args.secretsDir;

  const { config, sessionKeySource, memwalDelegateSource } = await bootstrapConfig(bootstrapOpts);

  logger.info(
    {
      agentId: config.agentId,
      packageId: config.packageId,
      walrusNetwork: config.walrusNetwork,
      tickIntervalMs: config.tickIntervalMs ?? 600_000,
      sessionKeySource,
      memwalDelegateSource,
      mode: args.once ? 'once' : 'continuous',
    },
    'runtime starting',
  );

  const runtime = new VaultRuntime(config);

  if (args.once) {
    const receipt = await runtime.tickOnce();
    logger.info(
      receipt
        ? {
            txDigest: receipt.txDigest,
            walrusBlobId: receipt.reportWalrusBlobId,
            artifactSlot: receipt.artifactSlot.toString(),
            planId: receipt.planId,
          }
        : { noop: true },
      'runtime once completed',
    );
    return;
  }

  runtime.start();
  await sendAlert({
    event: 'runtime_started',
    agentId: config.agentId,
    detail: `Synapse runtime online (mode=continuous, network=${config.walrusNetwork})`,
  });

  // Coalesce repeated signals so a quick double-Ctrl-C still finishes
  // the in-flight tick exactly once.
  let stopping: Promise<void> | null = null;
  const stop = (signal: string): Promise<void> => {
    if (stopping) return stopping;
    logger.info({ signal }, 'shutdown requested; waiting for in-flight tick to finish');
    stopping = runtime
      .stop()
      .then(() => {
        logger.info({ signal }, 'runtime stopped cleanly');
      })
      .catch((err) => {
        logger.error({ err }, 'runtime shutdown errored');
        process.exitCode = 1;
      });
    return stopping;
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));

  // Periodic heartbeat so operators (and the no-tick alerter) can tell
  // the loop is alive even between long tick intervals.
  const heartbeatMs = Math.min(60_000, (config.tickIntervalMs ?? 600_000) / 2);
  const heartbeat = setInterval(() => {
    logger.info({ heartbeat: true, agentId: config.agentId }, 'runtime heartbeat');
  }, heartbeatMs);
  heartbeat.unref();
}

interface CliArgs {
  once: boolean;
  agentId?: string;
  packageId?: string;
  sessionKeyPath?: string;
  memwalDelegate?: string;
  secretsDir?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = { once: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--once') {
      parsed.once = true;
      continue;
    }
    const next = argv[i + 1];
    if (!next) throw new Error(`${arg} requires a value`);
    if (arg === '--agent-id') parsed.agentId = next;
    else if (arg === '--package-id') parsed.packageId = next;
    else if (arg === '--session-key-path') parsed.sessionKeyPath = next;
    else if (arg === '--memwal-delegate') parsed.memwalDelegate = next;
    else if (arg === '--secrets-dir') parsed.secretsDir = next;
    else throw new Error(`Unknown argument ${arg}`);
    i += 1;
  }
  return parsed;
}

main().catch((err: unknown) => {
  logger.error({ err }, 'runtime failed');
  void sendAlert({
    event: 'runtime_failed',
    detail: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 1;
});
