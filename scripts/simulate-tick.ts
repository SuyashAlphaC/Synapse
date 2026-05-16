#!/usr/bin/env tsx
/**
 * Dry-run the agent's decision for a vault without signing anything.
 *
 * Reads the vault's on-chain state, fetches a current SUI/USD price and a
 * DeepBookV3 SUI/USDC pool snapshot, builds the same StrategyInput the
 * production runtime passes to `strategy.evaluate()`, and prints the
 * decision (NOOP or REBALANCE) plus the would-be trades.
 *
 *   npx tsx scripts/simulate-tick.ts --vault 0x…
 *   npx tsx scripts/simulate-tick.ts --vault 0x… --strategy <slug>
 *
 * Where <slug> overrides the strategy resolution if you want to see what a
 * *different* strategy would do against this vault's current holdings.
 */

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import {
  aggressiveMomentum,
  AGGRESSIVE_MOMENTUM_ID,
  balancedYield,
  BALANCED_YIELD_ID,
  conservativeRebalancer,
  CONSERVATIVE_REBALANCER_ID,
} from '../sdk/packages/vault/src/strategies/index.js';
import type {
  Strategy,
  StrategyDecision,
  StrategyInput,
  HoldingSnapshot,
} from '../sdk/packages/vault/src/types.js';

const PACKAGE_ID =
  process.env['PACKAGE_ID'] ??
  '0x7b3f59e42edbf2189df644e63162d0b9a2c2984755bab9d3e9557c4ddd4aa67c';

const SUI_TYPE_TAG = '0x2::sui::SUI';
const USDC_TYPE_TAG =
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const POOL_ID = '0xb663828d6217467c8a1838a03793da896cbe745b150ebd57d82f814ca579fc22';

const KNOWN_STRATEGIES: Record<string, string> = {
  '0x46996c0f9e692968f55a63c3cbc33eb8d19145c123b7a867a02da342e617d3ec':
    CONSERVATIVE_REBALANCER_ID,
  '0x44c0f7c4f6e04024c9bb1c0ce1eb1965018675cd074e7a410a59c2d43887c679':
    BALANCED_YIELD_ID,
  '0xa1d73e17bc4c53484a3254c5ed3c0b24e340524d0014703c072f91d60f02d4a1':
    AGGRESSIVE_MOMENTUM_ID,
};

function parseArgs(): { vault: string; strategyOverride: string | null } {
  const args = process.argv.slice(2);
  let vault: string | null = null;
  let strategyOverride: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--vault') vault = args[++i] ?? null;
    else if (args[i] === '--strategy') strategyOverride = args[++i] ?? null;
  }
  if (!vault) {
    console.error('usage: simulate-tick.ts --vault <0x…> [--strategy <slug>]');
    process.exit(1);
  }
  return { vault, strategyOverride };
}

function buildStrategy(slug: string): Strategy {
  const common = {
    baseTypeTag: SUI_TYPE_TAG,
    baseSymbol: 'SUI',
    quoteTypeTag: USDC_TYPE_TAG,
    quoteSymbol: 'USDC',
    poolId: POOL_ID,
  };
  switch (slug) {
    case CONSERVATIVE_REBALANCER_ID:
      return conservativeRebalancer({
        ...common,
        targetBaseWeight: 0.5,
        driftThreshold: 0.05,
        slippageTolerance: 0.005,
      });
    case BALANCED_YIELD_ID:
      return balancedYield({
        ...common,
        targetBaseWeight: 0.6,
        thresholdLow: 0.02,
        thresholdHigh: 0.08,
        slippageLow: 0.005,
        slippageHigh: 0.02,
        volWindow: 12,
      });
    case AGGRESSIVE_MOMENTUM_ID:
      return aggressiveMomentum({
        ...common,
        entryThreshold: 0.02,
        exitThreshold: -0.01,
        maxConfBps: 75,
        slippageTolerance: 0.01,
        maxPositionFraction: 0.5,
      });
    default:
      throw new Error(`Unknown strategy slug: ${slug}`);
  }
}

async function fetchSuiPriceUsd(): Promise<number> {
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  const j = (await res.json()) as { sui: { usd: number } };
  return j.sui.usd;
}

