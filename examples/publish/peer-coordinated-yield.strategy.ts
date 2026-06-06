/**
 * Peer-Coordinated Yield — Walrus-publishable strategy.
 *
 * Extends momentum + vol/drawdown posture with cross-agent inputs:
 *   - Sui Stack Messaging facts: `peer 0x…: signal @epoch: …`
 *   - MemWal cross-agent reads:  `xattr:0xwriter:blobId:…`
 *
 * Peer de-risk consensus (messaging + xattr) tilts toward stable;
 * yield-tilt consensus nudges base weight up. Deterministic — no LLM.
 */

interface PoolSnapshot {
  poolId: string;
  mid?: number;
  bestBid?: number;
  bestAsk?: number;
  volume24h?: number;
}

interface StrategyInput {
  vaultId: string;
  holdings: Array<{
    coinTypeTag: string;
    symbol: string;
    amount: bigint;
    decimals: number;
    priceUsd: number;
    valueUsd: number;
  }>;
  navUsd: number;
  market: { prices: Record<string, number>; pools: PoolSnapshot[] };
  memory: { recentDecisions: unknown[]; counters: Record<string, number>; facts: string[] };
  currentEpoch: bigint;
  policy: {
    revoked: boolean;
    expiryEpoch: bigint;
    spendPerEpochUsd: number;
    approvedPackages: string[];
  };
}

type StrategyDecision =
  | { kind: 'noop'; rationale: string; signals?: Record<string, unknown> }
  | {
      kind: 'rebalance';
      planId: string;
      summary: string;
      trades: Array<{
        poolId: string;
        fromTypeTag: string;
        toTypeTag: string;
        amountIn: bigint;
        minAmountOut: bigint;
        direction: 0 | 1;
      }>;
      rationaleMarkdown?: string;
      signals?: Record<string, unknown>;
    };

const CONFIG = {
  baseTypeTag:
    '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
  baseSymbol: 'SUI',
  quoteTypeTag:
    '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC',
  quoteSymbol: 'DBUSDC',
  poolId: '0x1c19362ca52b8ffd7a33cee805a67d40f31e6ba303753fd3a4cfdfacea7163a5',

  priceWindow: 36,
  minWarmupSamples: 10,
  momentumShort: 6,
  momentumLong: 18,

  minBaseWeight: 0.32,
  maxBaseWeight: 0.72,
  neutralBaseWeight: 0.55,

  driftThresholdCalm: 0.022,
  driftThresholdStress: 0.055,
  slippageCalm: 0.004,
  slippageStress: 0.01,
  stressVol: 0.042,
  emergencyDrawdown: 0.06,
  tradeCooldownEpochs: 1,
  cooldownDriftMultiplier: 1.8,

  /** Max absolute weight shift from peer/xattr consensus. */
  maxPeerBias: 0.14,
  /** Each de-risk vote applies this downward bias (before cap). */
  peerDeRiskStep: 0.035,
  /** Each yield-tilt vote applies this upward bias (before cap). */
  peerYieldStep: 0.03,
  /** Strong de-risk quorum → clamp to min base weight. */
  peerDeRiskQuorum: 2,
} as const;

const STRATEGY_ID = 'peer-coordinated-yield';
const PRICE_FACT_PREFIX = 'pcy:px:';
const PEAK_FACT_PREFIX = 'pcy:peak:';
const PEER_PREFIX = 'peer ';
const XATTR_PREFIX = 'xattr:';
const XATTR_SEEN_PREFIX = 'xattr:seen:';

function normalizeCoinTypeTag(tag: string): string {
  const trimmed = tag.trim();
  const parts = trimmed.split('::');
  if (parts.length < 3) return trimmed;
  let addr = parts[0]!;
  if (addr.startsWith('0x') || addr.startsWith('0X')) addr = addr.slice(2);
  addr = addr.toLowerCase().padStart(64, '0');
  return `0x${addr}::${parts[1]}::${parts[2]}`;
}

function sameCoinType(a: string, b: string): boolean {
  return normalizeCoinTypeTag(a) === normalizeCoinTypeTag(b);
}

function findHolding(
  holdings: StrategyInput['holdings'],
  configTypeTag: string,
): StrategyInput['holdings'][number] | undefined {
  return holdings.find((h) => sameCoinType(h.coinTypeTag, configTypeTag));
}

