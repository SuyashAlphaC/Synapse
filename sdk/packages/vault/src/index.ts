/**
 * @synapse-core/vault — Synapse Vault product SDK.
 *
 * The autonomous AI treasury manager built on Synapse Core. Exposes:
 *
 *   - strategy types + the `Strategy` interface
 *   - bundled strategies (e.g., conservative rebalancer)
 *   - the rebalance executor that converts plans into Synapse-gated PTBs
 *   - the audit-report renderer that persists rationale to Walrus
 *   - fee-schedule constants (1% AUM / 0.5% performance, industry standard)
 */

export * from './types.js';
export * from './strategies/index.js';
export * from './executor.js';
export * from './report.js';
