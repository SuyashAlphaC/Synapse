/**
 * PTB builders for `synapse_core::strategy_registry`.
 *
 * The registry is the marketplace surface: strategists publish their strategy
 * once and the returned `StrategistCap` is required for future governance
 * (version bumps, deprecate, reactivate). Read-side queries live in the
 * indexer; this module covers the write-side PTB calls plus reusable view
 * helpers for the dashboard.
 *
 * Reference Move source: `move/synapse_core/sources/strategy_registry.move`.
 */

import type { Transaction, TransactionResult } from '@mysten/sui/transactions';
import { target } from './config.js';
import type { RiskProfileValue } from './types.js';

const MAX_ROYALTY_BPS = 5000;

export interface PublishStrategyInput {
  /** Human-readable strategy name (e.g. "Conservative Rebalancer"). */
  name: string;
  /** Short description shown in the marketplace card. */
  description: string;
  /** 32-byte commitment to the strategy runtime code (e.g. sha256 of bundle). */
  codeHash: Uint8Array;
  /** Walrus blob ID where the full source / docs live. */
  sourceWalrusBlob: string;
  /** 0=Conservative, 1=Balanced, 2=Aggressive. */
  riskProfile: RiskProfileValue;
  /** Strategist's share of perf fees, in basis points. Max 5000 (50%). */
  royaltyBps: number;
}

function asBytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

/**
 * Append `strategy_registry::publish(...)` to `tx`. Returns the
 * `StrategistCap` handle so callers can `transferObjects([cap], sender)`
 * within the same PTB.
 */
export function publishStrategy(
  tx: Transaction,
  packageId: string,
  input: PublishStrategyInput,
): TransactionResult {
  if (input.royaltyBps < 0 || input.royaltyBps > MAX_ROYALTY_BPS) {
    throw new Error(
      `royaltyBps must be in [0, ${MAX_ROYALTY_BPS}], got ${input.royaltyBps}`,
    );
  }
  if (input.codeHash.length !== 32) {
    throw new Error(`codeHash must be 32 bytes, got ${input.codeHash.length}`);
  }
  return tx.moveCall({
    target: target(packageId, 'strategyRegistry', 'publish'),
    arguments: [
      tx.pure.vector('u8', asBytes(input.name)),
      tx.pure.vector('u8', asBytes(input.description)),
      tx.pure.vector('u8', Array.from(input.codeHash)),
      tx.pure.vector('u8', asBytes(input.sourceWalrusBlob)),
      tx.pure.u8(input.riskProfile),
      tx.pure.u16(input.royaltyBps),
    ],
  });
}

/**
 * Append `strategy_registry::publish_new_version(...)`. Bumps the strategy
 * version + code hash; existing vaults keep their current run-tick semantics
 * until the strategist's runtime opts into the new bundle.
 */
export function publishStrategyVersion(
  tx: Transaction,
  packageId: string,
  args: {
    strategyId: string;
    capId: string;
    newCodeHash: Uint8Array;
    newSourceWalrusBlob: string;
  },
): TransactionResult {
  if (args.newCodeHash.length !== 32) {
    throw new Error(`newCodeHash must be 32 bytes, got ${args.newCodeHash.length}`);
  }
  return tx.moveCall({
    target: target(packageId, 'strategyRegistry', 'publish_new_version'),
    arguments: [
      tx.object(args.strategyId),
      tx.object(args.capId),
      tx.pure.vector('u8', Array.from(args.newCodeHash)),
      tx.pure.vector('u8', asBytes(args.newSourceWalrusBlob)),
    ],
  });
}

export function deprecateStrategy(
  tx: Transaction,
  packageId: string,
  args: { strategyId: string; capId: string },
): TransactionResult {
  return tx.moveCall({
    target: target(packageId, 'strategyRegistry', 'deprecate'),
    arguments: [tx.object(args.strategyId), tx.object(args.capId)],
  });
}

export function reactivateStrategy(
  tx: Transaction,
  packageId: string,
  args: { strategyId: string; capId: string },
): TransactionResult {
  return tx.moveCall({
    target: target(packageId, 'strategyRegistry', 'reactivate'),
    arguments: [tx.object(args.strategyId), tx.object(args.capId)],
  });
}

export { MAX_ROYALTY_BPS };
