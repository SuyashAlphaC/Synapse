import {
  buildStrategyRecallQuery,
  buildStrategyStateRecallQuery,
  createMemWalClient,
  recall,
  rememberAndWait,
  STRATEGY_RECALL_LIMIT,
  STRATEGY_RECALL_MAX,
  type MemWal,
  type RecallResult,
} from '@synapse-core/memwal-bridge';
import type { AgentIdentity } from '@synapse-core/client';
import type {
  ExecutionReceipt,
  MemoryWrite,
  PastDecision,
  StrategyDecision,
  StrategyMemory,
} from '../types.js';

export interface RuntimeMemWalConfig {
  delegateKeyHex: string;
  relayerUrl?: string;
}

export function createRuntimeMemWalClient(args: {
  identity: AgentIdentity;
  config: RuntimeMemWalConfig;
}): MemWal | null {
  if (args.identity.memwalAccountId.length === 0 || args.identity.memwalNamespace.length === 0) {
    return null;
  }
  return createMemWalClient({
    identity: args.identity,
    credentials: {
      delegateKeyHex: args.config.delegateKeyHex,
      ...(args.config.relayerUrl ? { serverUrl: args.config.relayerUrl } : {}),
    },
  });
}

/** Per-strategy markers used to filter shared-namespace recall rows. */
const STRATEGY_STATE_MARKERS: Readonly<
  Record<string, { counters: readonly string[]; factPrefixes: readonly string[] }>
> = {
  'momentum-yield-maximizer': { counters: ['mymTicks'], factPrefixes: ['mym:'] },
  'peer-coordinated-yield': { counters: ['pcyTicks'], factPrefixes: ['pcy:'] },
  'dca-twap': { counters: ['dca_tick_index'], factPrefixes: [] },
  'llm-advisor': { counters: ['llmTicks'], factPrefixes: [] },
};

/**
 * Reconstruct a strategy's `StrategyMemory` from MemWal.
 *
 * Two layers of recall:
 *   1. Every past `synapse.strategy.outcome` entry → parsed into
 *      `recentDecisions[]`. Sorted oldest-first so strategies can iterate
 *      with consistent semantics.
 *   2. The LATEST entry's `counters` + `facts` (if present) → wholesale
 *      becomes the active `memory.counters` and `memory.facts`. This is
 *      how per-strategy state (EMAs, tick counters, rolling histories)
 *      survives across ticks.
 *
 * Decision-format JSON entries always win over free-form facts. Any
 * memory entry whose text isn't recognisable JSON is treated as a
 * free-form fact and appended to `facts` for strategy-side inspection
 * (e.g. an externally-injected `freeze:risk-off` flag).
 */
export async function recallStrategyMemory(args: {
  client: MemWal;
  namespace: string;
  strategyId: string;
}): Promise<StrategyMemory> {
  const result = await recallStrategyOutcomeRows(args);

  const decisions: ParsedOutcomeRow[] = [];
  const freeformFacts: string[] = [];

  for (const memory of result.results) {
    const parsed = parseOutcome(memory.text);
    if (parsed) {
      decisions.push({
        entry: parsed.decision,
        epoch: parsed.decision.epoch,
        executedAtMs: parsed.executedAtMs,
        raw: parsed,
      });
    } else {
      freeformFacts.push(memory.text);
    }
  }

  decisions.sort((a, b) => {
    const epochDiff = Number(a.epoch - b.epoch);
    if (epochDiff !== 0) return epochDiff;
    return a.executedAtMs - b.executedAtMs;
  });

  const latest = pickLatestStrategyOutcome(decisions, args.strategyId);

  const counters = latest?.raw.counters ?? {};
  const taggedFacts = latest?.raw.facts ?? [];
  const facts = [...taggedFacts, ...freeformFacts];

  return {
    recentDecisions: decisions.map((d) => d.entry),
    counters: { ...counters, recalled: result.total },
    facts,
  };
}

export interface ParsedOutcomeRow {
  entry: PastDecision;
  epoch: bigint;
  executedAtMs: number;
  raw: ParsedOutcome;
}

export function outcomeMatchesStrategy(raw: ParsedOutcome, strategyId: string): boolean {
  if (raw.strategyId !== undefined) {
    return raw.strategyId === strategyId;
  }

  const markers = STRATEGY_STATE_MARKERS[strategyId];
  if (!markers) return true;

  if (markers.counters.some((key) => typeof raw.counters[key] === 'number')) {
    return true;
  }
  return markers.factPrefixes.some((prefix) => raw.facts.some((fact) => fact.startsWith(prefix)));
}

