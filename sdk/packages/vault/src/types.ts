/**
 * Synapse Vault — type definitions for strategies, rebalance plans, execution
 * receipts, and audit reports.
 *
 * These types are the contract between:
 *   - Strategy implementations (which emit `RebalancePlan` instances)
 *   - The executor (which converts plans into Synapse-gated PTBs)
 *   - The audit reporter (which materializes a `Report` as a Walrus artifact)
 *   - The dashboard (which renders timeline entries to humans)
 */

// =============================================================================
// Strategy model
// =============================================================================

/** Marker set on strategies built via {@link createLangGraphStrategy}. */
export const SYNAPSE_LANGGRAPH_STRATEGY = Symbol.for('synapse.langgraph.strategy.v1');

/**
 * Runtime-provided context for a single tick. Passed as the optional second
 * argument to `Strategy.evaluate` / `prepareMemoryWrite` when MemWal is
 * configured. Attested enclave execution receives `undefined` here — graphs
 * must derive state from `StrategyInput.memory` in that path.
 */
export interface StrategyRuntimeContext {
  /** Walrus-durable LangGraph `BaseStore` for this vault. */
  store: import('@synapse-core/adapter-langgraph').SynapseStore;
  /** MemWal namespace string (UTF-8 decoded from on-chain identity). */
  namespace: string;
  /** LangGraph configurable thread id — defaults to the vault object id. */
  threadId: string;
}

/**
 * A strategy is a pure function of (current portfolio state, market state,
 * memory) → either a no-op decision or a concrete rebalance plan.
 *
 * Strategies are stateless code; persistent state lives in MemWal and Walrus.
 * This makes strategies trivially upgradeable (deploy new code, point the
 * Vault at it) without touching on-chain state.
 *
 * LangGraph-backed strategies (see `createLangGraphStrategy`) implement the
 * same interface; the runtime passes {@link StrategyRuntimeContext} when
 * MemWal is available.
 */
export interface Strategy {
  /** Stable identifier — recorded on every rebalance for auditability. */
  readonly id: string;
  /** Human-readable name displayed in the dashboard. */
  readonly name: string;
  /** Strategy version (semver). Bump on any behavior change. */
  readonly version: string;
  /** Short description rendered above the audit timeline. */
  readonly description: string;
  /**
   * Evaluate the strategy. Return either a `NoRebalance` (with reasoning) or
   * a `RebalancePlan` describing the trades to execute. The runtime is
   * responsible for actually executing the plan via the Vault executor.
   */
  evaluate(input: StrategyInput, runtime?: StrategyRuntimeContext): Promise<StrategyDecision>;
  /**
   * Optional: declare the counter/fact updates the runtime should persist
   * to MemWal after this tick. The runtime calls it on BOTH noop and
   * rebalance paths, then writes the result to MemWal alongside the
   * decision-outcome record. On the next tick's recall, those counters
   * and facts appear in `StrategyMemory` so the strategy can read its
   * own past state.
   *
   * Pure function of (input, decision) — the strategy stays a pure
   * function. The runtime owns side effects.
   *
   * Return `null` (or omit the hook entirely) when the strategy is
   * stateless across ticks.
   */
  prepareMemoryWrite?(args: {
    input: StrategyInput;
    decision: StrategyDecision;
    runtime?: StrategyRuntimeContext;
  }): Promise<MemoryWrite | null>;
}

/**
 * Strategy-declared memory updates the runtime should persist after the
 * current tick. Merged with the decision-outcome record into a single
 * MemWal entry. On next tick's recall, the latest entry's counters/facts
 * populate `StrategyMemory`.
 */
export interface MemoryWrite {
  /**
   * Per-tick counter values (numeric). The runtime persists the entire
   * map — partial updates are NOT merged. If you want to keep a value,
   * read it from `input.memory.counters` and include it in your return.
   */
  counters?: Record<string, number>;
  /**
   * Per-tick free-form fact strings (typically prefixed with a tag like
   * `mr:hist:` for routing). Same semantics as counters: full replace,
   * not merge.
   */
  facts?: string[];
}

/** Input passed to every strategy evaluation. */
export interface StrategyInput {
  /** Vault's on-chain AgentIdentity object ID. */
  vaultId: string;
  /** Current portfolio holdings, normalized to USD value. */
  holdings: HoldingSnapshot[];
  /** Total NAV in USD (sum of holdings). */
  navUsd: number;
  /** Live market data (oracle prices, DeepBookV3 spreads). */
  market: MarketSnapshot;
  /** Strategy memory recalled from MemWal. May be empty on first run. */
  memory: StrategyMemory;
  /** Current Sui epoch — used for time-based logic. */
  currentEpoch: bigint;
  /** Vault's policy bounds (so strategies can self-check). */
  policy: VaultPolicy;
}

export interface HoldingSnapshot {
  /** Fully-qualified type tag, e.g. `0x2::sui::SUI`. */
  coinTypeTag: string;
  /** Human-readable symbol — derived, not on-chain. */
  symbol: string;
  /** Raw atomic units. */
  amount: bigint;
  /** Number of decimals for display. */
  decimals: number;
  /** Current spot price in USD per unit (decimal-adjusted). */
  priceUsd: number;
  /** Derived USD value. */
  valueUsd: number;
}