function findPool(pools: PoolSnapshot[], configPoolId: string): PoolSnapshot | undefined {
  const want = configPoolId.toLowerCase();
  return pools.find((p) => p.poolId.toLowerCase() === want);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function usdToAtomic(usd: number, priceUsd: number, decimals: number): bigint {
  if (!Number.isFinite(usd) || !Number.isFinite(priceUsd) || priceUsd <= 0) return 0n;
  return BigInt(Math.max(0, Math.floor((usd / priceUsd) * 10 ** decimals)));
}

function computePlanId(
  vaultId: string,
  epoch: bigint,
  trades: Array<{ poolId: string; direction: number; amountIn: bigint }>,
): string {
  const short = vaultId.startsWith('0x') ? vaultId.slice(2, 10) : vaultId.slice(0, 8);
  const fp = trades
    .map((t) => `${t.poolId.slice(2, 6)}${t.direction}${t.amountIn.toString(36)}`)
    .join('-');
  return `pcy-${short}-e${epoch.toString()}-${fp}`;
}

function readPriceHistory(facts: string[]): number[] {
  const fact = facts.find((f) => f.startsWith(PRICE_FACT_PREFIX));
  if (!fact) return [];
  return fact
    .slice(PRICE_FACT_PREFIX.length)
    .split(',')
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice(-CONFIG.priceWindow);
}

function readPeak(facts: string[]): number {
  const fact = facts.find((f) => f.startsWith(PEAK_FACT_PREFIX));
  if (!fact) return 0;
  const n = Number(fact.slice(PEAK_FACT_PREFIX.length));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function logReturns(prices: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1]!;
    const cur = prices[i]!;
    if (prev > 0 && cur > 0) out.push(Math.log(cur / prev));
  }
  return out;
}

