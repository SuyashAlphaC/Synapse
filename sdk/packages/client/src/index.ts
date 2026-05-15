/**
 * @synapse-core/client — TypeScript client for Synapse Core on Sui.
 *
 * Public API surface:
 *   - `types`         Sui type bindings + event shapes + error codes
 *   - `config`        Per-network configuration (Walrus aggregators, MemWal relayer, …)
 *   - `session-key`   Ephemeral Sui keypair generation for agents
 *   - `zklogin`       Google OAuth → ephemeral key → zkLogin proof flow
 *   - `agent`         PTB builders for `synapse_core::agent`
 *   - `strategy`      PTB builders for `synapse_core::strategy_registry`
 *   - `wallet`        PTB builders for `synapse_core::wallet`
 *   - `artifacts`     Walrus upload + on-chain artifact registration
 *   - `walrus`        Direct Walrus blob client wrapper
 *   - `seal`          Seal encryption helpers for sensitive artifacts
 */

export * from './types.js';
export * from './config.js';
export * from './session-key.js';
export * from './zklogin.js';
export * from './agent.js';
export * from './strategy.js';
export * from './wallet.js';
export * from './artifacts.js';
export * from './walrus.js';
export * from './seal.js';
