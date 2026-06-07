/**
 * PTB builders for `synapse_core::messaging_bridge` audit records.
 *
 * The actual message payloads live on Walrus via Sui Stack Messaging; these
 * calls only emit correlated on-chain events keyed by sha256(message text).
 */

import { Transaction, type TransactionResult } from '@mysten/sui/transactions';
import { target } from './config.js';

/**
 * Append `messaging_bridge::record_send`. Session key must sign the PTB.
 * For a shared broadcast channel, pass the channel id as `recipientInboxId`.
 */
export function recordMessageSend(
  tx: Transaction,
  packageId: string,
  args: {
    vaultId: TransactionResult | string;
    recipientInboxId: string;
    messageDigest: number[] | Uint8Array;
  },
): TransactionResult {
  const vault =
    typeof args.vaultId === 'string' ? tx.object(args.vaultId) : args.vaultId;
  const digest =
    args.messageDigest instanceof Uint8Array
      ? Array.from(args.messageDigest)
      : args.messageDigest;
  return tx.moveCall({
    target: target(packageId, 'messagingBridge', 'record_send'),
    arguments: [vault, tx.pure.id(args.recipientInboxId), tx.pure.vector('u8', digest)],
  });
}

/**
 * Append `messaging_bridge::record_receive`. Session key must sign the PTB.
 * For a shared broadcast channel, pass the channel id as `senderOutboxId`.
 */
export function recordMessageReceive(
  tx: Transaction,
  packageId: string,
  args: {
    vaultId: TransactionResult | string;
    senderOutboxId: string;
    messageDigest: number[] | Uint8Array;
  },
): TransactionResult {
  const vault =
    typeof args.vaultId === 'string' ? tx.object(args.vaultId) : args.vaultId;
  const digest =
    args.messageDigest instanceof Uint8Array
      ? Array.from(args.messageDigest)
      : args.messageDigest;
  return tx.moveCall({
    target: target(packageId, 'messagingBridge', 'record_receive'),
    arguments: [vault, tx.pure.id(args.senderOutboxId), tx.pure.vector('u8', digest)],
  });
}
