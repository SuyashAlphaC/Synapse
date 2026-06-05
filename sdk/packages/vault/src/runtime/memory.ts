import {
  buildStrategyRecallQuery,
  createMemWalClient,
  recall,
  rememberAndWait,
  STRATEGY_RECALL_LIMIT,
  type MemWal,
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
  const result = await recall({
    client: args.client,
    namespace: args.namespace,
    query: buildStrategyRecallQuery(args.strategyId),
    limit: STRATEGY_RECALL_LIMIT,
  });

  const decisions: Array<{
    entry: PastDecision;
    epoch: bigint;
    executedAtMs: number;
    raw: ParsedOutcome;
  }> = [];
  const freeformFacts: string[] = [];

  for (const memory of result.results) {
    const parsed = parseOutcome(memory.text);
    if (parsed) {
      const executedAtMs = parsed.executedAtMs;
      decisions.push({
        entry: parsed.decision,
        epoch: parsed.decision.epoch,
        executedAtMs,
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

  // Identify the "latest" entry for counter/fact recovery. MemWal's
  // semantic recall returns entries by relevance, NOT chronological order,
  // and the recall window (limit=32) may still miss the absolute newest
  // entry. Sorting by (epoch, executedAtMs) is necessary but not
  // sufficient — two entries with the same epoch+timestamp can have
  // different counter values if the previous persist was slow.
  //
  // Robust tiebreaker: among entries sharing the max epoch, pick the one
  // whose counter values are highest (monotonically increasing counters
  // like dca_tick_index are the canonical state-advancement signal).
  // This prevents a stale MemWal recall from stalling the counter.
  const latest = pickLatestOutcome(decisions);

  const counters = latest?.raw.counters ?? {};
  const taggedFacts = latest?.raw.facts ?? [];
  const facts = [...taggedFacts, ...freeformFacts];

  return {
    recentDecisions: decisions.map((d) => d.entry),
    counters: { ...counters, recalled: result.total },
    facts,
  };
}

/**
 * Among all recalled outcomes, pick the one with the most advanced state.
 * Primary key: highest epoch. Tiebreaker: highest executedAtMs. Final
 * tiebreaker: highest sum of counter values (catches the case where
 * MemWal recall returns two entries from the same millisecond but only
 * one has the incremented counter).
 */
function pickLatestOutcome(
  decisions: Array<{
    entry: PastDecision;
    epoch: bigint;
    executedAtMs: number;
    raw: ParsedOutcome;
  }>,
): (typeof decisions)[number] | null {
  if (decisions.length === 0) return null;

  let best = decisions[0];
  for (let i = 1; i < decisions.length; i++) {
    const candidate = decisions[i];
    const epochCmp = Number(candidate.epoch - best.epoch);
    if (epochCmp > 0) {
      best = candidate;
      continue;
    }
    if (epochCmp < 0) continue;

    // Same epoch — prefer later timestamp
    if (candidate.executedAtMs > best.executedAtMs) {
      best = candidate;
      continue;
    }
    if (candidate.executedAtMs < best.executedAtMs) continue;

    // Same epoch AND timestamp — prefer higher counter sum
    if (counterSum(candidate.raw.counters) > counterSum(best.raw.counters)) {
      best = candidate;
    }
  }
  return best;
}

function counterSum(counters: Record<string, number>): number {
  let s = 0;
  for (const v of Object.values(counters)) s += v;
  return s;
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
  decision: StrategyDecision;
  receipt: ExecutionReceipt;
  memoryWrite: MemoryWrite | null;
}): Promise<void> {
  if (!args.memwal) return;
  const payload: PersistedOutcome = {
    type: 'synapse.strategy.outcome',
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

interface ParsedOutcome {
  decision: PastDecision;
  counters: Record<string, number>;
  facts: string[];
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

    return {
      decision: { decisionId, epoch: BigInt(epochText), kind, rationale },
      executedAtMs,
      counters,
      facts,
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
