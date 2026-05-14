import { setTimeout as delay } from 'node:timers/promises';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import type { SuiTransactionBlockResponse } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { ActionKind, publishArtifactCall, target } from '@synapse-core/client';
import type { AuditReport, ExecutionReceipt, HoldingSnapshot, StrategyInput } from '../types.js';
import { buildRebalancePTB, makeExecutedTrade } from '../executor.js';
import { renderReport } from '../report.js';
import { loadAgentState } from './state.js';
import { loadMarketSnapshot, requiredPoolsForStrategy } from './market.js';
import {
  createRuntimeMemWalClient,
  emptyStrategyMemory,
  namespaceFromIdentity,
  recallStrategyMemory,
  rememberStrategyOutcome,
} from './memory.js';
import { uploadReportBlob, parseArtifactSlot } from './publisher.js';
import { deepbookSwap, DEEPBOOK_PACKAGE_ID_TESTNET } from './deepbook.js';
import { loadSessionKeypair } from './keypair.js';
import { createLogger, type VaultLogger } from './logger.js';
import type { RuntimeConfig } from './config.js';

export type { RuntimeConfig } from './config.js';

const DEFAULT_TICK_INTERVAL_MS = 600_000;
const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_WALRUS_EPOCHS = 5;

/**
 * Optional dependency overrides for testing. Production callers leave this
 * undefined; tests inject fake clients and loggers via `vi.mock` on the
 * sibling modules plus an injected `SuiJsonRpcClient` here.
 */
export interface VaultRuntimeDeps {
  /** Replace the auto-constructed `SuiJsonRpcClient`. */
  client?: SuiJsonRpcClient;
  /** Replace the auto-constructed logger. Useful to silence test output. */
  logger?: VaultLogger;
}

export class VaultRuntime {
  readonly #config: RuntimeConfig;
  readonly #client: SuiJsonRpcClient;
  readonly #logger: VaultLogger;
  #stopping = false;
  #loop: Promise<void> | null = null;
  #activeTick: Promise<ExecutionReceipt | null> | null = null;
  #consecutiveFailures = 0;

  constructor(config: RuntimeConfig, deps: VaultRuntimeDeps = {}) {
    this.#config = config;
    this.#client =
      deps.client ??
      new SuiJsonRpcClient({
        url: config.fullnodeUrl,
        network: config.walrusNetwork === 'mainnet' ? 'mainnet' : 'testnet',
      });
    this.#logger = deps.logger ?? createLogger();
  }