async function loadVaultIdentity(
  client: SuiJsonRpcClient,
  vaultId: string,
): Promise<{
  strategyId: string;
  ownerAddress: string;
  sessionAddr: string;
  expiryEpoch: bigint;
  spendPerEpoch: bigint;
  spentThisEpoch: bigint;
  approvedPackages: string[];
  revoked: boolean;
  treasuryId: string;
}> {
  const obj = await client.getObject({ id: vaultId, options: { showContent: true } });
  if (obj.error || !obj.data?.content) {
    throw new Error(`Cannot load vault ${vaultId}`);
  }
  const content = obj.data.content;
  if (content.dataType !== 'moveObject') {
    throw new Error(`Object ${vaultId} is not a Move object`);
  }
  const fields = (content as { fields: Record<string, unknown> }).fields;
  return {
    strategyId: idLike(fields['strategy_id']),
    ownerAddress: fields['owner'] as string,
    sessionAddr: fields['session_addr'] as string,
    expiryEpoch: BigInt(fields['expiry_epoch'] as string | number),
    spendPerEpoch: BigInt(fields['spend_per_epoch'] as string | number),
    spentThisEpoch: BigInt(fields['spent_this_epoch'] as string | number),
    approvedPackages: fields['approved_packages'] as string[],
    revoked: fields['revoked'] as boolean,
    treasuryId: idLike((fields['treasury'] as { fields: Record<string, unknown> }).fields['id']),
  };
}

function idLike(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && 'id' in (v as Record<string, unknown>)) {
    return (v as Record<string, unknown>)['id'] as string;
  }
  throw new Error(`Cannot read ID from ${JSON.stringify(v)}`);
}

async function loadHoldings(
  client: SuiJsonRpcClient,
  treasuryId: string,
  suiPriceUsd: number,
): Promise<HoldingSnapshot[]> {
  const out: HoldingSnapshot[] = [];
  let cursor: string | null | undefined;
  do {
    const page = await client.getDynamicFields({ parentId: treasuryId, cursor });
    for (const field of page.data) {
      const obj = await client.getDynamicFieldObject({
        parentId: treasuryId,
        name: field.name,
      });
      const content = obj.data?.content;
      if (!content || content.dataType !== 'moveObject') continue;
      const fields = (content as { fields: Record<string, unknown> }).fields;
      const raw = extractBalanceValue(fields);
      if (raw === null) continue;
      const coinTag = parseCoinTypeFromFieldName(field.name);
      const symbol = coinTag.split('::').at(-1) ?? coinTag;
      const decimals = coinTag === SUI_TYPE_TAG ? 9 : 6;
      const priceUsd = coinTag === SUI_TYPE_TAG ? suiPriceUsd : 1;
      const units = Number(raw) / 10 ** decimals;
      out.push({
        coinTypeTag: coinTag,
        symbol,
        amount: BigInt(raw),
        decimals,
        priceUsd,
        valueUsd: units * priceUsd,
      });
    }
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor);
  return out;
}

function extractBalanceValue(fields: Record<string, unknown>): string | null {
  const v = (fields['value'] ?? fields['amount']) as unknown;
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object' && v !== null) {
    const inner = (v as Record<string, unknown>)['value'];
    if (typeof inner === 'string' || typeof inner === 'number') return String(inner);
  }
  return null;
}

function parseCoinTypeFromFieldName(name: { value: unknown }): string {
  const v = name.value;
  let raw: string | null = null;
  if (typeof v === 'string') raw = v;
  else if (typeof v === 'object' && v !== null) {
    const nm = (v as { name?: unknown }).name;
    if (typeof nm === 'string') raw = nm;
  }
  if (!raw) return 'unknown';
  // Move's TypeName comes back as <full-padded-addr>::module::Type. Strategy
  // configs use Sui's short form (e.g. 0x2::sui::SUI), so we compact leading
  // zeros after 0x to make string-equality comparisons match.
  const prefixed = raw.startsWith('0x') ? raw : `0x${raw}`;
  const colon = prefixed.indexOf('::');
  if (colon === -1) return prefixed;
  const addrPart = prefixed.slice(0, colon);
  const compact = addrPart.replace(/^0x0*/, '0x');
  const safe = compact === '0x' ? '0x0' : compact;
  return `${safe}${prefixed.slice(colon)}`;
}

