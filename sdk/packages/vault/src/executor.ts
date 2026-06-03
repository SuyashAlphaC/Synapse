/**
 * Vault executor — converts a `RebalancePlan` into an executable Synapse PTB.
 *
 * Single PTB chains:
 *   1. For each planned trade: pre-swap authorize event (`deepbook_adapter::authorize_swap`)
 *   2. For each planned trade: `wallet::spend<From>` to extract policy-gated coin
 *   3. For each planned trade: actual DeepBookV3 swap call (composed externally
 *      by the caller — we don't wrap DeepBookV3 directly per the composability
 *      principle established in `deepbook_adapter.move`)
 *   4. For each completed trade: `deepbook_adapter::record_swap` audit event
 *   5. `artifacts::publish` for the markdown audit report (Walrus blob already
 *      uploaded out-of-band)
 *   6. `attestation::log_action` for a top-level rebalance entry
 *
 * The DeepBookV3 swap call is supplied as a higher-order function by the
 * caller — this keeps the executor decoupled from any specific DeepBookV3
 * version while still enforcing Synapse policy.
 */

import type { Transaction, TransactionObjectArgument, TransactionResult } from '@mysten/sui/transactions';
import {
  target,
  ActionKind,
  SwapDirection,
  publishArtifactCall,
  spend,
} from '@synapse-core/client';
import { sha256 } from '@noble/hashes/sha2.js';
import type { ExecutedTrade, RebalancePlan, PlannedTrade, AuditReport } from './types.js';

/**
 * Caller-supplied DeepBookV3 swap function. Given the input coin handle from
 * `wallet::spend`, this returns the output coin handle. The executor wires
 * the input/output together but doesn't know DeepBookV3's specific API.
 *
 * The function receives `vaultId` and `synapsePackageId` so it can route any
 * unfilled remainder coins back into the vault treasury via `wallet::deposit`
 * — DeepBookV3 swaps can return non-zero base/quote remainders on partial
 * fills, and silently `destroy_zero`-ing them would revert the entire PTB.
 */
export interface DeepBookSwapContext {
  trade: PlannedTrade;
  inputCoin: TransactionObjectArgument;
  /** AgentIdentity object ID. Used to deposit remainders back to treasury. */
  vaultId: string;
  /** synapse_core package ID. Used to construct wallet::deposit calls. */
  synapsePackageId: string;
}

export type DeepBookSwapFn = (
  tx: Transaction,
  ctx: DeepBookSwapContext,
) => TransactionObjectArgument;

export interface BuildRebalancePTBArgs {
  tx: Transaction;
  synapsePackageId: string;
  vaultId: string;
  plan: RebalancePlan;
  report: AuditReport;
  /** Walrus upload result for the report. */
  reportWalrusBlobId: string;
  /** Default DeepBookV3 package address — used as `target_pkg` in spend gates. */
  deepbookPkg: string;
  /** Caller-supplied DeepBookV3 swap function. */
  swap: DeepBookSwapFn;
  /**
   * Whether the uploaded report blob is Seal-encrypted. When true the
   * artifact is recorded with `seal_encrypted = true` and an opaque MIME
   * type. Default false (plaintext markdown).
   */
  sealEncrypted?: boolean;
  /**
   * sha256 + byte size of the ACTUAL uploaded blob (ciphertext when sealed).
   * When omitted, falls back to the plaintext report's hash/size. Pass the
   * `WalrusUploadResult` values so the on-chain ArtifactRef matches the blob.
   */
  blobSha256?: Uint8Array;
  blobSizeBytes?: number;
  /**
   * Optional Nautilus attestation. When present, a
   * `decision_attestation::attest_decision` call is prepended to the PTB — the
   * whole transaction (including the swap) aborts unless the registered enclave
   * signed exactly this decision. Only set for vaults running attested execution.
   */
  attestation?: {
    enclaveObjectId: string;
    epoch: bigint;
    targetWeightMilli: number;
    inputsHash: number[];
    timestampMs: bigint;
    signature: number[];
  };
}

export interface BuildRebalancePTBResult {
  /** The PTB result handle for the published artifact (a `u64` slot). */
  artifactSlotHandle: TransactionResult | null;
}

/**
 * Compose the rebalance PTB. The caller is responsible for actually signing
 * and submitting the transaction.
 */