  start(): void {
    if (this.#loop) return;
    this.#stopping = false;
    this.#loop = this.#runLoop();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await this.#activeTick;
    await this.#loop;
    this.#loop = null;
  }

  async tickOnce(): Promise<ExecutionReceipt | null> {
    this.#activeTick = this.#tickOnceInner();
    try {
      const receipt = await this.#activeTick;
      this.#consecutiveFailures = 0;
      return receipt;
    } catch (err) {
      this.#consecutiveFailures += 1;
      this.#logger.error(
        { err, consecutiveFailures: this.#consecutiveFailures },
        'vault runtime tick failed',
      );
      if (this.#consecutiveFailures >= (this.#config.maxConsecutiveFailures ?? DEFAULT_MAX_FAILURES)) {
        process.exitCode = 1;
        this.#stopping = true;
      }
      throw err;
    } finally {
      this.#activeTick = null;
    }
  }

  async #runLoop(): Promise<void> {
    while (!this.#stopping) {
      try {
        await this.tickOnce();
      } catch {
        if (this.#stopping) break;
      }
      if (!this.#stopping) {
        await delay(this.#config.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
      }
    }
  }

  async #tickOnceInner(): Promise<ExecutionReceipt | null> {
    const signer = await loadSessionKeypair({ sessionKeyPath: this.#config.sessionKeyPath });
    const systemState = await this.#client.getLatestSuiSystemState();
    const currentEpoch = BigInt(systemState.epoch);
    const agent = await loadAgentState({
      client: this.#client,
      agentId: this.#config.agentId,
      packageId: this.#config.packageId,
    });

    if (agent.identity.revoked || currentEpoch >= agent.identity.expiryEpoch) {
      this.#logger.info(
        {
          agentId: this.#config.agentId,
          revoked: agent.identity.revoked,
          currentEpoch: currentEpoch.toString(),
          expiryEpoch: agent.identity.expiryEpoch.toString(),
        },
        'vault inactive',
      );
      return null;
    }

    const market = await loadMarketSnapshot({
      client: this.#client,
      pools: requiredPoolsForStrategy(this.#config.strategy),
      senderAddress: signer.toSuiAddress(),
    });

    const holdings = priceHoldings(agent.holdings, market.prices);
    const navUsd = holdings.reduce((sum, holding) => sum + holding.valueUsd, 0);
    const namespace = namespaceFromIdentity(agent.identity);
    const memwal =
      this.#config.memwal === undefined
        ? null
        : createRuntimeMemWalClient({ identity: agent.identity, config: this.#config.memwal });
    const memory = memwal
      ? await recallStrategyMemory({
          client: memwal,
          namespace,
          strategyId: this.#config.strategy.id,
        })
      : emptyStrategyMemory();

    const input: StrategyInput = {
      vaultId: this.#config.agentId,
      holdings,
      navUsd,
      market,
      memory,
      currentEpoch,
      policy: {
        ...agent.policy,
        spendPerEpochUsd: spendCapUsd(agent.identity.spendPerEpoch, holdings),
      },
    };
    const decision = await this.#config.strategy.evaluate(input);
    const report = renderReport({
      vaultId: this.#config.agentId,
      strategyId: this.#config.strategy.id,
      strategyVersion: this.#config.strategy.version,
      epoch: currentEpoch,
      input,
      decision,
    });

    if (decision.kind === 'noop') {
      return this.#executeNoop(report, currentEpoch, signer);
    }

    const upload = await uploadReportBlob({
      suiClient: this.#client,
      walrusNetwork: this.#config.walrusNetwork,
      signer,
      report,
      epochs: this.#config.walrusEpochs ?? DEFAULT_WALRUS_EPOCHS,
    });
    const tx = new Transaction();
    buildRebalancePTB({
      tx,
      synapsePackageId: this.#config.packageId,
      vaultId: this.#config.agentId,
      plan: decision,
      report,
      reportWalrusBlobId: upload.blobId,
      deepbookPkg: DEEPBOOK_PACKAGE_ID_TESTNET,
      swap: deepbookSwap,
    });
    const result = await this.#client.signAndExecuteTransaction({
      transaction: tx,
      signer,
      options: { showEvents: true, showEffects: true },
    });
    await this.#client.waitForTransaction({ digest: result.digest });
    const trades = parseExecutedTrades(result, decision.trades);
    const receipt: ExecutionReceipt = {
      planId: decision.planId,
      txDigest: result.digest,
      trades,
      reportWalrusBlobId: upload.blobId,
      reportBlobObjectId: upload.blobObjectId,
      artifactSlot: parseArtifactSlot(result),
      epoch: currentEpoch,
      executedAt: new Date().toISOString(),
    };
    await rememberStrategyOutcome({ memwal, namespace, plan: decision, receipt });
    this.#logger.info(
      {
        txDigest: receipt.txDigest,
        walrusBlobId: receipt.reportWalrusBlobId,
        artifactSlot: receipt.artifactSlot.toString(),
        trades: receipt.trades.length,
      },
      'rebalance executed',
    );
    return receipt;
  }

  async #executeNoop(
    report: AuditReport,
    currentEpoch: bigint,
    signer: Awaited<ReturnType<typeof loadSessionKeypair>>,
  ): Promise<ExecutionReceipt> {
    const upload = await uploadReportBlob({
      suiClient: this.#client,
      walrusNetwork: this.#config.walrusNetwork,
      signer,
      report,
      epochs: this.#config.walrusEpochs ?? DEFAULT_WALRUS_EPOCHS,
    });
    const tx = new Transaction();
    publishArtifactCall(tx, this.#config.packageId, {
      agentId: this.#config.agentId,
      walrusBlobId: new TextEncoder().encode(upload.blobId),
      sha256: upload.sha256,
      mimeType: 'text/markdown',
      sizeBytes: BigInt(upload.sizeBytes),
      sealEncrypted: false,
      label: `audit-${report.planId}`,
    });
    tx.moveCall({
      target: target(this.#config.packageId, 'attestation', 'log_action'),
      arguments: [
        tx.object(this.#config.agentId),
        tx.pure.u8(ActionKind.ArtifactPublish),
        tx.pure.string(`noop ${report.planId}`),
        tx.pure.vector('u8', Array.from(report.sha256)),
      ],
    });
    const result = await this.#client.signAndExecuteTransaction({
      transaction: tx,
      signer,
      options: { showEvents: true, showEffects: true },
    });
    await this.#client.waitForTransaction({ digest: result.digest });
    const receipt: ExecutionReceipt = {
      planId: report.planId,
      txDigest: result.digest,
      trades: [],
      reportWalrusBlobId: upload.blobId,
      reportBlobObjectId: upload.blobObjectId,
      artifactSlot: parseArtifactSlot(result),
      epoch: currentEpoch,
      executedAt: new Date().toISOString(),
    };
    this.#logger.info(
      {
        txDigest: receipt.txDigest,
        walrusBlobId: receipt.reportWalrusBlobId,
        artifactSlot: receipt.artifactSlot.toString(),
      },
      'noop report published',
    );
    return receipt;
  }
}

