// ../../../../tmp/synapse-strategy-8E1W09/sui-instant-mm.strategy.ts
var CONFIG = {
  baseTypeTag: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
  baseSymbol: "SUI",
  quoteTypeTag: "0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC",
  quoteSymbol: "DBUSDC",
  poolId: "0x1c19362ca52b8ffd7a33cee805a67d40f31e6ba303753fd3a4cfdfacea7163a5",
  lowerBaseWeight: 0.4,
  upperBaseWeight: 0.6,
  slippageTolerance: 5e-3,
  /** Skip dust legs; trade-guards on runtime/enclave relax min_out below ~$15. */
  minNotionalUsd: 0.5
};
var STRATEGY_ID = "sui-instant-mm";
function normalizeCoinTypeTag(tag) {
  const parts = tag.trim().split("::");
  if (parts.length < 3) return tag.trim();
  let addr = parts[0];
  if (addr.startsWith("0x") || addr.startsWith("0X")) addr = addr.slice(2);
  return `0x${addr.toLowerCase().padStart(64, "0")}::${parts[1]}::${parts[2]}`;
}
function sameCoinType(a, b) {
  return normalizeCoinTypeTag(a) === normalizeCoinTypeTag(b);
}
function findHolding(holdings, typeTag) {
  return holdings.find((h) => sameCoinType(h.coinTypeTag, typeTag));
}
function resolveQuote(input) {
  const existing = findHolding(input.holdings, CONFIG.quoteTypeTag);
  if (existing) return existing;
  const pool = input.market.pools.find((p) => p.poolId === CONFIG.poolId);
  const priceUsd = input.market.prices[CONFIG.quoteTypeTag] ?? input.market.prices[normalizeCoinTypeTag(CONFIG.quoteTypeTag)] ?? (pool?.mid && pool.mid > 0 ? 1 : 1);
  return {
    coinTypeTag: CONFIG.quoteTypeTag,
    symbol: CONFIG.quoteSymbol,
    decimals: 6,
    amount: 0n,
    priceUsd,
    valueUsd: 0
  };
}
function usdToAtomic(usd, priceUsd, decimals) {
  if (!Number.isFinite(usd) || !Number.isFinite(priceUsd) || priceUsd <= 0) return 0n;
  return BigInt(Math.max(0, Math.floor(usd / priceUsd * 10 ** decimals)));
}
function computePlanId(vaultId, epoch, trades) {
  const short = vaultId.startsWith("0x") ? vaultId.slice(2, 10) : vaultId.slice(0, 8);
  const fp = trades.map((t) => `${t.poolId.slice(2, 6)}${t.direction}${t.amountIn.toString(36)}`).join("-");
  return `simm-${short}-e${epoch.toString()}-${fp}`;
}
function evaluate(input) {
  if (input.policy.revoked) return { kind: "noop", rationale: "Vault revoked." };
  if (input.currentEpoch >= input.policy.expiryEpoch) {
    return { kind: "noop", rationale: `Vault expired epoch ${input.policy.expiryEpoch}.` };
  }
  const base = findHolding(input.holdings, CONFIG.baseTypeTag);
  if (!base) {
    return {
      kind: "noop",
      rationale: `Fund the vault with ${CONFIG.baseSymbol} to start (quote optional on first deposit).`
    };
  }
  const quote = resolveQuote(input);
  const navUsd = base.valueUsd + quote.valueUsd;
  if (navUsd <= 0) return { kind: "noop", rationale: "NAV is zero." };
  const baseWeight = base.valueUsd / navUsd;
  if (baseWeight >= CONFIG.lowerBaseWeight && baseWeight <= CONFIG.upperBaseWeight) {
    return {
      kind: "noop",
      rationale: `${CONFIG.baseSymbol} weight ${(baseWeight * 100).toFixed(2)}% inside [${(CONFIG.lowerBaseWeight * 100).toFixed(0)}%, ${(CONFIG.upperBaseWeight * 100).toFixed(0)}%]. Hold.`,
      signals: { baseWeight, navUsd, quoteSynthetic: quote.amount === 0n }
    };
  }
  const pool = input.market.pools.find((p) => p.poolId === CONFIG.poolId);
  if (!pool) return { kind: "noop", rationale: `Pool ${CONFIG.poolId} not available.` };
  const targetWeight = baseWeight < CONFIG.lowerBaseWeight ? CONFIG.lowerBaseWeight : CONFIG.upperBaseWeight;
  const targetBaseUsd = navUsd * targetWeight;
  const deltaUsd = targetBaseUsd - base.valueUsd;
  let trade;
  let direction;
  let sizingUsd;
  if (deltaUsd > 0) {
    direction = "buy";
    sizingUsd = Math.min(deltaUsd, quote.valueUsd);
    if (sizingUsd <= 0 || quote.amount <= 0n) {
      return {
        kind: "noop",
        rationale: `${CONFIG.baseSymbol} underweight but no ${CONFIG.quoteSymbol} in treasury \u2014 deposit quote or wait for a prior SELL to fill the band.`,
        signals: { baseWeight, targetWeight, quoteBalance: quote.amount.toString() }
      };
    }
    const amountIn = usdToAtomic(sizingUsd, quote.priceUsd, quote.decimals);
    const minOut = usdToAtomic(
      sizingUsd * (1 - CONFIG.slippageTolerance),
      base.priceUsd,
      base.decimals
    );
    trade = {
      poolId: CONFIG.poolId,
      fromTypeTag: quote.coinTypeTag,
      toTypeTag: base.coinTypeTag,
      amountIn,
      minAmountOut: minOut,
      direction: 1
    };
  } else {
    direction = "sell";
    sizingUsd = Math.min(-deltaUsd, base.valueUsd);
    const amountIn = usdToAtomic(sizingUsd, base.priceUsd, base.decimals);
    const minOut = usdToAtomic(
      sizingUsd * (1 - CONFIG.slippageTolerance),
      quote.priceUsd,
      quote.decimals
    );
    trade = {
      poolId: CONFIG.poolId,
      fromTypeTag: base.coinTypeTag,
      toTypeTag: quote.coinTypeTag,
      amountIn,
      minAmountOut: minOut,
      direction: 0
    };
  }
  if (trade.amountIn <= 0n) {
    return { kind: "noop", rationale: "Trade size rounds to zero \u2014 hold." };
  }
  if (sizingUsd < CONFIG.minNotionalUsd) {
    return {
      kind: "noop",
      rationale: `Outside band but leg $${sizingUsd.toFixed(2)} below $${CONFIG.minNotionalUsd} min \u2014 hold.`,
      signals: { baseWeight, sizingUsd }
    };
  }
  const trades = [trade];
  return {
    kind: "rebalance",
    planId: computePlanId(input.vaultId, input.currentEpoch, trades),
    summary: `${CONFIG.baseSymbol} ${(baseWeight * 100).toFixed(1)}% outside band \u2192 ${direction.toUpperCase()} $${sizingUsd.toFixed(2)} to ${(targetWeight * 100).toFixed(0)}%.`,
    trades,
    rationaleMarkdown: [
      "### SUI Instant MM",
      "",
      `- **NAV**: $${navUsd.toFixed(2)}`,
      `- **${CONFIG.baseSymbol} weight**: ${(baseWeight * 100).toFixed(2)}%`,
      `- **Band**: [40%, 60%] \u2014 no warmup ticks`,
      `- **Quote in treasury**: ${quote.amount > 0n ? "yes" : "synthetic zero (SUI-only fund OK for SELL)"}`,
      `- **Action**: ${direction.toUpperCase()} $${sizingUsd.toFixed(2)}`
    ].join("\n"),
    signals: {
      baseWeight,
      targetWeight,
      direction,
      sizingUsd,
      quoteSynthetic: quote.amount === 0n
    }
  };
}
var strategy = {
  id: STRATEGY_ID,
  name: "SUI Instant MM",
  version: "1.0.0",
  description: "Stateless MM band rebalancer for demo vaults funded with SUI only. No MemWal warmup \u2014 first tick can SELL overweight SUI into DBUSDC on DeepBook testnet.",
  evaluate: async (input) => evaluate(input)
};
var sui_instant_mm_strategy_default = strategy;
export {
  sui_instant_mm_strategy_default as default
};