function realizedVol(prices: number[]): number {
  const rets = logReturns(prices);
  if (rets.length < 2) return 0;
  const mean = rets.reduce((a, x) => a + x, 0) / rets.length;
  const variance = rets.reduce((a, x) => a + (x - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function cumulativeReturn(prices: number[], lookback: number): number {
  if (prices.length < lookback + 1) return 0;
  const start = prices[prices.length - lookback - 1]!;
  const end = prices[prices.length - 1]!;
  if (start <= 0 || end <= 0) return 0;
  return end / start - 1;
}

function momentumScore(prices: number[]): number {
  const short = cumulativeReturn(prices, CONFIG.momentumShort);
  const long = cumulativeReturn(prices, Math.min(CONFIG.momentumLong, prices.length - 1));
  return 0.55 * short + 0.45 * long;
}

function classifyRegime(vol: number, drawdown: number): 'calm' | 'elevated' | 'stress' {
  if (drawdown >= CONFIG.emergencyDrawdown || vol >= CONFIG.stressVol) return 'stress';
  if (vol >= CONFIG.stressVol * 0.55) return 'elevated';
  return 'calm';
}

interface PeerSignalSummary {
  bias: number;
  deRiskVotes: number;
  yieldVotes: number;
  peerMessages: number;
  xattrReads: number;
  forceMinBase: boolean;
}

function classifyPeerText(text: string): 'deRisk' | 'yield' | 'neutral' {
  const lower = text.toLowerCase();
  if (
    lower.includes('trim base') ||
    lower.includes('de-risk') ||
    lower.includes('derisk') ||
    lower.includes('risk-off') ||
    lower.includes('freeze') ||
    (lower.includes('hold') && lower.includes('noop'))
  ) {
    return 'deRisk';
  }
  if (
    lower.includes('add base') ||
    lower.includes('yield tilt') ||
    lower.includes('accumulate') ||
    (lower.includes('rebalance') && !lower.includes('trim'))
  ) {
    return 'yield';
  }
  return 'neutral';
}

/** Scan recent memory facts injected by messaging + cross-agent read. */
function analyzePeerSignals(facts: readonly string[]): PeerSignalSummary {
  let deRiskVotes = 0;
  let yieldVotes = 0;
  let peerMessages = 0;
  let xattrReads = 0;

  for (const fact of facts) {
    if (fact.startsWith(PEER_PREFIX)) {
      peerMessages += 1;
      const vote = classifyPeerText(fact);
      if (vote === 'deRisk') deRiskVotes += 1;
      if (vote === 'yield') yieldVotes += 1;
    } else if (fact.startsWith(XATTR_PREFIX) && !fact.startsWith(XATTR_SEEN_PREFIX)) {
      xattrReads += 1;
      const vote = classifyPeerText(fact);
      if (vote === 'deRisk') deRiskVotes += 1;
      if (vote === 'yield') yieldVotes += 1;
    }
  }

  let bias = yieldVotes * CONFIG.peerYieldStep - deRiskVotes * CONFIG.peerDeRiskStep;
  bias = Math.max(-CONFIG.maxPeerBias, Math.min(CONFIG.maxPeerBias, bias));

  const forceMinBase = deRiskVotes >= CONFIG.peerDeRiskQuorum && yieldVotes === 0;

  return { bias, deRiskVotes, yieldVotes, peerMessages, xattrReads, forceMinBase };
}

function targetBaseWeight(args: {
  momentum: number;
  vol: number;
  drawdown: number;
  regime: 'calm' | 'elevated' | 'stress';
  peer: PeerSignalSummary;
}): number {
  const { momentum, vol, drawdown, regime, peer } = args;

  if (peer.forceMinBase || regime === 'stress' || drawdown >= CONFIG.emergencyDrawdown) {
    return CONFIG.minBaseWeight;
  }

  const momClamped = Math.max(-0.15, Math.min(0.15, momentum));
  const momNorm = (momClamped + 0.15) / 0.3;
  const volPenalty = clamp01(vol / CONFIG.stressVol);
  const drawdownPenalty = clamp01(drawdown / CONFIG.emergencyDrawdown);

  let target =
    CONFIG.minBaseWeight +
    momNorm * (CONFIG.maxBaseWeight - CONFIG.minBaseWeight) * (1 - 0.35 * volPenalty);

  if (regime === 'elevated') {
    target = CONFIG.neutralBaseWeight + (target - CONFIG.neutralBaseWeight) * 0.55;
  }

  target -= drawdownPenalty * (target - CONFIG.minBaseWeight) * 0.65;
  target += peer.bias;

  return clamp01(Math.max(CONFIG.minBaseWeight, Math.min(CONFIG.maxBaseWeight, target)));
}

function effectiveDriftThreshold(regime: 'calm' | 'elevated' | 'stress'): number {
  if (regime === 'stress') return CONFIG.driftThresholdStress;
  if (regime === 'elevated') {
    return (CONFIG.driftThresholdCalm + CONFIG.driftThresholdStress) / 2;
  }
  return CONFIG.driftThresholdCalm;
}

function effectiveSlippage(regime: 'calm' | 'elevated' | 'stress'): number {
  return regime === 'stress' ? CONFIG.slippageStress : CONFIG.slippageCalm;
}

function poolSpreadBps(pool: PoolSnapshot): number {
  const bid = pool.bestBid ?? pool.mid;
  const ask = pool.bestAsk ?? pool.mid;
  const mid = pool.mid ?? (bid && ask ? (bid + ask) / 2 : undefined);
  if (!mid || !bid || !ask || mid <= 0) return 0;
  return ((ask - bid) / mid) * 10_000;
}

function buildRebalancePlan(args: {
  input: StrategyInput;
  base: StrategyInput['holdings'][number];
  quote: StrategyInput['holdings'][number];
  targetBaseWeight: number;
  driftThreshold: number;
  slippageTolerance: number;
  signals: Record<string, unknown>;
}): StrategyDecision {
  const totalUsd = args.base.valueUsd + args.quote.valueUsd;
  const actualBaseWeight = totalUsd > 0 ? args.base.valueUsd / totalUsd : 0;
  const drift = actualBaseWeight - args.targetBaseWeight;
  const absDrift = Math.abs(drift);

  if (absDrift < args.driftThreshold) {
    return {
      kind: 'noop',
      rationale: `Drift ${(absDrift * 100).toFixed(2)}% below ${(args.driftThreshold * 100).toFixed(2)}% — hold (peer-aware).`,
      signals: { ...args.signals, actualBaseWeight, targetBaseWeight: args.targetBaseWeight, absDrift },
    };
  }

  const pool = findPool(args.input.market.pools, CONFIG.poolId);
  if (!pool) {
    return { kind: 'noop', rationale: `Pool ${CONFIG.poolId} unavailable.`, signals: args.signals };
  }

  const spreadBps = poolSpreadBps(pool);
  if (spreadBps > 35 && absDrift < args.driftThreshold * 1.35) {
    return {
      kind: 'noop',
      rationale: `Wide spread (${spreadBps.toFixed(1)} bps) — defer rebalance.`,
      signals: { ...args.signals, spreadBps, actualBaseWeight, absDrift },
    };
  }

  const targetBaseUsd = totalUsd * args.targetBaseWeight;
  const baseExcessUsd = args.base.valueUsd - targetBaseUsd;
  let trades: Extract<StrategyDecision, { kind: 'rebalance' }>['trades'];

  if (baseExcessUsd > 0) {
    trades = [
      {
        poolId: CONFIG.poolId,
        fromTypeTag: args.base.coinTypeTag,
        toTypeTag: args.quote.coinTypeTag,
        amountIn: usdToAtomic(baseExcessUsd, args.base.priceUsd, args.base.decimals),
        minAmountOut: usdToAtomic(
          baseExcessUsd * (1 - args.slippageTolerance),
          args.quote.priceUsd,
          args.quote.decimals,
        ),
        direction: 0,
      },
    ];
  } else {
    const buyUsd = -baseExcessUsd;
    trades = [
      {
        poolId: CONFIG.poolId,
        fromTypeTag: args.quote.coinTypeTag,
        toTypeTag: args.base.coinTypeTag,
        amountIn: usdToAtomic(buyUsd, args.quote.priceUsd, args.quote.decimals),
        minAmountOut: usdToAtomic(
          buyUsd * (1 - args.slippageTolerance),
          args.base.priceUsd,
          args.base.decimals,
        ),
        direction: 1,
      },
    ];
  }

  if (trades[0]!.amountIn <= 0n) {
    return {
      kind: 'noop',
      rationale: 'Computed trade size rounds to zero — hold.',
      signals: { ...args.signals, actualBaseWeight, absDrift },
    };
  }

  const direction = baseExcessUsd > 0 ? 'trim base (peer/coord de-risk)' : 'add base (peer/coord yield)';

  return {
    kind: 'rebalance',
    planId: computePlanId(args.input.vaultId, args.input.currentEpoch, trades),
    summary: `Peer-coordinated yield: ${direction} → ${(args.targetBaseWeight * 100).toFixed(1)}% ${CONFIG.baseSymbol}`,
    trades,
    rationaleMarkdown: [
      '### Peer-Coordinated Yield',
      '',
      `- **Regime**: ${String(args.signals.regime)}`,
      `- **Momentum**: ${Number(args.signals.momentum).toFixed(4)}`,
      `- **Peer bias**: ${Number(args.signals.peerBias).toFixed(4)} (de-risk ${args.signals.peerDeRiskVotes}, yield ${args.signals.peerYieldVotes})`,
      `- **Peer messages / xattr reads**: ${args.signals.peerMessages} / ${args.signals.xattrReads}`,
      `- **Target ${CONFIG.baseSymbol}**: ${(args.targetBaseWeight * 100).toFixed(2)}%`,
      `- **Actual**: ${(actualBaseWeight * 100).toFixed(2)}%`,
    ].join('\n'),
    signals: { ...args.signals, actualBaseWeight, targetBaseWeight: args.targetBaseWeight, drift, absDrift, spreadBps },
  };
}

function evaluate(input: StrategyInput): StrategyDecision {
  if (input.policy.revoked) return { kind: 'noop', rationale: 'Vault revoked.' };
  if (input.currentEpoch >= input.policy.expiryEpoch) {
    return { kind: 'noop', rationale: `Vault expired epoch ${input.policy.expiryEpoch}.` };
  }

  const base = findHolding(input.holdings, CONFIG.baseTypeTag);
  const quote = findHolding(input.holdings, CONFIG.quoteTypeTag);
  if (!base || !quote) {
    return {
      kind: 'noop',
      rationale: `Asset missing (base=${!!base}, quote=${!!quote}).`,
    };
  }

  const navUsd = base.valueUsd + quote.valueUsd;
  if (navUsd <= 0) return { kind: 'noop', rationale: 'NAV is zero.' };

  const peer = analyzePeerSignals(input.memory.facts);

  const prices = readPriceHistory(input.memory.facts);
  if (prices.length < CONFIG.minWarmupSamples) {
    return {
      kind: 'noop',
      rationale: `Warming up (${prices.length}/${CONFIG.minWarmupSamples}) — peer facts queued (${peer.peerMessages + peer.xattrReads}).`,
      signals: { samples: prices.length, peerMessages: peer.peerMessages, xattrReads: peer.xattrReads },
    };
  }

  const peakStored = readPeak(input.memory.facts);
  const peak = Math.max(peakStored, base.priceUsd, ...prices);
  const drawdown = peak > 0 ? Math.max(0, 1 - base.priceUsd / peak) : 0;
  const vol = realizedVol(prices);
  const momentum = momentumScore(prices);
  const regime = classifyRegime(vol, drawdown);
  const target = targetBaseWeight({ momentum, vol, drawdown, regime, peer });

  let driftThreshold = effectiveDriftThreshold(regime);
  const slippage = effectiveSlippage(regime);

  const lastTradeEpoch = input.memory.counters['pcyLastTradeEpoch'];
  const epochsSinceTrade =
    typeof lastTradeEpoch === 'number' ? Number(input.currentEpoch) - lastTradeEpoch : Infinity;

  if (epochsSinceTrade < CONFIG.tradeCooldownEpochs && drawdown < CONFIG.emergencyDrawdown) {
    driftThreshold *= CONFIG.cooldownDriftMultiplier;
  }

  return buildRebalancePlan({
    input,
    base,
    quote,
    targetBaseWeight: target,
    driftThreshold,
    slippageTolerance: slippage,
    signals: {
      regime,
      momentum,
      vol,
      drawdown,
      peak,
      peerBias: peer.bias,
      peerDeRiskVotes: peer.deRiskVotes,
      peerYieldVotes: peer.yieldVotes,
      peerMessages: peer.peerMessages,
      xattrReads: peer.xattrReads,
      peerForceMinBase: peer.forceMinBase,
      actualBaseWeight: navUsd > 0 ? base.valueUsd / navUsd : 0,
      targetBaseWeight: target,
      epochsSinceTrade,
      driftThreshold,
      samples: prices.length,
    },
  });
}

const strategy = {
  id: STRATEGY_ID,
  name: 'Peer-Coordinated Yield',
  version: '1.0.0',
  description:
    'Momentum + vol regime rebalancer that consumes Sui Stack Messaging peer signals ' +
    'and MemWal cross-agent read facts to coordinate allocation across vaults.',

  evaluate: async (input: StrategyInput): Promise<StrategyDecision> => evaluate(input),

  prepareMemoryWrite: async ({
    input,
    decision,
  }: {
    input: StrategyInput;
    decision: StrategyDecision;
  }) => {
    const base = findHolding(input.holdings, CONFIG.baseTypeTag);
    if (!base || base.priceUsd <= 0) return null;

    const history = readPriceHistory(input.memory.facts);
    history.push(base.priceUsd);
    const trimmed = history.slice(-CONFIG.priceWindow);
    const prevPeak = readPeak(input.memory.facts);
    const nextPeak = Math.max(prevPeak, base.priceUsd, ...trimmed);

    const carried = input.memory.facts.filter(
      (f) =>
        !f.startsWith(PRICE_FACT_PREFIX) &&
        !f.startsWith(PEAK_FACT_PREFIX) &&
        !f.startsWith('epoch ') &&
        !f.startsWith('pcy:tick:'),
    );

    const facts = [
      ...carried,
      `${PRICE_FACT_PREFIX}${trimmed.join(',')}`,
      `${PEAK_FACT_PREFIX}${nextPeak.toFixed(8)}`,
    ];

    const counters: Record<string, number> = {
      pcyTicks: (input.memory.counters['pcyTicks'] ?? 0) + 1,
      lastTargetMilli: Math.round(
        (typeof decision.signals?.targetBaseWeight === 'number'
          ? decision.signals.targetBaseWeight
          : CONFIG.neutralBaseWeight) * 1000,
      ),
      lastPeerBiasMilli: Math.round(
        (typeof decision.signals?.peerBias === 'number' ? decision.signals.peerBias : 0) * 10_000,
      ),
    };

    if (decision.kind === 'rebalance') {
      counters.pcyLastTradeEpoch = Number(input.currentEpoch);
    }

    const outcome =
      decision.kind === 'rebalance'
        ? `epoch ${input.currentEpoch}: ${decision.summary}`
        : `epoch ${input.currentEpoch}: hold — ${decision.rationale.slice(0, 140)}`;

    return { counters, facts: [...facts, outcome] };
  },
};

export default strategy;
