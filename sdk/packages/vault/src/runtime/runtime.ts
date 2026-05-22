// Tiny universal `delay` — `node:timers/promises` is Node-only and
// would break the in-browser runtime build. `globalThis.setTimeout`
// works identically in Node and browsers / Web Workers.
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}
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
import { loadSessionKeypair, loadMemwalDelegateFromKeyFile } from './keypair.js';
import { createLogger, type VaultLogger } from './logger.js';
import type { RuntimeConfig } from './config.js';
import { resolveStrategyWithWalrus } from './strategy-resolver.js';
import { sendAlert } from './alerts.js';
import type { Strategy } from '../types.js';

export type { RuntimeConfig } from './config.js';

const DEFAULT_TICK_INTERVAL_MS = 600_000;
const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_WALRUS_EPOCHS = 5;
/** Trigger refuel when session SUI drops below this many MIST (0.02 SUI). */
const DEFAULT_REFUEL_THRESHOLD_MIST = 20_000_000n;
/** Default top-up size when refueling (0.05 SUI). */
const DEFAULT_REFUEL_AMOUNT_MIST = 50_000_000n;
/** Minimum positive-alpha USD to pay a royalty (avoid dust pulls). */
const ROYALTY_MIN_ALPHA_USD = 0.0001;

/**
 * Snapshot of a vault's holdings at the end of a previous tick. Used to
 * compute alpha-vs-hold the next time we tick. Kept in-memory only —
 * losing it on runtime restart just means the first post-restart tick
 * reports 0 alpha (genuinely unknown), not wrong alpha.
 */
