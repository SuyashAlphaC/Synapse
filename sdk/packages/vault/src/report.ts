/**
 * Audit report renderer. Materializes a `RebalancePlan` (or `NoRebalance`) into
 * a markdown document that gets stored on Walrus and indexed by the dashboard.
 *
 * Every report is deterministic given its inputs — same plan + same metadata
 * always produces byte-identical markdown. This makes audit comparison and
 * regulator export trivially reproducible.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import type {
  AuditReport,
  RebalancePlan,
  StrategyInput,
  NoRebalance,
} from './types.js';

const REPORT_VERSION = '1.0';

export interface RenderReportArgs {
  vaultId: string;
  strategyId: string;
  strategyVersion: string;
  epoch: bigint;
  input: StrategyInput;
  decision: RebalancePlan | NoRebalance;
  /** Fixed ISO timestamp (callers may inject for deterministic tests). */
  renderedAt?: string;
}

/**
 * Render a deterministic markdown audit report for a strategy decision.
 */
export function renderReport(args: RenderReportArgs): AuditReport {
  const renderedAt = args.renderedAt ?? new Date().toISOString();
  const markdown = buildMarkdown({
    vaultId: args.vaultId,
    strategyId: args.strategyId,
    strategyVersion: args.strategyVersion,
    epoch: args.epoch,
    renderedAt,
    input: args.input,
    decision: args.decision,
  });
  const digest = sha256(new TextEncoder().encode(markdown));
  return {
    planId: args.decision.kind === 'rebalance' ? args.decision.planId : `noop-${renderedAt}`,
    vaultId: args.vaultId,
    strategyId: args.strategyId,
    renderedAt,
    epoch: args.epoch,
    markdown,
    sha256: digest,
  };
}

interface BuildArgs {
  vaultId: string;
  strategyId: string;
  strategyVersion: string;
  epoch: bigint;
  renderedAt: string;
  input: StrategyInput;
  decision: RebalancePlan | NoRebalance;
}

function buildMarkdown(a: BuildArgs): string {
  const header = `# Synapse Vault — Audit Report

| Field | Value |
|---|---|
| Report version | ${REPORT_VERSION} |
| Vault | \`${a.vaultId}\` |
| Strategy | ${a.strategyId} v${a.strategyVersion} |
| Epoch | ${a.epoch.toString()} |
| Rendered at | ${a.renderedAt} |
| Decision | ${a.decision.kind.toUpperCase()} |

`;

  const portfolio = renderPortfolioSection(a.input);
  const market = renderMarketSection(a.input);
  const memory = renderMemorySection(a.input);
  const decision = renderDecisionSection(a.decision);

  return `${header}${portfolio}\n${market}\n${memory}\n${decision}`;
}

function renderPortfolioSection(input: StrategyInput): string {
  const rows = input.holdings
    .map((h) => {
      const display = Number(h.amount) / Math.pow(10, h.decimals);
      return `| ${h.symbol} | \`${h.coinTypeTag}\` | ${display.toFixed(6)} | $${h.priceUsd.toFixed(4)} | $${h.valueUsd.toFixed(2)} |`;
    })
    .join('\n');
  return `## Portfolio Snapshot

NAV: **$${input.navUsd.toFixed(2)}**

| Symbol | Type tag | Amount | Spot USD | Value USD |
|---|---|---|---|---|
${rows}
`;
}

function renderMarketSection(input: StrategyInput): string {
  const pools = input.market.pools
    .map(
      (p) =>
        `| \`${p.poolId.slice(0, 10)}…\` | ${p.baseTypeTag.split('::').pop()} / ${p.quoteTypeTag.split('::').pop()} | ${p.bestBid.toFixed(6)} | ${p.bestAsk.toFixed(6)} | ${p.mid.toFixed(6)} |`,
    )
    .join('\n');
  const prices = Object.entries(input.market.prices)
    .map(([sym, px]) => `- **${sym}** — $${px.toFixed(4)}`)
    .join('\n');
  return `## Market Snapshot

Observed at: ${input.market.asOf}

### Oracle prices
${prices || '- (none)'}

### DeepBookV3 pools
| Pool | Pair | Best bid | Best ask | Mid |
|---|---|---|---|---|
${pools || '| — | — | — | — | — |'}
`;
}

function renderMemorySection(input: StrategyInput): string {
  if (
    input.memory.recentDecisions.length === 0 &&
    input.memory.facts.length === 0 &&
    Object.keys(input.memory.counters).length === 0
  ) {
    return `## Strategy Memory

_(empty — first run, or memory was reset)_
`;
  }

  const decisions = input.memory.recentDecisions
    .map(
      (d) =>
        `- **${d.kind.toUpperCase()}** at epoch ${d.epoch.toString()} — ${d.rationale}${
          d.realizedPnlUsd !== undefined ? ` (PnL: $${d.realizedPnlUsd.toFixed(2)})` : ''
        }`,
    )
    .join('\n');

  const facts = input.memory.facts.map((f) => `- ${f}`).join('\n');

  const counters = Object.entries(input.memory.counters)
    .map(([k, v]) => `- **${k}** = ${v}`)
    .join('\n');

  return `## Strategy Memory (recalled from MemWal)

### Recent decisions
${decisions || '- (none)'}

### Learned facts
${facts || '- (none)'}

### Counters
${counters || '- (none)'}
`;
}

function renderDecisionSection(decision: RebalancePlan | NoRebalance): string {
  if (decision.kind === 'noop') {
    const signals = decision.signals
      ? Object.entries(decision.signals)
          .map(([k, v]) => `- **${k}** = ${formatSignal(v)}`)
          .join('\n')
      : '- (none recorded)';
    return `## Decision: No Rebalance

**Rationale:** ${decision.rationale}

### Signals considered
${signals}
`;
  }

  const trades = decision.trades
    .map(
      (t, i) =>
        `${i + 1}. \`${t.fromTypeTag.split('::').pop()}\` → \`${t.toTypeTag.split('::').pop()}\` · in=${t.amountIn.toString()} · min_out=${t.minAmountOut.toString()} · pool=\`${t.poolId.slice(0, 10)}…\``,
    )
    .join('\n');

  const signals = Object.entries(decision.signals)
    .map(([k, v]) => `- **${k}** = ${formatSignal(v)}`)
    .join('\n');

  return `## Decision: Rebalance

**Plan ID:** \`${decision.planId}\`

**Summary:** ${decision.summary}

### Trades to execute
${trades}

### Signals
${signals || '- (none recorded)'}

### Rationale
${decision.rationaleMarkdown}
`;
}

function formatSignal(v: number | string | boolean): string {
  if (typeof v === 'number') return v.toFixed(6);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v;
}