/**
 * Among recalled outcomes for this strategy, pick the row with the most
 * advanced persisted state (epoch → executedAt → strategy counters → px series).
 */
export function pickLatestStrategyOutcome(
  decisions: ParsedOutcomeRow[],
  strategyId: string,
): ParsedOutcomeRow | null {
  const scoped = decisions.filter((d) => outcomeMatchesStrategy(d.raw, strategyId));
  if (scoped.length === 0) return null;

  let best = scoped[0]!;
  for (let i = 1; i < scoped.length; i++) {
    const candidate = scoped[i]!;
    if (compareStrategyOutcome(candidate, best, strategyId) > 0) {
      best = candidate;
    }
  }
  return best;
}

function compareStrategyOutcome(
  candidate: ParsedOutcomeRow,
  best: ParsedOutcomeRow,
  strategyId: string,
): number {
  const epochCmp = Number(candidate.epoch - best.epoch);
  if (epochCmp !== 0) return epochCmp;

  if (candidate.executedAtMs !== best.executedAtMs) {
    return candidate.executedAtMs > best.executedAtMs ? 1 : -1;
  }

  const counterCmp = strategyAdvancementScore(candidate.raw.counters, strategyId)
    - strategyAdvancementScore(best.raw.counters, strategyId);
  if (counterCmp !== 0) return counterCmp;

  const factCmp =
    seriesLengthFromFacts(candidate.raw.facts, strategyId)
    - seriesLengthFromFacts(best.raw.facts, strategyId);
  if (factCmp !== 0) return factCmp;

  return counterSum(candidate.raw.counters) - counterSum(best.raw.counters);
}

function strategyAdvancementScore(
  counters: Record<string, number>,
  strategyId: string,
): number {
  const markers = STRATEGY_STATE_MARKERS[strategyId];
  if (!markers || markers.counters.length === 0) {
    return counterSum(counters);
  }
  let best = 0;
  for (const key of markers.counters) {
    const value = counters[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      best = Math.max(best, value);
    }
  }
  return best;
}

function seriesLengthFromFacts(facts: string[], strategyId: string): number {
  const pxPrefix =
    strategyId === 'momentum-yield-maximizer'
      ? 'mym:px:'
      : strategyId === 'peer-coordinated-yield'
        ? 'pcy:px:'
        : null;
  if (!pxPrefix) return 0;
  const fact = facts.find((f) => f.startsWith(pxPrefix));
  if (!fact) return 0;
  return fact
    .slice(pxPrefix.length)
    .split(',')
    .filter((part) => part.length > 0).length;
}

function counterSum(counters: Record<string, number>): number {
  let s = 0;
  for (const v of Object.values(counters)) s += v;
  return s;
}

async function recallStrategyOutcomeRows(args: {
  client: MemWal;
  namespace: string;
  strategyId: string;
}): Promise<{ results: NonNullable<RecallResult['results']>; total: number }> {
  const primaryQuery = buildStrategyRecallQuery(args.strategyId);
  const first = await recall({
    client: args.client,
    namespace: args.namespace,
    query: primaryQuery,
    limit: STRATEGY_RECALL_LIMIT,
  });

  let merged = [...(first.results ?? [])];
  let total = first.total;

  if (total > merged.length) {
    const expandedLimit = Math.min(Math.max(total, STRATEGY_RECALL_LIMIT), STRATEGY_RECALL_MAX);
    if (expandedLimit > STRATEGY_RECALL_LIMIT) {
      const expanded = await recall({
        client: args.client,
        namespace: args.namespace,
        query: primaryQuery,
        limit: expandedLimit,
      });
      merged = mergeRecallRows(merged, expanded.results ?? []);
      total = Math.max(total, expanded.total);
    }
  }

  if (total > merged.length) {
    const state = await recall({
      client: args.client,
      namespace: args.namespace,
      query: buildStrategyStateRecallQuery(args.strategyId),
      limit: STRATEGY_RECALL_MAX,
    });
    merged = mergeRecallRows(merged, state.results ?? []);
    total = Math.max(total, state.total);
  }

  return { results: merged, total };
}

function mergeRecallRows(
  primary: NonNullable<RecallResult['results']>,
  extra: NonNullable<RecallResult['results']>,
): NonNullable<RecallResult['results']> {
  if (extra.length === 0) return primary;
  const seen = new Set(primary.map((row) => row.text));
  const out = [...primary];
  for (const row of extra) {
    if (seen.has(row.text)) continue;
    seen.add(row.text);
    out.push(row);
  }
  return out;
}