interface PreviousTickSnapshot {
  /** Each holding's atomic amount, decimals, and coin type at end of last tick. */
  holdings: { coinTypeTag: string; amount: bigint; decimals: number; symbol: string }[];
  /** Epoch the snapshot was taken in. */
  epoch: bigint;
  /** Wall-clock timestamp for staleness logging. */
  recordedAtMs: number;
}

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
  /** Last tick's holdings, used to compute alpha vs hold on the next tick. */
  #previousTick: PreviousTickSnapshot | null = null;

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
        // Best-effort heads-up to the operator's webhook. Doesn't block
        // shutdown if the webhook is slow / unreachable.
        void sendAlert(
          {
            event: 'runtime_max_failures',
            agentId: this.#config.agentId,
            detail: `Stopped after ${this.#consecutiveFailures} consecutive failures`,
            context: { lastError: err instanceof Error ? err.message : String(err) },
          },
          { logger: this.#logger },
        );
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
    const signer = await loadSessionKeypair({
      ...(this.#config.sessionKeyPath ? { sessionKeyPath: this.#config.sessionKeyPath } : {}),
      ...(this.#config.sessionKeyEnv ? { sessionKeyEnv: this.#config.sessionKeyEnv } : {}),
    });
    const systemState = await this.#client.getLatestSuiSystemState();
    const currentEpoch = BigInt(systemState.epoch);
    const agent = await loadAgentState({
      client: this.#client,
      agentId: this.#config.agentId,
      packageId: this.#config.packageId,
      packageHistory: this.#config.packageHistory,
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

    // Auto-refuel: check the session's SUI balance and, if below the
    // configured threshold, fire a one-shot top-up PTB pulling from the
    // vault's operational budget. Lands a fresh SUI coin on the session
    // address that the NEXT tick PTB can use as gas. Failures here are
    // non-fatal — if the cap isn't set or the treasury is dry, we just
    // log and proceed; the current tick's own gas comes from whatever
    // SUI the session already holds.
    await this.#maybeRefuelSession(signer, currentEpoch);

    // Auto-detect the vault's quote token from its bag holdings so the
    // strategy resolver targets the right USDC variant (Circle, bridge,
    // DBUSDC, etc.) without operator config. Explicit env overrides
    // (SYNAPSE_QUOTE_TYPE / SYNAPSE_POOL_ID) win when set.
    const detectedQuote = agent.holdings.find(
      (h) =>
        h.coinTypeTag !== '0x2::sui::SUI' &&
        !h.coinTypeTag.endsWith('::sui::SUI'),
    );
    const overrides: { quoteTypeTag?: string; quoteSymbol?: string; poolId?: string } = {};
    if (this.#config.quoteTypeTagOverride) {
      overrides.quoteTypeTag = this.#config.quoteTypeTagOverride;
    } else if (detectedQuote) {
      overrides.quoteTypeTag = detectedQuote.coinTypeTag;
      overrides.quoteSymbol = detectedQuote.symbol;
    }
    if (this.#config.poolIdOverride) overrides.poolId = this.#config.poolIdOverride;

    // Dispatch to the correct Strategy implementation based on the vault's
    // on-chain `strategy_id`. Tries (1) hardcoded slug map, (2) Walrus
    // dynamic load when the *vault* consented at mint (or post-mint
    // toggle) AND the operator hasn't globally disabled, (3) configured
    // default as a last resort. The Walrus path hash-verifies the
    // bundle against the on-chain `code_hash` — see walrus-loader.ts.
    //
    // Trust model: the per-vault flag (`agent.acceptsWalrusExecution`)
    // is the primary gate — set by the vault OWNER. The env flag
    // (`allowWalrusStrategies`, default true) is an OPERATOR override
    // that can DISABLE Walrus loading globally, but can never ENABLE
    // it for a vault whose owner didn't consent.
    const operatorAllowed = this.#config.allowWalrusStrategies !== false;
    const walrusEnabled = agent.acceptsWalrusExecution && operatorAllowed;
    const resolution = await resolveStrategyWithWalrus({
      strategyId: agent.identity.strategyId,
      defaultStrategy: this.#config.strategy,
      ...(this.#config.strategyRegistryJson !== undefined
        ? { envOverrideJson: this.#config.strategyRegistryJson }
        : {}),
      overrides,
      ...(walrusEnabled
        ? {
            walrus: {
              enabled: true,
              client: this.#client,
              packageId: this.#config.packageId,
              network: this.#config.walrusNetwork,
            },
          }
        : {}),
    });
    if (resolution.source === 'walrus' && resolution.walrus) {
      this.#logger.info(
        {
          strategyId: agent.identity.strategyId,
          walrusBlob: resolution.walrus.sourceWalrusBlob,
          codeHashHex: resolution.walrus.codeHashHex,
          byteSize: resolution.walrus.byteSize,
          quoteTypeTag: overrides.quoteTypeTag,
          poolId: overrides.poolId,
        },
        'dispatching to Walrus-loaded marketplace strategy',
      );
    } else if (resolution.source === 'known-slug') {
      this.#logger.info(
        {
          strategyId: agent.identity.strategyId,
          slug: resolution.slug,
          quoteTypeTag: overrides.quoteTypeTag,
          poolId: overrides.poolId,
        },
        'dispatching to on-chain strategy',
      );
    } else {
      const reason =
        resolution.walrusError
          ? 'walrus strategy load failed; falling back to runtime-configured strategy'
          : agent.acceptsWalrusExecution && !operatorAllowed
            ? 'vault consented to walrus loading but operator has globally disabled it; falling back'
            : !agent.acceptsWalrusExecution
              ? 'vault owner has not consented to walrus loading; falling back to runtime-configured strategy'
              : 'unknown on-chain strategy_id; falling back to runtime-configured strategy';
      this.#logger.warn(
        {
          strategyId: agent.identity.strategyId,
          fallback: this.#config.strategy.id,
          acceptsWalrusExecution: agent.acceptsWalrusExecution,
          operatorAllowed,
          walrusError: resolution.walrusError,
        },
        reason,
      );
    }
    const activeStrategy: Strategy = resolution.strategy;

    const market = await loadMarketSnapshot({
      client: this.#client,
      pools: requiredPoolsForStrategy(activeStrategy),
      senderAddress: signer.toSuiAddress(),
    });

    const holdings = priceHoldings(agent.holdings, market.prices);
    const navUsd = holdings.reduce((sum, holding) => sum + holding.valueUsd, 0);
    const namespace = namespaceFromIdentity(agent.identity);
    // Resolve the MemWal delegate key. Order:
    //   1. Explicit env (`MEMWAL_DELEGATE_KEY` → `config.memwal.delegateKeyHex`)
    //   2. Bundled in the session .key file (new mints since the
    //      "treat delegate like session" fix)
    //   3. None → memwal disabled
    let memwalConfig = this.#config.memwal;
    if (memwalConfig === undefined) {
      const delegateFromFile = await loadMemwalDelegateFromKeyFile({
        ...(this.#config.sessionKeyPath ? { sessionKeyPath: this.#config.sessionKeyPath } : {}),
        ...(this.#config.sessionKeyEnv ? { sessionKeyEnv: this.#config.sessionKeyEnv } : {}),
      });
      if (delegateFromFile) {
        // Resolve the relayer base URL. Precedence:
        //   1. `memwalRelayerUrlOverride` — set by the in-browser
        //      runtime to a same-origin proxy path (`/api/memwal-proxy`)
        //      because the public relayer sends no CORS headers and a
        //      direct browser fetch fails with "Failed to fetch".
        //   2. Network-aware default, matching loadFromEnv (testnet →
        //      staging endpoint, mainnet → SDK default). Without a
        //      relayer URL the file-bundled delegate would sign API
        //      calls for the WRONG relayer and quietly fail every
        //      recall/remember on testnet.
        const defaultRelayerUrl =
          this.#config.memwalRelayerUrlOverride ??
          (this.#config.walrusNetwork === 'testnet'
            ? 'https://relayer.staging.memwal.ai'
            : undefined);
        memwalConfig = {
          delegateKeyHex: delegateFromFile,
          ...(defaultRelayerUrl !== undefined ? { relayerUrl: defaultRelayerUrl } : {}),
        };
      }
    }
    const memwal =
      memwalConfig === undefined
        ? null
        : createRuntimeMemWalClient({ identity: agent.identity, config: memwalConfig });
    const memory = memwal
      ? await recallStrategyMemory({
          client: memwal,
          namespace,
          strategyId: activeStrategy.id,
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
    const decision = await activeStrategy.evaluate(input);
    const report = renderReport({
      vaultId: this.#config.agentId,
      strategyId: activeStrategy.id,
      strategyVersion: activeStrategy.version,
      epoch: currentEpoch,
      input,
      decision,
    });

    // Ask the strategy to declare any per-tick memory updates (counters,
    // facts) it wants the runtime to persist. The strategy stays a pure
    // function of (input, decision); the runtime owns the side effect of
    // writing to MemWal.
    const memoryWrite =
      typeof activeStrategy.prepareMemoryWrite === 'function'
        ? await activeStrategy.prepareMemoryWrite({ input, decision })
        : null;

    // Compute realized alpha vs hold using last tick's snapshot. Positive
    // alpha means the strategy outperformed a do-nothing baseline; that's
    // what we record on-chain and what we pay royalty on.
    const alpha = this.#computeAlpha(holdings, market.prices);
    const royaltyMist = this.#computeRoyaltyMist(alpha, market.prices, activeStrategy);

    if (decision.kind === 'noop') {
      const receipt = await this.#executeNoop(
        report,
        currentEpoch,
        signer,
        agent.identity.strategyId,
        alpha,
        royaltyMist,
      );
      // Persist this tick's outcome + strategy memory updates so the next
      // tick can recover counters/facts. Fires on every tick (noop AND
      // rebalance) so stateful strategies advance every iteration.
      await rememberStrategyOutcome({
        memwal,
        namespace,
        decision,
        receipt,
        memoryWrite,
      });
      this.#savePreviousTick(holdings, currentEpoch);
      return receipt;
    }

    // Try to upload the rationale to Walrus, degrade gracefully if no WAL.
    // The rebalance trade itself does NOT require Walrus — the on-chain
    // attestation::log_action + record_tick_performance calls still land
    // and capture the audit trail. The rationale blob is fetchable
    // metadata; missing it doesn't change what the agent actually did.
    let upload: Awaited<ReturnType<typeof uploadReportBlob>> | null = null;
    try {
      upload = await uploadReportBlob({
        suiClient: this.#client,
        walrusNetwork: this.#config.walrusNetwork,
        signer,
        report,
        epochs: this.#config.walrusEpochs ?? DEFAULT_WALRUS_EPOCHS,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#logger.warn(
        { err: message, hint: walrusFailureHint(message) },
        'walrus upload failed; proceeding with rebalance + on-chain audit only',
      );
    }
    const tx = new Transaction();
    buildRebalancePTB({
      tx,
      synapsePackageId: this.#config.packageId,
      vaultId: this.#config.agentId,
      plan: decision,
      report,
      reportWalrusBlobId: upload?.blobId ?? '',
      deepbookPkg: DEEPBOOK_PACKAGE_ID_TESTNET,
      swap: deepbookSwap,
    });
    // Record performance for the on-chain reputation registry. Real alpha
    // (in bps, split into pos/neg buckets) computed against last tick's
    // snapshot; first post-restart tick reports 0/0 honestly.
    tx.moveCall({
      target: target(this.#config.packageId, 'agent', 'record_tick_performance'),
      arguments: [
        tx.object(this.#config.agentId),
        tx.object(agent.identity.strategyId),
        tx.pure.u64(alpha.posBps),
        tx.pure.u64(alpha.negBps),
      ],
    });

    // If the strategy generated positive alpha, pay the strategist their
    // cut atomically with the rebalance. Move VM bounds this by
    // royalty_bps and treasury balance; if it would exceed, the whole
    // PTB aborts cleanly (no half-paid state).
    if (royaltyMist > 0n) {
      tx.moveCall({
        target: target(this.#config.packageId, 'agent', 'pay_strategist_royalty'),
        typeArguments: ['0x2::sui::SUI'],
        arguments: [
          tx.object(this.#config.agentId),
          tx.object(agent.identity.strategyId),
          tx.pure.u64(royaltyMist),
        ],
      });
    }
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
      reportWalrusBlobId: upload?.blobId ?? '',
      reportBlobObjectId: upload?.blobObjectId ?? '',
      artifactSlot: upload ? parseArtifactSlot(result) : 0n,
      epoch: currentEpoch,
      executedAt: new Date().toISOString(),
    };
    await rememberStrategyOutcome({
      memwal,
      namespace,
      decision,
      receipt,
      memoryWrite,
    });
    this.#savePreviousTick(holdings, currentEpoch);
    this.#logger.info(
      {
        txDigest: receipt.txDigest,
        walrusBlobId: receipt.reportWalrusBlobId,
        artifactSlot: receipt.artifactSlot.toString(),
        trades: receipt.trades.length,
        alphaPosBps: alpha.posBps,
        alphaNegBps: alpha.negBps,
        royaltyMist: royaltyMist.toString(),
      },
      'rebalance executed',
    );
    return receipt;
  }

  /**
   * Pre-tick auto-refuel. Reads the session's SUI balance; if it's
   * below the threshold, fires a `pull_operational_funds<SUI>` PTB
   * that lands fresh SUI on the session address. The session's
   * current SUI pays for this PTB itself (so threshold must leave
   * room for one transaction's worth of gas, ~5M MIST).
   */
  async #maybeRefuelSession(
    signer: Awaited<ReturnType<typeof loadSessionKeypair>>,
    epoch: bigint,
  ): Promise<void> {
    const threshold = this.#config.refuelThresholdMist ?? DEFAULT_REFUEL_THRESHOLD_MIST;
    const topUpAmount =
      this.#config.refuelAmountMist ?? DEFAULT_REFUEL_AMOUNT_MIST;
    const sessionAddr = signer.toSuiAddress();
    let balance = 0n;
    try {
      const r = await this.#client.getBalance({ owner: sessionAddr });
      balance = BigInt(r.totalBalance);
    } catch (err) {
      this.#logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'auto-refuel: skipped balance check (rpc error)',
      );
      return;
    }
    if (balance >= threshold) return;
    this.#logger.info(
      {
        sessionAddr,
        balance: balance.toString(),
        threshold: threshold.toString(),
        topUpAmount: topUpAmount.toString(),
      },
      'auto-refuel: session below threshold; pulling from treasury',
    );
    try {
      const tx = new Transaction();
      const coin = tx.moveCall({
        target: target(this.#config.packageId, 'agent', 'pull_operational_funds'),
        typeArguments: ['0x2::sui::SUI'],
        arguments: [tx.object(this.#config.agentId), tx.pure.u64(topUpAmount)],
      });
      tx.transferObjects([coin], tx.pure.address(sessionAddr));
      const result = await this.#client.signAndExecuteTransaction({
        transaction: tx,
        signer,
        options: { showEffects: true },
      });
      await this.#client.waitForTransaction({ digest: result.digest });
      this.#logger.info(
        {
          txDigest: result.digest,
          newBalance: (balance + topUpAmount).toString(),
          epoch: epoch.toString(),
        },
        'auto-refuel: session topped up from treasury',
      );
    } catch (err) {
      this.#logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'auto-refuel: pull_operational_funds failed (cap unset, exhausted, or treasury dry?). Proceeding with existing session gas.',
      );
    }
  }

  async #executeNoop(
    report: AuditReport,
    currentEpoch: bigint,
    signer: Awaited<ReturnType<typeof loadSessionKeypair>>,
    strategyId: string,
    alpha: { posBps: number; negBps: number },
    royaltyMist: bigint,
  ): Promise<ExecutionReceipt> {
    // Try to publish the rationale to Walrus, but degrade gracefully if
    // the session is out of WAL tokens or the Walrus publisher is down.
    // The on-chain attestation + record_tick_performance still land, so
    // the dashboard's Runtime Health panel + strategy reputation update
    // regardless.
    let upload: Awaited<ReturnType<typeof uploadReportBlob>> | null = null;
    try {
      upload = await uploadReportBlob({
        suiClient: this.#client,
        walrusNetwork: this.#config.walrusNetwork,
        signer,
        report,
        epochs: this.#config.walrusEpochs ?? DEFAULT_WALRUS_EPOCHS,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#logger.warn(
        { err: message, hint: walrusFailureHint(message) },
        'walrus upload failed; recording on-chain tick anyway',
      );
    }

    const tx = new Transaction();
    if (upload) {
      publishArtifactCall(tx, this.#config.packageId, {
        agentId: this.#config.agentId,
        walrusBlobId: new TextEncoder().encode(upload.blobId),
        sha256: upload.sha256,
        mimeType: 'text/markdown',
        sizeBytes: BigInt(upload.sizeBytes),
        sealEncrypted: false,
        label: `audit-${report.planId}`,
      });
    }
    tx.moveCall({
      target: target(this.#config.packageId, 'attestation', 'log_action'),
      arguments: [
        tx.object(this.#config.agentId),
        tx.pure.u8(ActionKind.ArtifactPublish),
        tx.pure.string(`noop ${report.planId}`),
        tx.pure.vector('u8', Array.from(report.sha256)),
      ],
    });
    // Record performance on the strategy registry so the dashboard's
    // Runtime Health + marketplace `LIVE α` columns reflect the tick.
    // Even on NOOP the alpha may be non-zero — a passive hold can
    // outperform the strategy's last rebalance, generating negative alpha
    // we want recorded honestly.
    tx.moveCall({
      target: target(this.#config.packageId, 'agent', 'record_tick_performance'),
      arguments: [
        tx.object(this.#config.agentId),
        tx.object(strategyId),
        tx.pure.u64(alpha.posBps),
        tx.pure.u64(alpha.negBps),
      ],
    });
    // Same royalty hook on the NOOP path: if alpha > 0 since last tick
    // (price moved in the strategy's favor since its last rebalance)
    // the strategist still earns. The Move VM bounds the pull by
    // royalty_bps and treasury.
    if (royaltyMist > 0n) {
      tx.moveCall({
        target: target(this.#config.packageId, 'agent', 'pay_strategist_royalty'),
        typeArguments: ['0x2::sui::SUI'],
        arguments: [
          tx.object(this.#config.agentId),
          tx.object(strategyId),
          tx.pure.u64(royaltyMist),
        ],
      });
    }
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
      reportWalrusBlobId: upload?.blobId ?? '',
      reportBlobObjectId: upload?.blobObjectId ?? '',
      artifactSlot: upload ? parseArtifactSlot(result) : 0n,
      epoch: currentEpoch,
      executedAt: new Date().toISOString(),
    };
    this.#logger.info(
      {
        txDigest: receipt.txDigest,
        walrusBlobId: receipt.reportWalrusBlobId || '(skipped — no WAL)',
        artifactSlot: receipt.artifactSlot.toString(),
        alphaPosBps: alpha.posBps,
        alphaNegBps: alpha.negBps,
        royaltyMist: royaltyMist.toString(),
      },
      'noop tick recorded on-chain',
    );
    return receipt;
  }

  /**
   * Compare current holdings to the snapshot from the previous tick to
   * isolate the strategy's contribution (alpha) from passive price
   * movement. Returns alpha as bps split into positive/negative buckets
   * so we can pass directly into `agent::record_tick_performance`.
   *
   * For the first tick after a runtime restart there is no previous
   * snapshot, so we report 0 alpha honestly rather than guess.
   *
   * Formula:
   *   nav_now   = sum(current_holdings[i].amount * current_price[i])
   *   nav_hold  = sum(previous_holdings[i].amount * current_price[i])
   *   alpha_usd = nav_now - nav_hold
   *   alpha_bps = round(alpha_usd / nav_hold * 10_000)
   *
   * Capped at +/- 5000bps (50%) per tick to keep a single anomalous
   * read from polluting the lifetime reputation counters.
   */
  #computeAlpha(
    currentHoldings: HoldingSnapshot[],
    prices: Record<string, number>,
  ): { posBps: number; negBps: number; alphaUsd: number } {
    if (!this.#previousTick) return { posBps: 0, negBps: 0, alphaUsd: 0 };
    const navIfHeld = this.#previousTick.holdings.reduce((sum, h) => {
      const priceUsd = prices[h.symbol] ?? prices[symbolFromTypeTag(h.coinTypeTag)] ?? 0;
      const units = Number(h.amount) / Math.pow(10, h.decimals);
      return sum + units * priceUsd;
    }, 0);
    if (navIfHeld <= 0) return { posBps: 0, negBps: 0, alphaUsd: 0 };
    const navNow = currentHoldings.reduce((s, h) => s + h.valueUsd, 0);
    const alphaUsd = navNow - navIfHeld;
    const rawBps = Math.round((alphaUsd / navIfHeld) * 10_000);
    const bounded = Math.max(-5000, Math.min(5000, rawBps));
    return {
      posBps: bounded > 0 ? bounded : 0,
      negBps: bounded < 0 ? -bounded : 0,
      alphaUsd,
    };
  }

  /**
   * Convert positive alpha-USD into the SUI MIST amount we pay the
   * strategist this tick. Royalty math (alpha × royalty_bps / 10_000)
   * is repeated on-chain by `pay_strategist_royalty` — we pass the
   * full alpha as the "profit" basis and let the Move function apply
   * the strategist's published royalty_bps.
   *
   * Returns 0 when alpha is negative, below the dust threshold, or
   * when SUI's price is missing.
   */
  #computeRoyaltyMist(
    alpha: { alphaUsd: number },
    prices: Record<string, number>,
    activeStrategy: Strategy,
  ): bigint {
    if (alpha.alphaUsd < ROYALTY_MIN_ALPHA_USD) return 0n;
    const suiPriceUsd = prices.SUI ?? prices['SUI'] ?? 0;
    if (suiPriceUsd <= 0) return 0n;
    // Pay the *full* alpha as basis; the Move function multiplies by
    // royalty_bps internally. So the strategist receives
    //   alphaUsd / suiPrice * (royalty_bps / 10_000)
    // worth of SUI.
    const basisInSui = alpha.alphaUsd / suiPriceUsd;
    const basisMist = BigInt(Math.max(0, Math.floor(basisInSui * 1e9)));
    if (basisMist === 0n) return 0n;
    void activeStrategy; // reserved for future per-strategy adjustments
    return basisMist;
  }

  /**
   * Save the post-tick holdings snapshot so the next tick can compute
   * alpha vs hold. In-memory only; lost on runtime restart (first tick
   * after restart reports 0 alpha honestly).
   */
  #savePreviousTick(holdings: HoldingSnapshot[], epoch: bigint): void {
    this.#previousTick = {
      holdings: holdings.map((h) => ({
        coinTypeTag: h.coinTypeTag,
        amount: h.amount,
        decimals: h.decimals,
        symbol: h.symbol,
      })),
      epoch,
      recordedAtMs: Date.now(),
    };
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

/**
 * Classify Walrus upload failures so the warn log surfaces the actual
 * root cause instead of always blaming WAL balance. Several distinct
 * failure modes share the same code path but have very different fixes:
 *   - genuine WAL exhaustion (fund the session with WAL)
 *   - testnet storage-node consensus failure (transient; retry next tick)
 *   - publisher / aggregator network errors (likely transient)
 */
function walrusFailureHint(errorMessage: string): string {
  const m = errorMessage.toLowerCase();
  if (m.includes('insufficient balance') && m.includes('wal')) {
    return 'session has no WAL — fund it with `walrus get-wal --amount <MIST>` after importing the session key';
  }
  if (m.includes('too many failures') || m.includes('too many invalid confirmations')) {
    return 'transient testnet Walrus storage-node consensus failure — WAL may have been partially spent; next tick will retry';
  }
  if (m.includes('timeout') || m.includes('econnrefused') || m.includes('enotfound')) {
    return 'network reach to Walrus publisher / aggregator failed — check connectivity, will retry next tick';
  }
  return 'unclassified Walrus failure — see `err` field for full message';
}