function printDecision(decision: StrategyDecision): void {
  if (decision.kind === 'noop') {
    console.log('\n  decision: NOOP');
    console.log(`  rationale: ${decision.rationale}`);
    if (decision.signals) {
      for (const [k, v] of Object.entries(decision.signals)) {
        console.log(`    ${k}: ${typeof v === 'number' ? v.toFixed(4) : String(v)}`);
      }
    }
    return;
  }
  console.log('\n  decision: REBALANCE');
  console.log(`  plan id:  ${decision.planId}`);
  console.log(`  summary:  ${decision.summary}`);
  console.log(`  trades:`);
  for (const t of decision.trades) {
    console.log(`    - from ${t.fromTypeTag.split('::').at(-1)}: ${t.amountIn.toString()} (min out ${t.minAmountOut.toString()} of ${t.toTypeTag.split('::').at(-1)}, pool ${t.poolId.slice(0, 10)}…)`);
  }
}

async function main(): Promise<void> {
  const { vault, strategyOverride } = parseArgs();
  const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl('testnet') });

  console.log(`Loading vault ${vault}…`);
  const id = await loadVaultIdentity(client, vault);
  console.log(`  owner:    ${id.ownerAddress}`);
  console.log(`  session:  ${id.sessionAddr}`);
  console.log(`  strategy: ${id.strategyId}`);
  console.log(`  revoked:  ${id.revoked}`);
  console.log(`  expiry:   epoch ${id.expiryEpoch}`);
  console.log(`  spent/cap:${id.spentThisEpoch}/${id.spendPerEpoch}`);
  console.log(`  allowed:  ${id.approvedPackages.length} package(s)`);

  const slug = strategyOverride ?? KNOWN_STRATEGIES[id.strategyId] ?? null;
  if (!slug) {
    console.error(`\nUnknown on-chain strategy ${id.strategyId}.`);
    console.error('Pass --strategy <conservative-rebalancer|balanced-yield|aggressive-momentum> to override.');
    process.exit(2);
  }
  console.log(`\nUsing strategy: ${slug}`);

  console.log('\nFetching market…');
  const suiPriceUsd = await fetchSuiPriceUsd();
  console.log(`  SUI/USD: $${suiPriceUsd.toFixed(4)}`);
  const holdings = await loadHoldings(client, id.treasuryId, suiPriceUsd);
  const navUsd = holdings.reduce((s, h) => s + h.valueUsd, 0);
  console.log(`  holdings:`);
  for (const h of holdings) {
    console.log(`    ${h.symbol}: ${(Number(h.amount) / 10 ** h.decimals).toFixed(6)} ($${h.valueUsd.toFixed(2)})`);
  }
  console.log(`  NAV: $${navUsd.toFixed(2)}`);

  const { epoch } = await client.getLatestSuiSystemState();
  const currentEpoch = BigInt(epoch);
  const input: StrategyInput = {
    vaultId: vault,
    holdings,
    navUsd,
    market: {
      prices: { SUI: suiPriceUsd, USDC: 1 },
      pools: [
        {
          poolId: POOL_ID,
          baseTypeTag: SUI_TYPE_TAG,
          quoteTypeTag: USDC_TYPE_TAG,
          bestBid: suiPriceUsd * 0.999,
          bestAsk: suiPriceUsd * 1.001,
          mid: suiPriceUsd,
          volume24h: 1_000_000,
        },
      ],
      asOf: new Date().toISOString(),
    },
    memory: {
      recentDecisions: [],
      counters: { price_lookback_usd: suiPriceUsd, pyth_conf_bps: 25 },
      facts: [],
    },
    currentEpoch,
    policy: {
      spendPerEpochUsd: Number(id.spendPerEpoch) / 1e9 * suiPriceUsd,
      approvedPackages: id.approvedPackages,
      expiryEpoch: id.expiryEpoch,
      revoked: id.revoked,
    },
  };

  const strategy = buildStrategy(slug);
  const decision = await strategy.evaluate(input);
  printDecision(decision);

  console.log('\nNo transaction was signed. To run this for real, use scripts/run-live-tick.ts.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
