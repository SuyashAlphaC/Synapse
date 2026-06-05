// Tiny universal `delay` — `node:timers/promises` is Node-only and
// would break the in-browser runtime build. `globalThis.setTimeout`
// works identically in Node and browsers / Web Workers.
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

const TRANSIENT_ERROR_PATTERNS = [
  'fetch failed',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'socket hang up',
  'network error',
  'AbortError',
  'UND_ERR_CONNECT_TIMEOUT',
];

function isTransientNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT_ERROR_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Wraps `signAndExecuteTransaction` with retry-on-transient-network-error.
 * The Sui SDK's transaction builder internally calls `getLatestSuiSystemState`
 * during gas resolution — if the RPC is briefly unreachable, the PTB build
 * fails with `TypeError: fetch failed` even though the runtime's own
 * pre-checks passed. Retrying 2-3 times with a short backoff covers these
 * blips without masking real Move abort errors.
 */
async function signAndExecuteWithRetry(
  client: SuiJsonRpcClient,
  args: {
    transaction: Transaction;
    signer: Awaited<ReturnType<typeof import('./keypair.js').loadSessionKeypair>>;
    options?: Record<string, boolean>;
  },
  maxRetries = 3,
): Promise<SuiTransactionBlockResponse> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.signAndExecuteTransaction({
        transaction: args.transaction,
        signer: args.signer,
        options: args.options,
      });
    } catch (err) {
      if (attempt < maxRetries && isTransientNetworkError(err)) {
        const backoffMs = 2000 * 2 ** attempt;
        await delay(backoffMs);
        continue;
      }
      throw err;
    }
  }
}
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import type { SuiTransactionBlockResponse } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { ActionKind, publishArtifactCall, target } from '@synapse-core/client';
import type {
  AuditReport,
  ExecutedTrade,
  ExecutionReceipt,
  HoldingSnapshot,
  StrategyInput,
  StrategyDecision,
} from '../types.js';
import { buildRebalancePTB, makeExecutedTrade } from '../executor.js';
import { requestAttestedDecision, hexToBytes } from './enclave-client.js';
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
import { isLangGraphStrategy } from './langgraph-marker.js';
import type { StrategyRuntimeContext } from '../types.js';
import { uploadReportBlob, parseArtifactSlot, type SealUploadOptions } from './publisher.js';
import {
  computeWalSwapAmountMist,
  DEFAULT_WAL_REFUEL_AMOUNT_MIST,
  DEFAULT_WAL_REFUEL_THRESHOLD_FROST,
  estimateWalFrostForUpload,
  isInsufficientWalBalanceError,
  MIN_WAL_REFUEL_SWAP_MIST,
  needsWalRefuel,
  suiNeededBeforeWalSwap,
  WAL_COIN_TYPE,
} from './wal-refuel.js';
import { deepbookSwap } from './deepbook.js';
import { deepbookPackageForRuntime } from './config.js';
import { loadSessionKeypair, loadMemwalDelegateFromKeyFile } from './keypair.js';
import { createLogger, type VaultLogger } from './logger.js';
import type { RuntimeConfig } from './config.js';
import { resolveStrategyWithWalrus } from './strategy-resolver.js';
import { fetchStrategyMeta } from './walrus-loader.js';
import { EnvSecretsProvider, type SecretsProvider } from './secrets.js';
import {
  consumeSignals,
  emitSignal,
  messageDigest,
  recordReceivePTB,
  recordSendPTB,
  type MessagingLike,
} from './messaging.js';
import { sendAlert } from './alerts.js';
import type { Strategy } from '../types.js';

/** The attestation block accepted by `buildRebalancePTB` (Nautilus path). */
type RebalanceAttestation = NonNullable<Parameters<typeof buildRebalancePTB>[0]['attestation']>;

export type { RuntimeConfig } from './config.js';

const DEFAULT_TICK_INTERVAL_MS = 600_000;
const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_WALRUS_EPOCHS = 5;

/**
 * Thrown when a tick is aborted before any PTB is constructed because an
 * upstream external dependency is unhealthy (Sui RPC, Pyth, DeepBook
 * pool fetch). The runtime logs and skips — the tick does NOT count
 * toward `consecutiveFailures`, because the runtime itself isn't broken;
 * the network is. The next tick interval will retry from scratch.
 *
 * Failures AFTER a PTB is built and signed (e.g. chain rejected the
 * transaction) are still real `consecutiveFailures` because they imply
 * a bug or a wrong config. We never half-sign.
 */
