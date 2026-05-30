/**
 * Sui Stack Messaging demo — agent-to-agent message, stored on Walrus,
 * correlated on-chain via synapse_core::messaging_bridge.
 *
 * Why this is an isolated package: `@mysten/messaging@0.3.0` pins
 * `@mysten/sui@^1.x` + `@mysten/seal@^0.9`, while the main Synapse SDK is on
 * sui 2.x / seal 1.1 — major-version incompatible. Rather than fork the whole
 * codebase, the Sui Stack Messaging leg lives here with its own compatible
 * deps; the on-chain audit leg uses plain Transaction calls to synapse_core,
 * so no Synapse SDK import is needed.
 *
 * Flow (all real, no mocks):
 *   1. owner creates a Sui Stack Messaging channel with the recipient as a
 *      member — the channel + its messages are stored on Walrus, Seal-encrypted.
 *   2. owner sends one message into the channel (real Walrus write).
 *   3. on-chain: attach_messaging(vault, channel, channel) [owner], then
 *      messaging_bridge::record_send(senderVault, channel, digest) [sender
 *      session] and record_receive(recipientVault, channel, digest)
 *      [recipient session] — emitting MessageSentEvent / MessageReceivedEvent
 *      correlated by the same message digest.
 *
 * Env:
 *   SYNAPSE_PACKAGE_ID         synapse_core package id
 *   OWNER_KEY                  owner suiprivkey… (creates channel + sends + attaches)
 *   SENDER_VAULT, RECIPIENT_VAULT   AgentIdentity object ids
 *   SENDER_SESSION_KEY, RECIPIENT_SESSION_KEY   suiprivkey… for record_send/receive
 *   MESSAGE                    message text (default a demo line)
 *   SUI_FULLNODE_URL           default testnet
 */
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { SealClient } from '@mysten/seal';
import { messaging, TESTNET_MESSAGING_PACKAGE_CONFIG } from '@mysten/messaging';

const TESTNET_WALRUS = {
  publisher: 'https://publisher.walrus-testnet.walrus.space',
  aggregator: 'https://aggregator.walrus-testnet.walrus.space',
};

// Mysten testnet Seal key servers (verified live as ::key_server::KeyServer).
const TESTNET_SEAL_KEY_SERVERS = [
  '0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75',
  '0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8',
];

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function kp(suiprivkey: string): Ed25519Keypair {
  return Ed25519Keypair.fromSecretKey(suiprivkey.trim());
}

async function main(): Promise<void> {
  const packageId = req('SYNAPSE_PACKAGE_ID');
  const owner = kp(req('OWNER_KEY'));
  const senderVault = req('SENDER_VAULT');
  const recipientVault = req('RECIPIENT_VAULT');
  const senderSession = kp(req('SENDER_SESSION_KEY'));
  const recipientSession = kp(req('RECIPIENT_SESSION_KEY'));
  const messageText = process.env.MESSAGE ?? 'cross-agent signal: rotate 5% SUI→USDC next epoch';
  const url = process.env.SUI_FULLNODE_URL ?? getFullnodeUrl('testnet');

  const ownerAddr = owner.toSuiAddress();
  const recipientAddr = recipientSession.toSuiAddress();

  // Build a Sui client extended with Seal + Sui Stack Messaging. Messages are
  // stored on Walrus and Seal-encrypted to channel members.
  const client = new SuiClient({ url })
    .$extend(
      SealClient.asClientExtension({
        serverConfigs: TESTNET_SEAL_KEY_SERVERS.map((objectId) => ({ objectId, weight: 1 })),
      }),
    )
    .$extend(
      messaging({
        packageConfig: TESTNET_MESSAGING_PACKAGE_CONFIG,
        walrusStorageConfig: { ...TESTNET_WALRUS, epochs: 5 },
        sessionKeyConfig: { address: ownerAddr, ttlMin: 30, signer: owner },
        sealConfig: { threshold: 2 },
      }),
    );

  // 1. Create the channel (owner is creator; recipient added as member).
  console.log('creating Sui Stack Messaging channel…');
  const created = await client.messaging.executeCreateChannelTransaction({
    signer: owner,
    initialMembers: [recipientAddr],
  });
  const channelId = created.channelId;
  console.log(`  channel ${channelId} (tx ${created.digest})`);

  // 2. Send one message — real Walrus write, Seal-encrypted to members.
  const ownerCap = await client.messaging.getUserMemberCap(ownerAddr, channelId);
  if (!ownerCap) throw new Error('owner MemberCap not found for channel');
  const memberCapId = ownerCap.id.id;
  // Fresh channel → the key returned by create is the first (version 0).
  const encryptedKey = {
    $kind: 'Encrypted' as const,
    encryptedBytes: created.encryptedKeyBytes,
    version: 0,
  };

  console.log('sending message (stored on Walrus, Seal-encrypted)…');
  const sent = await client.messaging.executeSendMessageTransaction({
    signer: owner,
    channelId,
    memberCapId,
    message: messageText,
    encryptedKey,
  });
  console.log(`  message sent (tx ${sent.digest})`);

  // Digest correlating the on-chain send/receive records: sha256 of the text.
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(messageText)),
  );

  // 3a. Attach the channel to both vaults (owner-gated, one-time).
  await attachMessaging(client, packageId, owner, senderVault, channelId);
  await attachMessaging(client, packageId, owner, recipientVault, channelId);

  // 3b. record_send (sender session) + record_receive (recipient session).
  await recordSend(client, packageId, senderSession, senderVault, channelId, digest);
  await recordReceive(client, packageId, recipientSession, recipientVault, channelId, digest);

  console.log('done — message on Walrus + MessageSent/Received correlated on-chain');
}

async function attachMessaging(
  client: SuiClient,
  packageId: string,
  owner: Ed25519Keypair,
  vault: string,
  channelId: string,
): Promise<void> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::agent::attach_messaging`,
    arguments: [tx.object(vault), tx.pure.id(channelId), tx.pure.id(channelId)],
  });
  try {
    const r = await client.signAndExecuteTransaction({ signer: owner, transaction: tx });
    console.log(`  attach_messaging ${vault.slice(0, 10)} (tx ${r.digest})`);
  } catch (err) {
    // Already attached (EMessagingAlreadySet) is fine — idempotent for reruns.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/AlreadySet|abort/i.test(msg)) throw err;
    console.log(`  attach_messaging ${vault.slice(0, 10)} — already attached`);
  }
}

async function recordSend(
  client: SuiClient,
  packageId: string,
  session: Ed25519Keypair,
  vault: string,
  channelId: string,
  digest: Uint8Array,
): Promise<void> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::messaging_bridge::record_send`,
    arguments: [tx.object(vault), tx.pure.id(channelId), tx.pure.vector('u8', Array.from(digest))],
  });
  const r = await client.signAndExecuteTransaction({ signer: session, transaction: tx });
  console.log(`  record_send (tx ${r.digest})`);
}

async function recordReceive(
  client: SuiClient,
  packageId: string,
  session: Ed25519Keypair,
  vault: string,
  channelId: string,
  digest: Uint8Array,
): Promise<void> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::messaging_bridge::record_receive`,
    arguments: [tx.object(vault), tx.pure.id(channelId), tx.pure.vector('u8', Array.from(digest))],
  });
  const r = await client.signAndExecuteTransaction({ signer: session, transaction: tx });
  console.log(`  record_receive (tx ${r.digest})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
