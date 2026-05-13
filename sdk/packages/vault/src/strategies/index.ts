/**
 * Bundled strategies for Synapse Vault. Add new ones by exporting from this
 * barrel file. Strategies are pure code — they hold no persistent state
 * themselves; all state lives in MemWal (recall via `StrategyInput.memory`)
 * and on-chain (the AgentIdentity treasury).
 */

export { conservativeRebalancer, CONSERVATIVE_REBALANCER_ID } from './conservative-rebalancer.js';
export type { ConservativeRebalancerConfig } from './conservative-rebalancer.js';
