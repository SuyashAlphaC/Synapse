/**
 * Cross-agent signalling for the runtime tick.
 *
 * Wraps Sui Stack Messaging behind two functions the tick calls — `consumeSignals`
 * (read peers' Seal-decrypted messages from the on-chain inbox channel, turn them
 * into memory facts) and `emitSignal` (send one Seal-encrypted, Walrus-stored
 * message to the outbox channel on a rebalance). Channels are PERSISTED on-chain
 * (`messaging_inbox` / `messaging_outbox` on the vault) — this module never
 * creates channels. All I/O degrades to a no-op on failure so a flaky relayer
 * never trips the tick kill-switch.
 *
 * The module depends on `MessagingLike`, the minimal slice of the messaging SDK
 * client it actually uses, so it is unit-testable without a live network. The
 * concrete client is INJECTED into the runtime (it pins `@mysten/sui` 1.x via
 * `@mysten/messaging`, which conflicts with the vault package's 2.x — so it is
 * constructed in the isolated messaging package, not here).
 */

import { Transaction } from '@mysten/sui/transactions';
import { target } from '@synapse-core/client';

/** Minimal Seal symmetric-key envelope the SDK's send path expects. */
export interface EncryptedSymmetricKeyLike {
  $kind: 'Encrypted';
  encryptedBytes: Uint8Array;
  version: number;
}

/** The slice of the `@mysten/messaging` client extension this module uses. */
export interface MessagingLike {
  messaging: {
    getChannelMessages(req: {
      channelId: string;
      userAddress: string;
      cursor?: bigint | null;
      limit?: number;
      direction?: 'backward' | 'forward';
    }): Promise<{
      messages: { text: string; sender: string; createdAtMs: string }[];
      cursor: bigint | null;
      hasNextPage: boolean;
    }>;
    getUserMemberCap(userAddress: string, channelId: string): Promise<{ id: { id: string } } | null>;
    getChannelObjectsByChannelIds(req: {
      channelIds: string[];
      userAddress: string;
    }): Promise<{ encryption_key_history: { latest: ArrayLike<number>; latest_version: number } }[]>;
    executeSendMessageTransaction(req: {
      signer: unknown;
      channelId: string;
      memberCapId: string;
      message: string;
      encryptedKey: EncryptedSymmetricKeyLike;
    }): Promise<{ digest: string }>;
  };
}

export interface ConsumeArgs {
  client: MessagingLike;
  inboxChannelId: string | null;
  userAddress: string;
  lastCursor: bigint | null;
  limit?: number;
}

export interface ConsumedMessage {
  text: string;
  sender: string;
}

export interface ConsumeResult {
  facts: string[];
  /** Raw inbox payloads — use for on-chain digests (not the fact strings). */
  messages: ConsumedMessage[];
  newCursor: bigint | null;
}

/**
 * Read new inbox messages since `lastCursor`, returning them as memory-fact
 * strings to inject into the strategy input. Degrades to `{ facts: [], newCursor:
 * lastCursor }` on any failure or when no channel is attached.
 */
export async function consumeSignals(args: ConsumeArgs): Promise<ConsumeResult> {
  if (!args.inboxChannelId) return { facts: [], messages: [], newCursor: null };
  try {
    const res = await args.client.messaging.getChannelMessages({
      channelId: args.inboxChannelId,
      userAddress: args.userAddress,
      cursor: args.lastCursor,
      direction: 'forward',
      ...(args.limit ? { limit: args.limit } : {}),
    });
    const messages = res.messages.map((m) => ({ text: m.text, sender: m.sender }));
    const facts = messages.map((m) => `peer ${m.sender.slice(0, 10)}: ${m.text}`);
    return { facts, messages, newCursor: res.cursor ?? args.lastCursor };
  } catch {
    // Degrade: no peer facts this tick. Keep the old cursor so nothing is skipped.
    return { facts: [], messages: [], newCursor: args.lastCursor };
  }
}

export interface EmitArgs {
  client: MessagingLike;
  outboxChannelId: string | null;
  userAddress: string;
  signer: unknown;
  message: string;
}

export interface EmitResult {
  digest: string;
}

/**
 * Send ONE Seal-encrypted, Walrus-stored message to the outbox channel. The
 * current channel DEK is read from the on-chain channel's `encryption_key_history`
 * (latest entry) — the same path the SDK uses internally. Returns null (degrades)
 * when no channel is attached, the member cap is missing, or send fails.
 */
export async function emitSignal(args: EmitArgs): Promise<EmitResult | null> {
  if (!args.outboxChannelId) return null;
  try {
    const cap = await args.client.messaging.getUserMemberCap(args.userAddress, args.outboxChannelId);
    if (!cap) return null;

    const [channel] = await args.client.messaging.getChannelObjectsByChannelIds({
      channelIds: [args.outboxChannelId],
      userAddress: args.userAddress,
    });
    if (!channel) return null;

    const encryptedKey: EncryptedSymmetricKeyLike = {
      $kind: 'Encrypted',
      encryptedBytes: new Uint8Array(Array.from(channel.encryption_key_history.latest)),
      version: channel.encryption_key_history.latest_version,
    };

    const res = await args.client.messaging.executeSendMessageTransaction({
      signer: args.signer,
      channelId: args.outboxChannelId,
      memberCapId: cap.id.id,
      message: args.message,
      encryptedKey,
    });
    return { digest: res.digest };
  } catch {
    return null;
  }
}

/** sha256(text) as a byte array — the on-chain correlation digest. */
export async function messageDigest(text: string): Promise<number[]> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  );
  return Array.from(bytes);
}

/**
 * Append `messaging_bridge::record_receive`. For a shared broadcast channel
 * (inbox = outbox), pass the same channel id as `senderOutboxId`.
 */
export function recordReceivePTB(
  tx: Transaction,
  packageId: string,
  vaultId: string,
  senderOutboxId: string,
  digest: number[],
): void {
  tx.moveCall({
    target: target(packageId, 'messagingBridge', 'record_receive'),
    arguments: [tx.object(vaultId), tx.pure.id(senderOutboxId), tx.pure.vector('u8', digest)],
  });
}

/**
 * Append `messaging_bridge::record_send`. For a shared broadcast channel,
 * pass the channel id as `recipientInboxId`.
 */
export function recordSendPTB(
  tx: Transaction,
  packageId: string,
  vaultId: string,
  recipientInboxId: string,
  digest: number[],
): void {
  tx.moveCall({
    target: target(packageId, 'messagingBridge', 'record_send'),
    arguments: [tx.object(vaultId), tx.pure.id(recipientInboxId), tx.pure.vector('u8', digest)],
  });
}
