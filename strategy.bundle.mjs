// ../../../../tmp/synapse-strategy-iEoIY6/momentum-yield-maximizer.strategy.ts
var CONFIG = {
  baseTypeTag: "0x2::sui::SUI",
  baseSymbol: "SUI",
  quoteTypeTag: "0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3262cdf230b5f3fe22::dbusdc::DBUSDC",
  quoteSymbol: "DBUSDC",
  poolId: "0xf0f663cf87f1eb124da2fc9be813e0ce262146f3df60bc2052d738eb41a25899",
  /** Rolling price window stored in MemWal facts. */
  priceWindow: 36,
  /** Min samples before momentum / vol math runs. */
  minWarmupSamples: 10,
  /** Short vs long momentum lookbacks (in samples, not epochs). */
  momentumShort: 6,
  momentumLong: 18,
  /** Target base weight bounds — yield-seeking band. */
  minBaseWeight: 0.32,
  maxBaseWeight: 0.72,
  neutralBaseWeight: 0.55,
  /** Drift must exceed this (fraction of NAV) before trading. */
  driftThresholdCalm: 0.022,
  driftThresholdStress: 0.055,
  slippageCalm: 4e-3,
  slippageStress: 0.01,
  /** Vol above this → stress regime (log-return stddev). */
  stressVol: 0.042,
  /** Drawdown from rolling peak that forces de-risk even if momentum lagging. */
  emergencyDrawdown: 0.06,
  /** Skip re-trade unless drift exceeds this OR epochs since last trade ≥ cooldown. */
  tradeCooldownEpochs: 1,
  /** Extra drift required when still inside cooldown. */
  cooldownDriftMultiplier: 1.8
};
var STRATEGY_ID = "momentum-yield-maximizer";
var PRICE_FACT_PREFIX = "mym:px:";
var PEAK_FACT_PREFIX = "mym:peak:";
function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
function usdToAtomic(usd, priceUsd, decimals) {
  if (!Number.isFinite(usd) || !Number.isFinite(priceUsd) || priceUsd <= 0) return 0n;
  return BigInt(Math.max(0, Math.floor(usd / priceUsd * 10 ** decimals)));
}
function computePlanId(vaultId, epoch, trades) {
  const short = vaultId.startsWith("0x") ? vaultId.slice(2, 10) : vaultId.slice(0, 8);
  const fp = trades.map((t) => `${t.poolId.slice(2, 6)}${t.direction}${t.amountIn.toString(36)}`).join("-");
  return `mym-${short}-e${epoch.toString()}-${fp}`;
}
function readPriceHistory(facts) {
  const fact = facts.find((f) => f.startsWith(PRICE_FACT_PREFIX));
  if (!fact) return [];
  return fact.slice(PRICE_FACT_PREFIX.length).split(",").map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0).slice(-CONFIG.priceWindow);
}
function readPeak(facts) {
  const fact = facts.find((f) => f.startsWith(PEAK_FACT_PREFIX));
  if (!fact) return 0;
  const n = Number(fact.slice(PEAK_FACT_PREFIX.length));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function logReturns(prices) {
  const out = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    const cur = prices[i];
    if (prev > 0 && cur > 0) out.push(Math.log(cur / prev));
  }
  return out;
}
function realizedVol(prices) {
  const rets = logReturns(prices);
  if (rets.length < 2) return 0;
  const mean = rets.reduce((a, x) => a + x, 0) / rets.length;
  const variance = rets.reduce((a, x) => a + (x - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(Math.max(0, variance));
}
function cumulativeReturn(prices, lookback) {
  if (prices.length < lookback + 1) return 0;
  const start = prices[prices.length - lookback - 1];
  const end = prices[prices.length - 1];
  if (start <= 0 || end <= 0) return 0;
  return end / start - 1;
}
function momentumScore(prices) {
  const short = cumulativeReturn(prices, CONFIG.momentumShort);
  const long = cumulativeReturn(prices, Math.min(CONFIG.momentumLong, prices.length - 1));
  return 0.55 * short + 0.45 * long;
}
function classifyRegime(vol, drawdown) {
  if (drawdown >= CONFIG.emergencyDrawdown || vol >= CONFIG.stressVol) return "stress";
  if (vol >= CONFIG.stressVol * 0.55) return "elevated";
  return "calm";
}
function targetBaseWeight(args) {
  const { momentum, vol, drawdown, regime } = args;
  if (regime === "stress" || drawdown >= CONFIG.emergencyDrawdown) {
    return CONFIG.minBaseWeight;
  }
  const momClamped = Math.max(-0.15, Math.min(0.15, momentum));
  const momNorm = (momClamped + 0.15) / 0.3;
  const volPenalty = clamp01(vol / CONFIG.stressVol);
  const drawdownPenalty = clamp01(drawdown / CONFIG.emergencyDrawdown);
  let target = CONFIG.minBaseWeight + momNorm * (CONFIG.maxBaseWeight - CONFIG.minBaseWeight) * (1 - 0.35 * volPenalty);
  if (regime === "elevated") {
    target = CONFIG.neutralBaseWeight + (target - CONFIG.neutralBaseWeight) * 0.55;
  }
  target -= drawdownPenalty * (target - CONFIG.minBaseWeight) * 0.65;
  return clamp01(
    Math.max(CONFIG.minBaseWeight, Math.min(CONFIG.maxBaseWeight, target))
  );
}
function effectiveDriftThreshold(regime) {
  if (regime === "stress") return CONFIG.driftThresholdStress;
  if (regime === "elevated") {
    return (CONFIG.driftThresholdCalm + CONFIG.driftThresholdStress) / 2;
  }
  return CONFIG.driftThresholdCalm;
}
function effectiveSlippage(regime) {
  return regime === "stress" ? CONFIG.slippageStress : CONFIG.slippageCalm;
}
function poolSpreadBps(pool) {
  const bid = pool.bestBid ?? pool.mid;
  const ask = pool.bestAsk ?? pool.mid;
  const mid = pool.mid ?? (bid && ask ? (bid + ask) / 2 : void 0);
  if (!mid || !bid || !ask || mid <= 0) return 0;
  return (ask - bid) / mid * 1e4;
}
function buildRebalancePlan(args) {
  const base = args.input.holdings.find((h) => h.coinTypeTag === CONFIG.baseTypeTag);
  const quote = args.input.holdings.find((h) => h.coinTypeTag === CONFIG.quoteTypeTag);
  const totalUsd = base.valueUsd + quote.valueUsd;
  const actualBaseWeight = totalUsd > 0 ? base.valueUsd / totalUsd : 0;
  const drift = actualBaseWeight - args.targetBaseWeight;
  const absDrift = Math.abs(drift);
  if (absDrift < args.driftThreshold) {
    return {
      kind: "noop",
      rationale: `Drift ${(absDrift * 100).toFixed(2)}% below ${(args.driftThreshold * 100).toFixed(2)}% threshold \u2014 hold yield posture.`,
      signals: {
        ...args.signals,
        actualBaseWeight,
        targetBaseWeight: args.targetBaseWeight,
        absDrift
      }
    };
  }
  const pool = args.input.market.pools.find((p) => p.poolId === CONFIG.poolId);
  if (!pool) {
    return {
      kind: "noop",
      rationale: `Pool ${CONFIG.poolId} unavailable.`,
      signals: args.signals
    };
  }
  const spreadBps = poolSpreadBps(pool);
  if (spreadBps > 35 && absDrift < args.driftThreshold * 1.35) {
    return {
      kind: "noop",
      rationale: `Wide spread (${spreadBps.toFixed(1)} bps) \u2014 defer rebalance to protect yield.`,
      signals: { ...args.signals, spreadBps, actualBaseWeight, absDrift }
    };
  }
  const targetBaseUsd = totalUsd * args.targetBaseWeight;
  const baseExcessUsd = base.valueUsd - targetBaseUsd;
  let trades;
  if (baseExcessUsd > 0) {
    const sellUsd = baseExcessUsd;
    trades = [
      {
        poolId: CONFIG.poolId,
        fromTypeTag: CONFIG.baseTypeTag,
        toTypeTag: CONFIG.quoteTypeTag,
        amountIn: usdToAtomic(sellUsd, base.priceUsd, base.decimals),
        minAmountOut: usdToAtomic(
          sellUsd * (1 - args.slippageTolerance),
          quote.priceUsd,
          quote.decimals
        ),
        direction: 0
      }
    ];
  } else {
    const buyUsd = -baseExcessUsd;
    trades = [
      {
        poolId: CONFIG.poolId,
        fromTypeTag: CONFIG.quoteTypeTag,
        toTypeTag: CONFIG.baseTypeTag,
        amountIn: usdToAtomic(buyUsd, quote.priceUsd, quote.decimals),
        minAmountOut: usdToAtomic(
          buyUsd * (1 - args.slippageTolerance),
          base.priceUsd,
          base.decimals
        ),
        direction: 1
      }
    ];
  }
  const direction = baseExcessUsd > 0 ? "trim base (de-risk)" : "add base (yield tilt)";
  return {
    kind: "rebalance",
    planId: computePlanId(args.input.vaultId, args.input.currentEpoch, trades),
    summary: `Momentum yield: ${direction} \u2014 drift ${(absDrift * 100).toFixed(2)}% \u2192 target ${(args.targetBaseWeight * 100).toFixed(1)}% ${CONFIG.baseSymbol}`,
    trades,
    rationaleMarkdown: [
      "### Momentum Yield Maximizer",
      "",
      `- **Regime**: ${String(args.signals.regime)}`,
      `- **Momentum score**: ${Number(args.signals.momentum).toFixed(4)}`,
      `- **Realized vol**: ${(Number(args.signals.vol) * 100).toFixed(3)}%`,
      `- **Drawdown from peak**: ${(Number(args.signals.drawdown) * 100).toFixed(2)}%`,
      `- **Target ${CONFIG.baseSymbol} weight**: ${(args.targetBaseWeight * 100).toFixed(2)}%`,
      `- **Actual weight**: ${(actualBaseWeight * 100).toFixed(2)}%`,
      `- **Pool spread**: ${spreadBps.toFixed(1)} bps`,
      "",
      "Deterministic yield posture: overweight base in confirmed uptrends,",
      "park in stable on stress \u2014 no LLM, fully reproducible from MemWal history."
    ].join("\n"),
    signals: {
      ...args.signals,
      actualBaseWeight,
      targetBaseWeight: args.targetBaseWeight,
      drift,
      absDrift,
      spreadBps,
      navUsd: totalUsd
    }
  };
}
function evaluate(input) {
  if (input.policy.revoked) return { kind: "noop", rationale: "Vault revoked." };
  if (input.currentEpoch >= input.policy.expiryEpoch) {
    return { kind: "noop", rationale: `Vault expired epoch ${input.policy.expiryEpoch}.` };
  }
  const base = input.holdings.find((h) => h.coinTypeTag === CONFIG.baseTypeTag);
  const quote = input.holdings.find((h) => h.coinTypeTag === CONFIG.quoteTypeTag);
  if (!base || !quote) {
    return { kind: "noop", rationale: `Asset missing (base=${!!base}, quote=${!!quote}).` };
  }
  const navUsd = base.valueUsd + quote.valueUsd;
  if (navUsd <= 0) return { kind: "noop", rationale: "NAV is zero." };
  const prices = readPriceHistory(input.memory.facts);
  if (prices.length < CONFIG.minWarmupSamples) {
    return {
      kind: "noop",
      rationale: `Warming up price history (${prices.length}/${CONFIG.minWarmupSamples} samples).`,
      signals: { samples: prices.length, required: CONFIG.minWarmupSamples }
    };
  }
  const peakStored = readPeak(input.memory.facts);
  const peak = Math.max(peakStored, base.priceUsd, ...prices);
  const drawdown = peak > 0 ? Math.max(0, 1 - base.priceUsd / peak) : 0;
  const vol = realizedVol(prices);
  const momentum = momentumScore(prices);
  const regime = classifyRegime(vol, drawdown);
  const target = targetBaseWeight({ momentum, vol, drawdown, regime });
  let driftThreshold = effectiveDriftThreshold(regime);
  const slippage = effectiveSlippage(regime);
  const lastTradeEpoch = input.memory.counters["mymLastTradeEpoch"];
  const epochsSinceTrade = typeof lastTradeEpoch === "number" ? Number(input.currentEpoch) - lastTradeEpoch : Infinity;
  if (epochsSinceTrade < CONFIG.tradeCooldownEpochs && drawdown < CONFIG.emergencyDrawdown) {
    driftThreshold *= CONFIG.cooldownDriftMultiplier;
  }
  const actualBaseWeight = navUsd > 0 ? base.valueUsd / navUsd : 0;
  const signals = {
    regime,
    momentum,
    vol,
    drawdown,
    peak,
    targetBaseWeight: target,
    actualBaseWeight,
    epochsSinceTrade,
    driftThreshold,
    samples: prices.length
  };
  return buildRebalancePlan({
    input,
    targetBaseWeight: target,
    driftThreshold,
    slippageTolerance: slippage,
    signals
  });
}
var strategy = {
  id: STRATEGY_ID,
  name: "Momentum Yield Maximizer",
  version: "1.0.0",
  description: "Deterministic yield maximizer: multi-horizon momentum + vol/drawdown regime detection dynamically tilts SUI/stable allocation (32\u201372% base) to capture appreciation in uptrends and preserve capital in stress. No LLM \u2014 MemWal price history only.",
  evaluate: async (input) => evaluate(input),
  prepareMemoryWrite: async ({
    input,
    decision
  }) => {
    const base = input.holdings.find((h) => h.coinTypeTag === CONFIG.baseTypeTag);
    if (!base || base.priceUsd <= 0) return null;
    const history = readPriceHistory(input.memory.facts);
    history.push(base.priceUsd);
    const trimmed = history.slice(-CONFIG.priceWindow);
    const prevPeak = readPeak(input.memory.facts);
    const nextPeak = Math.max(prevPeak, base.priceUsd, ...trimmed);
    const carried = input.memory.facts.filter(
      (f) => !f.startsWith(PRICE_FACT_PREFIX) && !f.startsWith(PEAK_FACT_PREFIX)
    );
    const facts = [
      ...carried,
      `${PRICE_FACT_PREFIX}${trimmed.join(",")}`,
      `${PEAK_FACT_PREFIX}${nextPeak.toFixed(8)}`
    ];
    const counters = {
      mymTicks: (input.memory.counters["mymTicks"] ?? 0) + 1,
      lastTargetMilli: Math.round(
        (typeof decision.signals?.targetBaseWeight === "number" ? decision.signals.targetBaseWeight : CONFIG.neutralBaseWeight) * 1e3
      ),
      lastMomentumMilli: Math.round(
        (typeof decision.signals?.momentum === "number" ? decision.signals.momentum : 0) * 1e4
      )
    };
    if (decision.kind === "rebalance") {
      counters.mymLastTradeEpoch = Number(input.currentEpoch);
    }
    const outcome = decision.kind === "rebalance" ? `epoch ${input.currentEpoch}: ${decision.summary}` : `epoch ${input.currentEpoch}: hold \u2014 ${decision.rationale.slice(0, 140)}`;
    return { counters, facts: [...facts, outcome] };
  }
};
var momentum_yield_maximizer_strategy_default = strategy;
export {
  momentum_yield_maximizer_strategy_default as default
};