export interface MarketSnapshot {
  /** Per-symbol oracle prices in USD. */
  prices: Record<string, number>;
  /** Active DeepBookV3 pools the vault can route through. */
  pools: PoolSnapshot[];
  /** ISO 8601 timestamp of this snapshot. */
  asOf: string;
}

export interface PoolSnapshot {
  poolId: string;
  baseTypeTag: string;
  quoteTypeTag: string;
  /** Best bid price (quote per base, decimal-adjusted). */
  bestBid: number;
  /** Best ask price (quote per base, decimal-adjusted). */
  bestAsk: number;
  /** Mid price. */
  mid: number;
  /** 24h volume in base units. */
  volume24h: number;
}

export interface StrategyMemory {
  /** Most recent past decisions, oldest first. */
  recentDecisions: PastDecision[];
  /** Long-running counters the strategy maintains (e.g., realized PnL). */
  counters: Record<string, number>;
  /** Free-form learned facts: "BTC volatility regime", "Last fed announcement". */
  facts: string[];
}

export interface PastDecision {
  decisionId: string;
  epoch: bigint;
  kind: 'rebalance' | 'noop';
  rationale: string;
  realizedPnlUsd?: number;
}

export interface VaultPolicy {
  /** Per-epoch spend cap in USD. */
  spendPerEpochUsd: number;
  /** Contract package allowlist. */
  approvedPackages: string[];
  /** Expiry epoch. */
  expiryEpoch: bigint;
  /** Whether the vault is currently revoked. */
  revoked: boolean;
}

// =============================================================================
// Strategy decision (no-op OR plan)
// =============================================================================

export type StrategyDecision = NoRebalance | RebalancePlan;

export interface NoRebalance {
  kind: 'noop';
  /** Human-readable explanation logged to the audit timeline. */
  rationale: string;
  /** Optional structured signals the strategy considered. */
  signals?: Record<string, number | string | boolean>;
}

export interface RebalancePlan {
  kind: 'rebalance';
  /** Deterministic plan ID (e.g., sha256 of inputs). */
  planId: string;
  /** Human-readable summary for the audit timeline. */
  summary: string;
  /** Ordered list of trades to execute atomically in one PTB. */
  trades: PlannedTrade[];
  /** Long-form rationale to materialize as a Walrus artifact. */
  rationaleMarkdown: string;
  /** Structured signals (oracle prices, drift %, etc.) for the report. */
  signals: Record<string, number | string | boolean>;
}

export interface PlannedTrade {
  /** DeepBookV3 pool ID. */
  poolId: string;
  /** Source token type tag. */
  fromTypeTag: string;
  /** Destination token type tag. */
  toTypeTag: string;
  /** Amount of source token to spend (atomic units). */
  amountIn: bigint;
  /** Minimum acceptable output (slippage guard, atomic units). */
  minAmountOut: bigint;
  /** Direction discriminant matching `synapse_core::deepbook_adapter::DIR_*`. */
  direction: 0 | 1;
}

// =============================================================================
// Execution receipt (returned by the executor after running a plan)
// =============================================================================

export interface ExecutionReceipt {
  planId: string;
  /** Sui transaction digest of the executed PTB. */
  txDigest: string;
  /** Per-trade actuals (output may differ from min due to slippage). */
  trades: ExecutedTrade[];
  /** Walrus blob ID of the rendered audit report. */
  reportWalrusBlobId: string;
  /** Walrus blob object ID (on-chain Sui object holding the blob). */
  reportBlobObjectId: string;
  /** Synapse artifact slot allocated for the report. */
  artifactSlot: bigint;
  /** Epoch the rebalance executed in. */
  epoch: bigint;
  /** UTC ISO timestamp the executor returned. */
  executedAt: string;
}

export interface ExecutedTrade {
  poolId: string;
  fromTypeTag: string;
  toTypeTag: string;
  amountIn: bigint;
  amountOut: bigint;
  /** Effective execution price (toAmount / fromAmount in quote-per-base form). */
  executionPrice: number;
}

// =============================================================================
// Audit report (rendered as markdown, persisted to Walrus)
// =============================================================================

export interface AuditReport {
  /** Matches the RebalancePlan it derives from. */
  planId: string;
  /** Vault ID this report belongs to. */
  vaultId: string;
  /** Strategy that produced the plan. */
  strategyId: string;
  /** ISO timestamp the report was rendered. */
  renderedAt: string;
  /** Sui epoch when the rebalance executed. */
  epoch: bigint;
  /** Full markdown body (the thing stored on Walrus). */
  markdown: string;
  /** SHA256 of `markdown` (32 bytes). */
  sha256: Uint8Array;
}

// =============================================================================
// Fee accrual (1% AUM + 0.5% performance)
// =============================================================================

export interface FeeSchedule {
  /** Management fee, expressed in basis points per year (e.g., 100 = 1%). */
  managementFeeBps: number;
  /** Performance fee, expressed in basis points of realized alpha (e.g., 50 = 0.5%). */
  performanceFeeBps: number;
  /** Benchmark used to compute alpha. `none` for absolute-return strategies. */
  benchmark: 'sui_usd_index' | 'usdc_yield_curve' | 'none';
}

export const DEFAULT_FEE_SCHEDULE: FeeSchedule = {
  managementFeeBps: 100,
  performanceFeeBps: 50,
  benchmark: 'sui_usd_index',
};