export class TickSkippedError extends Error {
  constructor(
    readonly stage: 'rpc' | 'agent-state' | 'market' | 'memory',
    cause: unknown,
  ) {
    const m = cause instanceof Error ? cause.message : String(cause);
    super(`tick skipped (${stage}): ${m}`);
    this.name = 'TickSkippedError';
    this.cause = cause;
  }
}
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
  /**
   * Sui Stack Messaging client for cross-agent signalling. Injected (not built
   * here) because `@mysten/messaging` pins `@mysten/sui` 1.x, conflicting with
   * this package's 2.x — it is constructed in the isolated messaging package.
   * When absent, cross-agent consume/emit is disabled (graceful).
   */
  messagingClient?: MessagingLike;
}

export class VaultRuntime {
  readonly #config: RuntimeConfig;
  readonly #client: SuiJsonRpcClient;
  readonly #logger: VaultLogger;
  readonly #secrets: SecretsProvider;
  readonly #messagingClient: MessagingLike | null;
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
    this.#secrets = config.secretsProvider ?? new EnvSecretsProvider();
    this.#messagingClient = deps.messagingClient ?? null;
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
      // Skips don't count toward the kill-switch — the runtime is fine,
      // an upstream is hiccupping. Reset the counter so a long Pyth
      // outage doesn't masquerade as runtime instability.
      if (err instanceof TickSkippedError) {
        this.#consecutiveFailures = 0;
        this.#logger.warn(
          { stage: err.stage, err: err.cause },
          'tick skipped due to transient external outage — will retry next interval',
        );
        return null;
      }
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
      } catch (err) {
        // `tickOnce` already classified + logged the error. Swallow it
        // here so the loop survives — only `#stopping` (set when the
        // kill-switch trips, or on shutdown) breaks us out.
        void err;
        if (this.#stopping) break;
      }
      if (!this.#stopping) {
        await delay(this.#config.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
      }
    }
  }

  async #tickOnceInner(): Promise<ExecutionReceipt | null> {
    // Session key load failures are config errors (real failures, not
    // transient) and intentionally NOT wrapped as skips — we want them
    // to trip the kill switch so the operator notices the bad config.
    const signer = await loadSessionKeypair({
      ...(this.#config.sessionKeyPath ? { sessionKeyPath: this.#config.sessionKeyPath } : {}),
      ...(this.#config.sessionKeyEnv ? { sessionKeyEnv: this.#config.sessionKeyEnv } : {}),
    });
    // Pre-PTB external calls: classify failures as skips so a flaky
    // RPC / DeepBook / Pyth doesn't masquerade as a runtime defect and
    // trip `maxConsecutiveFailures`.
    let currentEpoch: bigint;
    try {
      const systemState = await this.#client.getLatestSuiSystemState();
      currentEpoch = BigInt(systemState.epoch);
    } catch (err) {
      throw new TickSkippedError('rpc', err);
    }
    let agent: Awaited<ReturnType<typeof loadAgentState>>;
    try {
      agent = await loadAgentState({
        client: this.#client,
        agentId: this.#config.agentId,
        packageId: this.#config.packageId,
        packageHistory: this.#config.packageHistory,
      });
    } catch (err) {
      throw new TickSkippedError('agent-state', err);
    }

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
    await this.#maybeRefuelWAL(signer, currentEpoch);

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
    // Per-vault Anthropic key (model A): resolve from the configured secrets
    // provider into the process env so the Walrus-loaded llm-advisor bundle (and
    // any LLM strategy) reads it via `process.env.ANTHROPIC_API_KEY`. The
    // attested path keeps the key inside the enclave instead.
    const anthropicKey = await this.#secrets.get('anthropic_api_key');
    if (anthropicKey) process.env.ANTHROPIC_API_KEY = anthropicKey;

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
              ...(this.#config.walrusAllowlist
                ? { allowlist: this.#config.walrusAllowlist }
                : {}),
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

    let market: Awaited<ReturnType<typeof loadMarketSnapshot>>;
    try {
      market = await loadMarketSnapshot({
        client: this.#client,
        pools: requiredPoolsForStrategy(activeStrategy),
        senderAddress: signer.toSuiAddress(),
      });
    } catch (err) {
      throw new TickSkippedError('market', err);
    }

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

    const effectiveMemwalConfig = memwalConfig ?? this.#config.memwal;
    let strategyRuntime: StrategyRuntimeContext | undefined;
    if (isLangGraphStrategy(activeStrategy)) {
      const { buildStrategyRuntimeContext } = await import('./strategy-context.js');
      strategyRuntime = buildStrategyRuntimeContext({
        identity: agent.identity,
        memwal,
        memwalConfig: effectiveMemwalConfig,
        namespace,
        vaultId: this.#config.agentId,
      });
      this.#logger.info(
        { strategyId: activeStrategy.id, store: Boolean(strategyRuntime?.store) },
        'dispatching LangGraph strategy (SynapseStore when MemWal enabled)',
      );
    }

    // --- Cross-agent consume: read peers' signals from the on-chain inbox
    // channel and inject them as memory facts so the strategy/enclave sees them.
    // Persisted channel ids come from the vault's on-chain state; the cursor
    // persists as a MemWal counter. All failures degrade to no peer facts.
    const inboxId = agent.identity.messagingInbox ?? null;
    const outboxId = agent.identity.messagingOutbox ?? null;
    let consumedCursor: bigint | null = null;
    if (this.#messagingClient && inboxId) {
      const lastCursorNum = input.memory.counters['msgCursor'];
      const consumed = await consumeSignals({
        client: this.#messagingClient,
        inboxChannelId: inboxId,
        userAddress: signer.toSuiAddress(),
        lastCursor: typeof lastCursorNum === 'number' ? BigInt(lastCursorNum) : null,
      });
      consumedCursor = consumed.newCursor;
      if (consumed.facts.length > 0) {
        input.memory.facts = [...input.memory.facts, ...consumed.facts];
        this.#logger.info(
          { count: consumed.facts.length, inbox: inboxId },
          'consumed cross-agent signals into strategy memory',
        );
        try {
          const recvTx = new Transaction();
          for (const fact of consumed.facts) {
            recordReceivePTB(
              recvTx,
              this.#config.packageId,
              this.#config.agentId,
              inboxId,
              await messageDigest(fact),
            );
          }
          await signAndExecuteWithRetry(this.#client, { transaction: recvTx, signer });
        } catch (err) {
          this.#logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'record_receive failed; signals still consumed in-memory',
          );
        }
      }
    }

    // Attested execution (Nautilus): when an enclave is configured, the DECISION
    // comes from the attested enclave, not the local strategy. The enclave's
    // signed target weight drives the deterministic rebalancer, and its signature
    // is carried into the rebalance PTB to gate the swap on-chain. An attested
    // vault that can't reach its enclave SKIPS the tick — it must never fall back
    // to an unattested trade.
    let decision: StrategyDecision;
    let attestation: RebalanceAttestation | undefined;
    if (this.#config.enclaveUrl && this.#config.enclaveObjectId) {
      const result = await this.#attestedDecision(input, agent.identity.strategyId);
      decision = result.decision;
      attestation = result.attestation;
    } else {
      decision = await activeStrategy.evaluate(input, strategyRuntime);
    }
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
    const strategyMemoryWrite =
      typeof activeStrategy.prepareMemoryWrite === 'function'
        ? await activeStrategy.prepareMemoryWrite({
            input,
            decision,
            ...(strategyRuntime !== undefined ? { runtime: strategyRuntime } : {}),
          })
        : null;
    // Fold the advanced message cursor into the memory write so the next tick
    // resumes after the messages we just consumed (never reprocessed).
    const memoryWrite =
      consumedCursor !== null
        ? {
            ...(strategyMemoryWrite ?? {}),
            counters: {
              ...(strategyMemoryWrite?.counters ?? {}),
              msgCursor: Number(consumedCursor),
            },
          }
        : strategyMemoryWrite;

    // Compute realized alpha vs hold using last tick's snapshot. Positive
    // alpha means the strategy outperformed a do-nothing baseline; that's
    // what we record on-chain and what we pay royalty on.
    const alpha = this.#computeAlpha(holdings, market.prices);
    const royaltyMistRaw = this.#computeRoyaltyMist(alpha, market.prices, activeStrategy);
    // Royalty is paid in SUI. If the vault doesn't hold enough SUI, paying it
    // would abort (EInsufficientBalance) and revert the WHOLE tick — losing the
    // record_tick + attestation for a USDC-only vault. Skip the royalty this
    // tick instead; the alpha is still recorded and the strategist is paid on a
    // later tick once SUI is available.
    const suiBalance = holdings.find((h) => h.coinTypeTag === '0x2::sui::SUI')?.amount ?? 0n;
    const royaltyMist = royaltyMistRaw > 0n && suiBalance >= royaltyMistRaw ? royaltyMistRaw : 0n;

    if (decision.kind === 'noop') {
      const receipt = await this.#executeNoop(
        report,
        currentEpoch,
        signer,
        agent.identity.strategyId,
        alpha,
        royaltyMist,
      );
      // No trade happened, so post-tick holdings == pre-tick holdings.
      // Save the snapshot BEFORE the (best-effort) memory write so a relayer
      // failure can never drop the alpha baseline.
      this.#savePreviousTick(holdings, currentEpoch);
      // Persist this tick's outcome + strategy memory updates so the next
      // tick can recover counters/facts. Best-effort: a MemWal outage must
      // not count as a tick failure (it would trip the kill-switch).
      await this.#rememberSafe({ memwal, namespace, decision, receipt, memoryWrite });
      return receipt;
    }

    // Try to upload the rationale to Walrus. WAL balance is guaranteed
    // immediately before upload (adaptive SUI→WAL refuel + treasury pull).
    const sealOpts = this.#sealOptions();
    let upload: Awaited<ReturnType<typeof uploadReportBlob>> | null = null;
    try {
      upload = await this.#uploadReportEnsuringWal({
        report,
        signer,
        currentEpoch,
        ...(sealOpts ? { seal: sealOpts } : {}),
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
      deepbookPkg: deepbookPackageForRuntime(this.#config),
      swap: deepbookSwap,
      sealEncrypted: Boolean(sealOpts),
      ...(upload ? { blobSha256: upload.sha256, blobSizeBytes: upload.sizeBytes } : {}),
      ...(attestation ? { attestation } : {}),
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
    const result = await signAndExecuteWithRetry(this.#client, {
      transaction: tx,
      signer,
      options: { showEvents: true, showEffects: true },
    });
    await this.#client.waitForTransaction({ digest: result.digest });

    // --- Cross-agent emit: broadcast this rebalance to peers as a Seal-encrypted,
    // Walrus-stored message on the outbox channel. Only fires on rebalance (noops
    // stay silent → bounds WAL cost). Degrades to no broadcast on failure.
    if (this.#messagingClient && outboxId) {
      try {
        const message = `signal @${currentEpoch}: ${decision.summary}`;
        const emitted = await emitSignal({
          client: this.#messagingClient,
          outboxChannelId: outboxId,
          userAddress: signer.toSuiAddress(),
          signer,
          message,
        });
        if (emitted) {
          this.#logger.info({ digest: emitted.digest, outbox: outboxId }, 'emitted cross-agent signal');
          const sendTx = new Transaction();
          recordSendPTB(
            sendTx,
            this.#config.packageId,
            this.#config.agentId,
            outboxId,
            await messageDigest(message),
          );
          await signAndExecuteWithRetry(this.#client, { transaction: sendTx, signer });
        }
      } catch (err) {
        this.#logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'cross-agent emit failed; rebalance already landed',
        );
      }
    }

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
    // Snapshot the POST-trade holdings (derived from the real executed trade
    // amounts) as next tick's alpha-vs-hold baseline. Saving the pre-trade
    // `holdings` here would double-count the rebalance itself as alpha, inflating
    // on-chain reputation and the royalty paid to the strategist. Saved BEFORE
    // the memory write so a relayer failure cannot drop the baseline.
    const postTradeHoldings = applyTradesToHoldings(holdings, trades);
    this.#savePreviousTick(postTradeHoldings, currentEpoch);
    // Best-effort: the trade is already final on-chain; a MemWal outage must not
    // be reclassified as a tick failure (which would trip the kill-switch).
    await this.#rememberSafe({ memwal, namespace, decision, receipt, memoryWrite });
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
    minBalanceMist?: bigint,
  ): Promise<void> {
    const threshold = minBalanceMist ?? this.#config.refuelThresholdMist ?? DEFAULT_REFUEL_THRESHOLD_MIST;
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
    await this.#pullOperationalSui(signer, epoch, topUpAmount, balance, 'auto-refuel');
  }

  async #pullOperationalSui(
    signer: Awaited<ReturnType<typeof loadSessionKeypair>>,
    epoch: bigint,
    topUpAmount: bigint,
    balanceBefore: bigint,
    label: 'auto-refuel' | 'auto-wal-refuel',
  ): Promise<boolean> {
    const sessionAddr = signer.toSuiAddress();
    this.#logger.info(
      {
        sessionAddr,
        balance: balanceBefore.toString(),
        topUpAmount: topUpAmount.toString(),
        label,
      },
      `${label}: session below threshold; pulling from treasury`,
    );
    try {
      const tx = new Transaction();
      const coin = tx.moveCall({
        target: target(this.#config.packageId, 'agent', 'pull_operational_funds'),
        typeArguments: ['0x2::sui::SUI'],
        arguments: [tx.object(this.#config.agentId), tx.pure.u64(topUpAmount)],
      });
      tx.transferObjects([coin], tx.pure.address(sessionAddr));
      const result = await signAndExecuteWithRetry(this.#client, {
        transaction: tx,
        signer,
        options: { showEffects: true },
      });
      await this.#client.waitForTransaction({ digest: result.digest });
      this.#logger.info(
        {
          txDigest: result.digest,
          newBalance: (balanceBefore + topUpAmount).toString(),
          epoch: epoch.toString(),
          label,
        },
        `${label}: session topped up from treasury`,
      );
      return true;
    } catch (err) {
      this.#logger.warn(
        { err: err instanceof Error ? err.message : String(err), label },
        `${label}: pull_operational_funds failed (cap unset, exhausted, or treasury dry?). Proceeding with existing session gas.`,
      );
      return false;
    }
  }

  async #readSessionSuiBalance(sessionAddr: string): Promise<bigint | null> {
    try {
      const r = await this.#client.getBalance({ owner: sessionAddr });
      return BigInt(r.totalBalance);
    } catch (err) {
      this.#logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'session balance read failed',
      );
      return null;
    }
  }

  async #readSessionWalBalance(sessionAddr: string): Promise<bigint | null> {
    try {
      const r = await this.#client.getBalance({
        owner: sessionAddr,
        coinType: WAL_COIN_TYPE,
      });
      return BigInt(r.totalBalance);
    } catch (err) {
      this.#logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'session WAL balance read failed',
      );
      return null;
    }
  }

  /** Cached exchange package ID — resolved once on first WAL refuel. */
  #walExchangePkg: string | null = null;

  /**
   * Pre-tick auto-WAL-refuel. Uses an adaptive SUI→WAL swap sized to the
   * session's actual SUI balance (not a fixed 0.5 SUI). Pulls operational
   * SUI from the vault treasury when the session cannot afford the swap.
   */
  async #maybeRefuelWAL(
    signer: Awaited<ReturnType<typeof loadSessionKeypair>>,
    epoch: bigint,
    requiredWalFrost?: bigint,
  ): Promise<void> {
    await this.#ensureWalForUpload(signer, epoch, requiredWalFrost ?? 0);
  }

  async #ensureWalForUpload(
    signer: Awaited<ReturnType<typeof loadSessionKeypair>>,
    epoch: bigint,
    requiredWalFrost: number | bigint,
  ): Promise<void> {
    const exchangeIds = this.#config.walExchangeIds;
    if (!exchangeIds || exchangeIds.length === 0) return;

    const threshold =
      this.#config.walRefuelThreshold ?? DEFAULT_WAL_REFUEL_THRESHOLD_FROST;
    const maxSwap = this.#config.walRefuelAmount ?? DEFAULT_WAL_REFUEL_AMOUNT_MIST;
    const required =
      typeof requiredWalFrost === 'bigint'
        ? requiredWalFrost
        : BigInt(Math.max(0, requiredWalFrost));
    const minWal = required > threshold ? required : threshold;

    const sessionAddr = signer.toSuiAddress();
    for (let attempt = 0; attempt < 3; attempt++) {
      const walBalance = (await this.#readSessionWalBalance(sessionAddr)) ?? 0n;
      if (!needsWalRefuel(walBalance, minWal)) return;

      const swapped = await this.#executeWalRefuelSwap(signer, epoch, {
        targetFrost: minWal,
        maxSwapMist: maxSwap,
        walBalance,
      });
      if (swapped) {
        const after = (await this.#readSessionWalBalance(sessionAddr)) ?? 0n;
        if (!needsWalRefuel(after, minWal)) return;
      }
    }

    const finalWal = (await this.#readSessionWalBalance(sessionAddr)) ?? 0n;
    if (needsWalRefuel(finalWal, minWal)) {
      throw new Error(
        `WAL refuel exhausted for Walrus upload (have ${finalWal} FROST, need ${minWal})`,
      );
    }
  }

  async #executeWalRefuelSwap(
    signer: Awaited<ReturnType<typeof loadSessionKeypair>>,
    epoch: bigint,
    args: { targetFrost: bigint; maxSwapMist: bigint; walBalance: bigint },
  ): Promise<boolean> {
    const exchangeIds = this.#config.walExchangeIds;
    if (!exchangeIds || exchangeIds.length === 0) return false;

    const sessionAddr = signer.toSuiAddress();
    let suiBalance = (await this.#readSessionSuiBalance(sessionAddr)) ?? 0n;
    let swapAmount = computeWalSwapAmountMist({
      suiBalanceMist: suiBalance,
      configuredMaxMist: args.maxSwapMist,
    });

    if (swapAmount === null) {
      const needed = suiNeededBeforeWalSwap(
        args.maxSwapMist > MIN_WAL_REFUEL_SWAP_MIST ? args.maxSwapMist : MIN_WAL_REFUEL_SWAP_MIST,
      );
      if (suiBalance < needed) {
        const pullAmount = this.#config.refuelAmountMist ?? DEFAULT_REFUEL_AMOUNT_MIST;
        await this.#pullOperationalSui(signer, epoch, pullAmount, suiBalance, 'auto-wal-refuel');
        suiBalance = (await this.#readSessionSuiBalance(sessionAddr)) ?? suiBalance;
        swapAmount = computeWalSwapAmountMist({
          suiBalanceMist: suiBalance,
          configuredMaxMist: args.maxSwapMist,
        });
      }
    }

    if (swapAmount === null) {
      this.#logger.warn(
        {
          sessionAddr,
          suiBalance: suiBalance.toString(),
          walBalance: args.walBalance.toString(),
          targetFrost: args.targetFrost.toString(),
        },
        'auto-wal-refuel: session SUI too low for swap even after treasury pull',
      );
      return false;
    }

    if (!this.#walExchangePkg) {
      const explicitPkg = this.#config.walExchangePkg;
      if (explicitPkg) {
        this.#walExchangePkg = explicitPkg;
      } else {
        try {
          const obj = await this.#client.getObject({
            id: exchangeIds[0],
            options: { showType: true },
          });
          const objType = obj.data?.type;
          if (objType) {
            this.#walExchangePkg = objType.split('::')[0];
          }
        } catch {
          this.#logger.warn('auto-wal-refuel: could not resolve exchange package ID; skipping');
          return false;
        }
      }
      if (!this.#walExchangePkg) {
        this.#logger.warn('auto-wal-refuel: could not resolve exchange package ID; skipping');
        return false;
      }
    }

    this.#logger.info(
      {
        sessionAddr,
        walBalance: args.walBalance.toString(),
        targetFrost: args.targetFrost.toString(),
        swapAmount: swapAmount.toString(),
        suiBalance: suiBalance.toString(),
      },
      'auto-wal-refuel: swapping SUI → WAL',
    );

    for (const exchangeId of exchangeIds) {
      try {
        const tx = new Transaction();
        const [suiCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(swapAmount)]);
        const walCoin = tx.moveCall({
          target: `${this.#walExchangePkg}::wal_exchange::exchange_all_for_wal`,
          arguments: [tx.object(exchangeId), suiCoin],
        });
        tx.transferObjects([walCoin], tx.pure.address(sessionAddr));

        const result = await signAndExecuteWithRetry(this.#client, {
          transaction: tx,
          signer,
          options: { showEffects: true },
        });
        await this.#client.waitForTransaction({ digest: result.digest });
        this.#logger.info(
          { txDigest: result.digest, exchangeId, swapAmount: swapAmount.toString() },
          'auto-wal-refuel: SUI → WAL exchange succeeded',
        );
        return true;
      } catch (err) {
        this.#logger.warn(
          { err: err instanceof Error ? err.message : String(err), exchangeId },
          'auto-wal-refuel: exchange attempt failed; trying next exchange object',
        );
      }
    }
    this.#logger.warn('auto-wal-refuel: all exchange objects failed');
    return false;
  }

  async #uploadReportEnsuringWal(args: {
    report: AuditReport;
    signer: Awaited<ReturnType<typeof loadSessionKeypair>>;
    currentEpoch: bigint;
    seal?: SealUploadOptions | undefined;
  }): Promise<Awaited<ReturnType<typeof uploadReportBlob>>> {
    const epochs = this.#config.walrusEpochs ?? DEFAULT_WALRUS_EPOCHS;
    const payloadBytes = new TextEncoder().encode(args.report.markdown).length;
    const requiredWal = estimateWalFrostForUpload(payloadBytes, epochs);

    await this.#ensureWalForUpload(args.signer, args.currentEpoch, requiredWal);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await uploadReportBlob({
          suiClient: this.#client,
          walrusNetwork: this.#config.walrusNetwork,
          signer: args.signer,
          report: args.report,
          epochs,
          ...(args.seal ? { seal: args.seal } : {}),
        });
      } catch (err) {
        if (isInsufficientWalBalanceError(err) && attempt === 0) {
          const bumped = requiredWal + requiredWal / 2n;
          this.#logger.warn(
            { requiredWal: requiredWal.toString(), bumped: bumped.toString() },
            'walrus upload WAL shortfall after refuel; retrying with larger target',
          );
          await this.#ensureWalForUpload(args.signer, args.currentEpoch, bumped);
          continue;
        }
        throw err;
      }
    }
    throw new Error('walrus upload failed after WAL refuel retries');
  }

  async #executeNoop(
    report: AuditReport,
    currentEpoch: bigint,
    signer: Awaited<ReturnType<typeof loadSessionKeypair>>,
    strategyId: string,
    alpha: { posBps: number; negBps: number },
    royaltyMist: bigint,
  ): Promise<ExecutionReceipt> {
    // Publish audit blob to Walrus — WAL is prefunded adaptively.
    const sealOpts = this.#sealOptions();
    let upload: Awaited<ReturnType<typeof uploadReportBlob>> | null = null;
    try {
      upload = await this.#uploadReportEnsuringWal({
        report,
        signer,
        currentEpoch,
        ...(sealOpts ? { seal: sealOpts } : {}),
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
        mimeType: sealOpts ? 'application/octet-stream' : 'text/markdown',
        sizeBytes: BigInt(upload.sizeBytes),
        sealEncrypted: Boolean(sealOpts),
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
    const result = await signAndExecuteWithRetry(this.#client, {
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
  /**
   * Seal options for report uploads, or undefined when Seal is not
   * configured (`SYNAPSE_SEAL_PACKAGE_ID` unset). Off by default, so the
   * browser path and existing operators upload plaintext unchanged.
   */
  /**
   * Attested-execution decision path (strategy-agnostic). Sends the vault's HIRED
   * strategy (Walrus blob + on-chain code_hash) + the full input to the enclave,
   * which runs that exact bundle inside the TEE and signs (code_hash ‖
   * decision_hash ‖ inputs_hash). The runtime executes the returned decision; the
   * signature gates the rebalance PTB on-chain. Throws (→ skipped tick) if the
   * enclave is unreachable or the strategy has no bundle — an attested vault never
   * trades unattested.
   */
  async #attestedDecision(
    input: StrategyInput,
    strategyId: string,
  ): Promise<{ decision: StrategyDecision; attestation: RebalanceAttestation }> {
    const meta = await fetchStrategyMeta(this.#client, strategyId);
    if (!meta || meta.sourceWalrusBlob.length === 0) {
      throw new Error(
        `attested vault: strategy ${strategyId} has no Walrus bundle / code_hash to attest`,
      );
    }

    const dec = await requestAttestedDecision({
      enclaveUrl: this.#config.enclaveUrl!,
      vaultId: this.#config.agentId,
      epoch: input.currentEpoch,
      blobId: meta.sourceWalrusBlob,
      codeHashHex: meta.codeHashHex,
      network: this.#config.walrusNetwork,
      input,
    });

    const attestedSignal = { attested: true } as const;
    const decision: StrategyDecision =
      dec.decision.kind === 'rebalance'
        ? { ...dec.decision, signals: { ...dec.decision.signals, ...attestedSignal } }
        : { ...dec.decision, signals: { ...(dec.decision.signals ?? {}), ...attestedSignal } };

    const attestation: RebalanceAttestation = {
      enclaveObjectId: this.#config.enclaveObjectId!,
      strategyObjectId: strategyId,
      epoch: input.currentEpoch,
      codeHash: hexToBytes(dec.codeHashHex),
      decisionHash: hexToBytes(dec.decisionHashHex),
      inputsHash: hexToBytes(dec.inputsHashHex),
      timestampMs: BigInt(dec.timestampMs),
      signature: hexToBytes(dec.signatureHex),
    };
    return { decision, attestation };
  }

  #sealOptions(): SealUploadOptions | undefined {
    if (!this.#config.sealPackageId) return undefined;
    return {
      packageId: this.#config.sealPackageId,
      ...(this.#config.sealKeyServerObjectIds
        ? { keyServerObjectIds: this.#config.sealKeyServerObjectIds }
        : {}),
    };
  }

  /**
   * Persist the strategy outcome to MemWal, swallowing any error. The trade (or
   * noop attestation) is already committed on-chain by the time this runs, so a
   * relayer timeout/outage must NOT propagate — otherwise a healthy runtime that
   * successfully traded would count the tick as a failure and, after
   * `maxConsecutiveFailures`, kill itself. Memory is best-effort durability, not
   * a correctness gate.
   */
  async #rememberSafe(args: Parameters<typeof rememberStrategyOutcome>[0]): Promise<void> {
    try {
      await rememberStrategyOutcome(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#logger.warn(
        { err: message },
        'memwal remember failed; on-chain action already committed, continuing',
      );
    }
  }

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

/**
 * Apply executed trades to a holdings snapshot to derive the post-trade
 * holdings, without an extra RPC. Subtracts each trade's `amountIn` from its
 * `fromTypeTag` balance and adds `amountOut` to its `toTypeTag` balance. A coin
 * type received but not previously held is added with a best-effort decimals
 * guess (it will be reloaded with exact decimals on the next tick); priceUsd /
 * valueUsd are left 0 because `#computeAlpha` recomputes value from raw amounts
 * and live prices.
 */
function applyTradesToHoldings(
  holdings: HoldingSnapshot[],
  trades: ExecutedTrade[],
): HoldingSnapshot[] {
  const byType = new Map<string, HoldingSnapshot>(
    holdings.map((h) => [h.coinTypeTag, { ...h }]),
  );
  for (const t of trades) {
    const from = byType.get(t.fromTypeTag);
    if (from) {
      from.amount = from.amount > t.amountIn ? from.amount - t.amountIn : 0n;
    }
    const to = byType.get(t.toTypeTag);
    if (to) {
      to.amount = to.amount + t.amountOut;
    } else {
      byType.set(t.toTypeTag, {
        coinTypeTag: t.toTypeTag,
        symbol: symbolFromTypeTag(t.toTypeTag),
        amount: t.amountOut,
        decimals: from?.decimals ?? 9,
        priceUsd: 0,
        valueUsd: 0,
      });
    }
  }
  return [...byType.values()];
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
    return 'session WAL still insufficient after adaptive auto-refuel — check treasury operational budget / pull_operational_funds cap';
  }
  if (m.includes('too many failures') || m.includes('too many invalid confirmations')) {
    return 'transient testnet Walrus storage-node consensus failure — WAL may have been partially spent; next tick will retry';
  }
  if (m.includes('timeout') || m.includes('econnrefused') || m.includes('enotfound')) {
    return 'network reach to Walrus publisher / aggregator failed — check connectivity, will retry next tick';
  }
  return 'unclassified Walrus failure — see `err` field for full message';
}