/**
 * Persist this tick's outcome — including any strategy-declared
 * memory writes — to MemWal. Always fires (noop AND rebalance) so
 * per-strategy state advances every tick.
 *
 * `memoryWrite.counters` and `memoryWrite.facts` are the wholesale
 * replacement for next tick's `memory.counters` and `memory.facts`.
 * Partial updates are not merged — the strategy is responsible for
 * carrying forward any prior values it wants to keep.
 */
export async function rememberStrategyOutcome(args: {
  memwal: MemWal | null;
  namespace: string;
  strategyId: string;
  decision: StrategyDecision;
  receipt: ExecutionReceipt;
  memoryWrite: MemoryWrite | null;
}): Promise<void> {
  if (!args.memwal) return;
  const payload: PersistedOutcome = {
    type: 'synapse.strategy.outcome',
    strategyId: args.strategyId,
    // Noop decisionIds must be unique across ticks in the same epoch
    // (testnet epochs span ~24h and easily hold dozens of noops).
    // Without uniqueness, MemWal stores many entries sharing the same
    // primary key, and semantic recall returns them in arbitrary
    // order. The `executedAt` millisecond timestamp gives a stable
    // unique suffix without changing the on-chain receipt shape.
    decisionId:
      args.decision.kind === 'rebalance'
        ? args.decision.planId
        : `noop-${args.receipt.epoch.toString()}-${Date.parse(args.receipt.executedAt) || Date.now()}`,
    epoch: args.receipt.epoch.toString(),
    kind: args.decision.kind,
    rationale:
      args.decision.kind === 'rebalance' ? args.decision.summary : args.decision.rationale,
    txDigest: args.receipt.txDigest,
    reportWalrusBlobId: args.receipt.reportWalrusBlobId,
    executedAt: args.receipt.executedAt,
    counters: args.memoryWrite?.counters ?? {},
    facts: args.memoryWrite?.facts ?? [],
  };
  await rememberAndWait({
    client: args.memwal,
    namespace: args.namespace,
    text: JSON.stringify(payload),
    timeoutMs: 120_000,
  });
}

export function emptyStrategyMemory(): StrategyMemory {
  return {
    recentDecisions: [],
    counters: {},
    facts: [],
  };
}

export function namespaceFromIdentity(identity: AgentIdentity): string {
  if (identity.memwalNamespace.length === 0) return `synapse:${identity.id}`;
  return new TextDecoder('utf-8', { fatal: false }).decode(identity.memwalNamespace);
}

// ---------------------------------------------------------------------------
// Internal: outcome record format
// ---------------------------------------------------------------------------

interface PersistedOutcome {
  type: 'synapse.strategy.outcome';
  strategyId: string;
  decisionId: string;
  epoch: string;
  kind: 'rebalance' | 'noop';
  rationale: string;
  txDigest: string;
  reportWalrusBlobId: string;
  executedAt: string;
  counters: Record<string, number>;
  facts: string[];
}

export interface ParsedOutcome {
  decision: PastDecision;
  counters: Record<string, number>;
  facts: string[];
  strategyId?: string;
  /** Millisecond timestamp from the payload's `executedAt` ISO field — used as the within-epoch sort tiebreaker. */
  executedAtMs: number;
}

function parseOutcome(text: string): ParsedOutcome | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.type !== 'synapse.strategy.outcome') return null;

    const decisionId = stringValue(record.decisionId);
    const epochText = stringValue(record.epoch);
    const kind = record.kind === 'rebalance' || record.kind === 'noop' ? record.kind : null;
    const rationale = stringValue(record.rationale);
    if (!decisionId || !epochText || !kind || !rationale) return null;

    const counters = sanitizeNumberMap(record.counters);
    const facts = sanitizeStringArray(record.facts);
    const executedAtRaw = stringValue(record.executedAt);
    const executedAtMs = executedAtRaw ? Date.parse(executedAtRaw) || 0 : 0;
    const strategyId = stringValue(record.strategyId) ?? undefined;

    return {
      decision: { decisionId, epoch: BigInt(epochText), kind, rationale },
      executedAtMs,
      counters,
      facts,
      ...(strategyId !== undefined ? { strategyId } : {}),
    };
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function sanitizeNumberMap(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}
