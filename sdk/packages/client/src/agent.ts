/**
 * PTB builders for `synapse_core::agent`.
 *
 * Every function in this module appends Move calls to a `Transaction` and
 * (where relevant) returns `TransactionResult` handles so callers can chain
 * results together inside a single PTB. Pure values use the typed pure
 * builder from `@mysten/sui/transactions` for correct BCS encoding.
 *
 * Reference Move source: `move/synapse_core/sources/agent.move`.
 */

import type { Transaction, TransactionResult } from '@mysten/sui/transactions';
import { target } from './config.js';
import type { MintAgentInput } from './types.js';

// ---------------------------------------------------------------------------
// Mint flow
// ---------------------------------------------------------------------------

/**
 * Append `synapse_core::agent::new(...)` to `tx`. Returns the hot-potato
 * AgentIdentity handle that downstream calls (`fund`, `share`) consume.
 * The vault is bound to `input.strategyId` from the marketplace registry.
 */
export function newAgent(
  tx: Transaction,
  packageId: string,
  input: MintAgentInput,
): TransactionResult {
  // Mirror the on-chain guards so a bad mint fails fast client-side instead of
  // costing a round-trip + opaque Move abort (EZeroSpend / EInvalidExpiry).
  if (input.spendPerEpoch <= 0n) {
    throw new Error('newAgent: spendPerEpoch must be > 0');
  }
  if (input.expiryEpoch <= 0n) {
    throw new Error('newAgent: expiryEpoch must be > 0');
  }
  return tx.moveCall({
    target: target(packageId, 'agent', 'new'),
    arguments: [
      tx.object(input.strategyId),
      tx.pure.address(input.sessionAddr),
      tx.pure.u64(input.expiryEpoch),
      tx.pure.u64(input.spendPerEpoch),
      tx.pure.vector('address', input.approvedPackages),
      tx.pure.vector('u8', Array.from(input.memwalAccountId)),
      tx.pure.vector('u8', Array.from(input.memwalDelegateKeyId)),
      tx.pure.vector('u8', Array.from(input.memwalNamespace)),
    ],
  });
}

/**
 * Append `synapse_core::agent::fund<T>(identity, coin)` to `tx`. `coin` must
 * be a `Coin<T>` argument (from `tx.splitCoins`, `tx.gas`, or a prior call).
 */
export function fundAgent(
  tx: Transaction,
  packageId: string,
  args: {
    identity: TransactionResult | string;
    coin: TransactionResult;
    coinTypeTag: string;
  },
): TransactionResult {
  const identityArg = typeof args.identity === 'string' ? tx.object(args.identity) : args.identity;
  return tx.moveCall({
    target: target(packageId, 'agent', 'fund'),
    typeArguments: [args.coinTypeTag],
    arguments: [identityArg, args.coin],
  });
}

/**
 * Append `synapse_core::agent::attach_messaging(identity, inbox, outbox)`.
 */
export function attachMessaging(
  tx: Transaction,
  packageId: string,
  args: {
    identity: TransactionResult | string;
    inboxId: string;
    outboxId: string;
  },
): TransactionResult {
  const identityArg = typeof args.identity === 'string' ? tx.object(args.identity) : args.identity;
  return tx.moveCall({
    target: target(packageId, 'agent', 'attach_messaging'),
    arguments: [identityArg, tx.pure.id(args.inboxId), tx.pure.id(args.outboxId)],
  });
}

/**
 * Append `synapse_core::agent::share(identity)`. Consumes the hot potato and
 * makes the AgentIdentity a shared object. MUST be the last lifecycle call
 * in the mint PTB.
 */
export function shareAgent(
  tx: Transaction,
  packageId: string,
  identity: TransactionResult,
): TransactionResult {
  return tx.moveCall({
    target: target(packageId, 'agent', 'share'),
    arguments: [identity],
  });
}

// ---------------------------------------------------------------------------
// Owner governance entry points
// ---------------------------------------------------------------------------

export function revokeAgent(
  tx: Transaction,
  packageId: string,
  args: { agentId: string; strategyId: string },
): TransactionResult {
  return tx.moveCall({
    target: target(packageId, 'agent', 'revoke'),
    arguments: [tx.object(args.agentId), tx.object(args.strategyId)],
  });
}

/**
 * Append `synapse_core::agent::record_tick_performance(...)`. Splits realized
 * alpha into positive and negative bps so the on-chain reputation counters
 * stay as unsigned `u128` sums. Session-key authorized.
 */
export function recordTickPerformance(
  tx: Transaction,
  packageId: string,
  args: {
    agentId: string;
    strategyId: string;
    alphaBpsPos: bigint;
    alphaBpsNeg: bigint;
  },
): TransactionResult {
  // Client-side sanity: alpha is signed, reported as exactly one non-zero leg
  // per tick, each within u64. Catches caller mistakes before the round-trip.
  const MAX_U64 = (1n << 64n) - 1n;
  for (const [name, v] of [
    ['alphaBpsPos', args.alphaBpsPos],
    ['alphaBpsNeg', args.alphaBpsNeg],
  ] as const) {
    if (v < 0n || v > MAX_U64) {
      throw new Error(`recordTickPerformance: ${name} out of u64 range`);
    }
  }
  if (args.alphaBpsPos > 0n && args.alphaBpsNeg > 0n) {
    throw new Error('recordTickPerformance: only one of alphaBpsPos/alphaBpsNeg may be non-zero');
  }
  return tx.moveCall({
    target: target(packageId, 'agent', 'record_tick_performance'),
    arguments: [
      tx.object(args.agentId),
      tx.object(args.strategyId),
      tx.pure.u64(args.alphaBpsPos),
      tx.pure.u64(args.alphaBpsNeg),
    ],
  });
}