function priceHoldings(holdings: HoldingSnapshot[], prices: Record<string, number>): HoldingSnapshot[] {
  return holdings.map((holding) => {
    const priceUsd = prices[holding.symbol] ?? prices[symbolFromTypeTag(holding.coinTypeTag)] ?? 0;
    const displayAmount = Number(holding.amount) / Math.pow(10, holding.decimals);
    return {
      ...holding,
      priceUsd,
      valueUsd: displayAmount * priceUsd,
    };
  });
}

/**
 * Convert the on-chain `spend_per_epoch` u64 into a USD-denominated cap.
 *
 * The Move VM enforces `spent_this_epoch` as a generic counter — it does not
 * tag the per-coin denomination. To render a USD value we infer the most
 * plausible denomination heuristically:
 *
 *   1. The largest-by-USD-value holding's coin type (highest-conviction signal
 *      about what the operator intends to spend in).
 *   2. Otherwise the first holding.
 *   3. Otherwise 0 (no holdings → no meaningful USD value).
 *
 * Whichever coin we pick, we apply that coin's decimal scaling and USD price.
 */
function spendCapUsd(spendPerEpoch: bigint, holdings: HoldingSnapshot[]): number {
  if (holdings.length === 0) return 0;
  const denom = holdings.reduce((best, current) =>
    current.valueUsd > best.valueUsd ? current : best,
  );
  if (denom.priceUsd <= 0) return 0;
  const scaled = Number(spendPerEpoch) / Math.pow(10, denom.decimals);
  return scaled * denom.priceUsd;
}

function parseExecutedTrades(
  tx: SuiTransactionBlockResponse,
  planned: Parameters<typeof makeExecutedTrade>[0][],
): ExecutionReceipt['trades'] {
  const outputs = (tx.events ?? [])
    .filter((event) => event.type.includes('::deepbook_adapter::SwapEvent'))
    .map((event) => {
      const parsed = event.parsedJson;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 0n;
      const output = (parsed as Record<string, unknown>).output_amount;
      if (typeof output === 'string' || typeof output === 'number') return BigInt(output);
      return 0n;
    });
  return planned.map((trade, index) => makeExecutedTrade(trade, outputs[index] ?? trade.minAmountOut));
}

function symbolFromTypeTag(typeTag: string): string {
  return typeTag.split('::').at(-1) ?? typeTag;
}
