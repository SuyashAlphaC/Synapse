/**
 * Bundled strategies for Synapse Vault. Add new ones by exporting from this
 * barrel file. Strategies are pure code — they hold no persistent state
 * themselves; all state lives in MemWal (recall via `StrategyInput.memory`)
 * and on-chain (the AgentIdentity treasury).
 */

export { conservativeRebalancer, CONSERVATIVE_REBALANCER_ID } from './conservative-rebalancer.js';
export type { ConservativeRebalancerConfig } from './conservative-rebalancer.js';

export { llmAdvisor, LLM_ADVISOR_ID } from './llm-advisor.js';
export type { LlmAdvisorConfig, AdvisorRecommendation, AdviseFn } from './llm-advisor.js';

export { balancedYield, BALANCED_YIELD_ID } from './balanced-yield.js';
export type { BalancedYieldConfig } from './balanced-yield.js';

export { aggressiveMomentum, AGGRESSIVE_MOMENTUM_ID } from './aggressive-momentum.js';
export type { AggressiveMomentumConfig } from './aggressive-momentum.js';

export { meanReversion, MEAN_REVERSION_ID } from './mean-reversion.js';
export type { MeanReversionConfig } from './mean-reversion.js';

export {
  meanReversionLangGraph,
  meanReversionLangGraphTestnet,
} from './mean-reversion-langgraph.js';

export { dcaTwap, DCA_TWAP_ID } from './dca-twap.js';
export type { DcaTwapConfig, DcaDirection } from './dca-twap.js';

export { pairArbitrage, PAIR_ARBITRAGE_ID } from './pair-arbitrage.js';
export type { PairArbitrageConfig } from './pair-arbitrage.js';

export { mmInventory, MM_INVENTORY_ID } from './mm-inventory.js';
export type { MmInventoryConfig } from './mm-inventory.js';

export { pythEmaCrossover, PYTH_EMA_CROSSOVER_ID } from './pyth-ema-crossover.js';
export type { PythEmaCrossoverConfig } from './pyth-ema-crossover.js';

export { newsFlagOverride, NEWS_FLAG_OVERRIDE_ID } from './news-flag-override.js';
export type { NewsFlagOverrideConfig } from './news-flag-override.js';

export { multiPoolRouter, MULTI_POOL_ROUTER_ID } from './multi-pool-router.js';
export type { MultiPoolRouterConfig } from './multi-pool-router.js';

export { timeOfDay, TIME_OF_DAY_ID } from './time-of-day.js';
export type { TimeOfDayConfig } from './time-of-day.js';