/**
 * Append `synapse_core::agent::pay_strategist_royalty<T>(...)`. Pays the
 * strategist `profit_amount * royalty_bps / 10_000` out of the vault treasury
 * in coin type `T`. Session-key authorized.
 */
export function payStrategistRoyalty(
  tx: Transaction,
  packageId: string,
  args: {
    agentId: string;
    strategyId: string;
    coinTypeTag: string;
    profitAmount: bigint;
  },
): TransactionResult {
  return tx.moveCall({
    target: target(packageId, 'agent', 'pay_strategist_royalty'),
    typeArguments: [args.coinTypeTag],
    arguments: [
      tx.object(args.agentId),
      tx.object(args.strategyId),
      tx.pure.u64(args.profitAmount),
    ],
  });
}

export function rotateSessionKey(
  tx: Transaction,
  packageId: string,
  args: { agentId: string; newSessionAddr: string },
): TransactionResult {
  return tx.moveCall({
    target: target(packageId, 'agent', 'rotate_session_key'),
    arguments: [tx.object(args.agentId), tx.pure.address(args.newSessionAddr)],
  });
}

export function extendExpiry(
  tx: Transaction,
  packageId: string,
  args: { agentId: string; newExpiryEpoch: bigint },
): TransactionResult {
  return tx.moveCall({
    target: target(packageId, 'agent', 'extend_expiry'),
    arguments: [tx.object(args.agentId), tx.pure.u64(args.newExpiryEpoch)],
  });
}

export function updateSpendPerEpoch(
  tx: Transaction,
  packageId: string,
  args: { agentId: string; newSpendPerEpoch: bigint },
): TransactionResult {
  return tx.moveCall({
    target: target(packageId, 'agent', 'update_spend_per_epoch'),
    arguments: [tx.object(args.agentId), tx.pure.u64(args.newSpendPerEpoch)],
  });
}

export function addApprovedPackage(
  tx: Transaction,
  packageId: string,
  args: { agentId: string; pkg: string },
): TransactionResult {
  return tx.moveCall({
    target: target(packageId, 'agent', 'add_approved_package'),
    arguments: [tx.object(args.agentId), tx.pure.address(args.pkg)],
  });
}

export function removeApprovedPackage(
  tx: Transaction,
  packageId: string,
  args: { agentId: string; pkg: string },
): TransactionResult {
  return tx.moveCall({
    target: target(packageId, 'agent', 'remove_approved_package'),
    arguments: [tx.object(args.agentId), tx.pure.address(args.pkg)],
  });
}

// ---------------------------------------------------------------------------
// Operational budget (vault self-funding) — package v2+
// ---------------------------------------------------------------------------

/**
 * Owner-only: set or update the per-epoch cap on `pull_operational_funds`.
 * Idempotent. Called once at mint-time + any time the owner wants to retune
 * the agent's operational budget.
 */
export function setOperationalCap(
  tx: Transaction,
  packageId: string,
  args: { agentId: string; capPerEpoch: bigint },
): TransactionResult {
  return tx.moveCall({
    target: target(packageId, 'agent', 'set_operational_cap'),
    arguments: [tx.object(args.agentId), tx.pure.u64(args.capPerEpoch)],
  });
}

/**
 * Session-only: pull `amount` of coin T from the vault treasury to fund
 * operational expenses (gas top-up, WAL acquisition, oracle queries).
 * Returns the freshly-extracted Coin<T> handle — the PTB MUST consume it,
 * typically by transferring it to the session address so the next tick has
 * fresh gas.
 *
 * Bounded by `operational_cap_per_epoch`. Aborts if the pull would exceed.
 */
export function pullOperationalFunds(
  tx: Transaction,
  packageId: string,
  args: {
    agentId: string;
    coinTypeTag: string;
    amount: bigint;
  },
): TransactionResult {
  return tx.moveCall({
    target: target(packageId, 'agent', 'pull_operational_funds'),
    typeArguments: [args.coinTypeTag],
    arguments: [tx.object(args.agentId), tx.pure.u64(args.amount)],
  });
}

// ---------------------------------------------------------------------------
// Convenience: full mint PTB chained in one place
// ---------------------------------------------------------------------------

export interface BuildMintPTBArgs {
  tx: Transaction;
  packageId: string;
  input: MintAgentInput;
  /** SUI coin (or another funding coin) to seed the treasury with. */
  fundingCoin: TransactionResult;
  /** Type tag for `fundingCoin`, e.g. `0x2::sui::SUI`. */
  fundingCoinTypeTag: string;
  /** Optional pre-provisioned messaging channels. */
  messaging?: { inboxId: string; outboxId: string };
}

/**
 * Compose the canonical mint PTB: `new` → `fund` → (optional) `attach_messaging`
 * → `share`. Returns the share-call result for any downstream chaining the
 * caller may want.
 */
export function buildMintPTB(args: BuildMintPTBArgs): TransactionResult {
  const { tx, packageId, input, fundingCoin, fundingCoinTypeTag, messaging } = args;
  const identity = newAgent(tx, packageId, input);
  fundAgent(tx, packageId, {
    identity,
    coin: fundingCoin,
    coinTypeTag: fundingCoinTypeTag,
  });
  if (messaging) {
    attachMessaging(tx, packageId, {
      identity,
      inboxId: messaging.inboxId,
      outboxId: messaging.outboxId,
    });
  }
  return shareAgent(tx, packageId, identity);
}