export function buildRebalancePTB(args: BuildRebalancePTBArgs): BuildRebalancePTBResult {
  const { tx, synapsePackageId, vaultId, plan, report, reportWalrusBlobId, deepbookPkg, swap } =
    args;
  const sealEncrypted = args.sealEncrypted ?? false;

  // 0. Attested execution (Nautilus): gate the entire PTB on a valid enclave
  //    signature over this decision. Placed FIRST so the swap can't execute on a
  //    forged/tampered decision — the Move VM aborts the whole transaction.
  if (args.attestation) {
    const a = args.attestation;
    tx.moveCall({
      target: target(synapsePackageId, 'decisionAttestation', 'attest_decision'),
      arguments: [
        tx.object(a.enclaveObjectId),
        tx.object(vaultId), // &mut AgentIdentity — vault_id derived + stamped on-chain
        tx.pure.u64(a.epoch),
        tx.pure.u64(a.targetWeightMilli),
        tx.pure.vector('u8', a.inputsHash),
        tx.pure.u64(a.timestampMs),
        tx.pure.vector('u8', a.signature),
      ],
    });
  }

  for (const trade of plan.trades) {
    // The adapter is generic over <Base, Quote> and derives the event's
    // base_type/quote_type from these type args — they are pool-canonical, NOT
    // trade-directional. For a quote->base trade (direction 1) from=quote and
    // to=base, so passing [from, to] would record base/quote swapped. Normalize.
    const [baseTypeTag, quoteTypeTag] =
      trade.direction === 1
        ? [trade.toTypeTag, trade.fromTypeTag]
        : [trade.fromTypeTag, trade.toTypeTag];

    // 1. Authorize the swap (pre-flight policy gate + event)
    tx.moveCall({
      target: target(synapsePackageId, 'deepbookAdapter', 'authorize_swap'),
      typeArguments: [baseTypeTag, quoteTypeTag],
      arguments: [
        tx.object(vaultId),
        tx.pure.id(trade.poolId),
        tx.pure.address(deepbookPkg),
        tx.pure.u8(trade.direction),
        tx.pure.u64(trade.amountIn),
      ],
    });

    // 2. Withdraw the input coin via policy-gated spend
    const inputCoin = spend(tx, synapsePackageId, {
      agentId: vaultId,
      targetPkg: deepbookPkg,
      amount: trade.amountIn,
      coinTypeTag: trade.fromTypeTag,
    });

    // 3. Caller-supplied DeepBookV3 swap
    const outputCoin = swap(tx, { trade, inputCoin, vaultId, synapsePackageId });

    // 4. Measure the REAL output amount on-chain before the coin is consumed,
    //    so the audit event records the actual fill rather than the slippage
    //    floor (minAmountOut). This also makes record_swap's output_amount > 0
    //    check pass for any successful swap even when minAmountOut is 0.
    const outputAmount = tx.moveCall({
      target: '0x2::coin::value',
      typeArguments: [trade.toTypeTag],
      arguments: [outputCoin],
    });

    // 5. Deposit the output back into the vault treasury
    tx.moveCall({
      target: target(synapsePackageId, 'wallet', 'deposit'),
      typeArguments: [trade.toTypeTag],
      arguments: [tx.object(vaultId), outputCoin],
    });

    // 6. Record the swap audit event (same base/quote normalization)
    tx.moveCall({
      target: target(synapsePackageId, 'deepbookAdapter', 'record_swap'),
      typeArguments: [baseTypeTag, quoteTypeTag],
      arguments: [
        tx.object(vaultId),
        tx.pure.id(trade.poolId),
        tx.pure.address(deepbookPkg),
        tx.pure.u8(trade.direction),
        tx.pure.u64(trade.amountIn),
        outputAmount, // real fill measured on-chain via coin::value
        tx.pure.string(`${plan.planId}#${shortenPool(trade.poolId)}`),
      ],
    });
  }

  // 6. Publish the audit report as a Walrus artifact — OPTIONAL. When
  //    `reportWalrusBlobId` is empty the caller couldn't upload (no WAL,
  //    publisher down, etc.) and we degrade by skipping the artifact
  //    registration. The on-chain action log + swap audit events still
  //    land, so the rebalance is fully recorded — just without the
  //    fetchable rationale blob.
  const artifactSlotHandle: TransactionResult | null =
    reportWalrusBlobId.length > 0
      ? publishArtifactCall(tx, synapsePackageId, {
          agentId: vaultId,
          walrusBlobId: new TextEncoder().encode(reportWalrusBlobId),
          sha256: args.blobSha256 ?? report.sha256,
          mimeType: sealEncrypted ? 'application/octet-stream' : 'text/markdown',
          sizeBytes: BigInt(
            args.blobSizeBytes ?? new TextEncoder().encode(report.markdown).byteLength,
          ),
          sealEncrypted,
          label: `rebalance-${plan.planId}`,
        })
      : null;

  // 7. Top-level action log
  tx.moveCall({
    target: target(synapsePackageId, 'attestation', 'log_action'),
    arguments: [
      tx.object(vaultId),
      tx.pure.u8(ActionKind.ArtifactPublish),
      tx.pure.string(
        `rebalance ${plan.planId}: ${plan.summary}${reportWalrusBlobId.length === 0 ? ' (no walrus blob — operational WAL missing)' : ''}`,
      ),
      tx.pure.vector('u8', Array.from(report.sha256)),
    ],
  });

  return { artifactSlotHandle };
}

/** Compute the deterministic plan ID for a given trade list. */
export function computePlanId(vaultId: string, epoch: bigint, trades: PlannedTrade[]): string {
  const payload = JSON.stringify({
    v: vaultId,
    e: epoch.toString(),
    t: trades.map((t) => ({
      p: t.poolId,
      f: t.fromTypeTag,
      to: t.toTypeTag,
      a: t.amountIn.toString(),
      m: t.minAmountOut.toString(),
      d: t.direction,
    })),
  });
  const digest = sha256(new TextEncoder().encode(payload));
  return `${bytesToHex(digest).slice(0, 16)}`;
}

/** Reconstruct an ExecutedTrade record from a planned trade + actual output. */
export function makeExecutedTrade(planned: PlannedTrade, actualAmountOut: bigint): ExecutedTrade {
  const denom = Number(planned.amountIn);
  const executionPrice = denom === 0 ? 0 : Number(actualAmountOut) / denom;
  return {
    poolId: planned.poolId,
    fromTypeTag: planned.fromTypeTag,
    toTypeTag: planned.toTypeTag,
    amountIn: planned.amountIn,
    amountOut: actualAmountOut,
    executionPrice,
  };
}

function shortenPool(poolId: string): string {
  return poolId.slice(0, 10);
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    const v = b[i] ?? 0;
    s += v.toString(16).padStart(2, '0');
  }
  return s;
}

// Re-export swap direction enum for convenience (matches Move discriminants).
export { SwapDirection };
