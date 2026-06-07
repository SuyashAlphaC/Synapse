#!/usr/bin/env node
/**
 * JSON stdin/stdout RPC bridge for Sui Stack Messaging.
 *
 * The main Synapse vault runtime (sui 2.x) spawns this process per messaging
 * call so @mysten/messaging (sui 1.x pin) never enters the vault dependency
 * graph.
 *
 * Env (set by parent):
 *   SYNAPSE_SESSION_KEY  — session suiprivkey for channel member ops + send
 *   SYNAPSE_OWNER_KEY    — owner suiprivkey for createChannel / addMembers
 *   SUI_FULLNODE_URL     — JSON-RPC URL (default testnet fullnode)
 *   SYNAPSE_MESSAGING_NETWORK — testnet | mainnet (default testnet)
 *
 * Request (one JSON object on stdin):
 *   { "op": "getChannelMessages", "channelId", "userAddress", "cursor?", "limit?" }
 *   { "op": "getUserMemberCap", "channelId", "userAddress" }
 *   { "op": "getChannelObjectsByChannelIds", "channelIds", "userAddress" }
 *   { "op": "executeSendMessageTransaction", "channelId", "memberCapId", "message", "encryptedKey" }
 *   { "op": "createChannel", "initialMembers"?: string[] }
 *   { "op": "addChannelMembers", "channelId", "members": string[] }
 *
 * Response: { "ok": true, "result": ... } | { "ok": false, "error": "..." }
 */
import { readFileSync } from 'node:fs';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SealClient } from '@mysten/seal';
import { messaging, TESTNET_MESSAGING_PACKAGE_CONFIG } from '@mysten/messaging';

const TESTNET_WALRUS = {
  publisher: 'https://publisher.walrus-testnet.walrus.space',
  aggregator: 'https://aggregator.walrus-testnet.walrus.space',
};

const TESTNET_SEAL_KEY_SERVERS = [
  '0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75',
  '0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8',
];

type RpcRequest =
  | {
      op: 'getChannelMessages';
      channelId: string;
      userAddress: string;
      cursor?: string | null;
      limit?: number;
    }
  | { op: 'getUserMemberCap'; channelId: string; userAddress: string }
  | { op: 'getChannelObjectsByChannelIds'; channelIds: string[]; userAddress: string }
  | {
      op: 'executeSendMessageTransaction';
      channelId: string;
      memberCapId: string;
      message: string;
      encryptedKey: { encryptedBytes: number[]; version: number };
    }
  | { op: 'createChannel'; initialMembers?: string[] }
  | { op: 'addChannelMembers'; channelId: string; members: string[] };

interface RpcOk {
  ok: true;
  result: unknown;
}

interface RpcErr {
  ok: false;
  error: string;
}

function loadKeypairFromEnv(envName: 'SYNAPSE_SESSION_KEY' | 'SYNAPSE_OWNER_KEY'): Ed25519Keypair {
  const raw = process.env[envName]?.trim();
  if (!raw) throw new Error(`${envName} is required`);

  if (raw.startsWith('{')) {
    const parsed = JSON.parse(raw) as { suiPrivateKey?: string; secretBase64?: string };
    const sui = parsed.suiPrivateKey?.trim();
    if (sui?.startsWith('suiprivkey')) return Ed25519Keypair.fromSecretKey(sui);
    const b64 = parsed.secretBase64?.trim();
    if (b64) {
      const bytes = Buffer.from(b64, 'base64');
      if (bytes.length === 32) return Ed25519Keypair.fromSecretKey(new Uint8Array(bytes));
    }
    throw new Error(`${envName} JSON missing suiPrivateKey or secretBase64`);
  }

  if (raw.startsWith('suiprivkey')) return Ed25519Keypair.fromSecretKey(raw);
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length === 32) return Ed25519Keypair.fromSecretKey(new Uint8Array(bytes));
  throw new Error(`${envName} must be suiprivkey, base64 32-byte secret, or JSON .key file`);
}

function createMessagingClient(sessionAddress: string, signer: Ed25519Keypair) {
  const network = process.env.SYNAPSE_MESSAGING_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
  if (network === 'mainnet') {
    throw new Error('mainnet messaging bridge not configured yet');
  }
  const url = process.env.SUI_FULLNODE_URL ?? getFullnodeUrl('testnet');

  return new SuiClient({
    url,
    mvr: {
      overrides: {
        packages: {
          '@local-pkg/sui-stack-messaging': TESTNET_MESSAGING_PACKAGE_CONFIG.packageId,
        },
      },
    },
  })
    .$extend(
      SealClient.asClientExtension({
        serverConfigs: TESTNET_SEAL_KEY_SERVERS.map((objectId) => ({ objectId, weight: 1 })),
      }),
    )
    .$extend(
      messaging({
        packageConfig: TESTNET_MESSAGING_PACKAGE_CONFIG,
        walrusStorageConfig: { ...TESTNET_WALRUS, epochs: 5 },
        sessionKeyConfig: { address: sessionAddress, ttlMin: 30, signer },
        sealConfig: { threshold: 2 },
      }),
    );
}

function buildSessionClient(userAddress: string) {
  const signer = loadKeypairFromEnv('SYNAPSE_SESSION_KEY');
  return createMessagingClient(userAddress, signer);
}

function buildOwnerClient() {
  const owner = loadKeypairFromEnv('SYNAPSE_OWNER_KEY');
  return { client: createMessagingClient(owner.toSuiAddress(), owner), owner };
}

async function handle(req: RpcRequest): Promise<unknown> {
  switch (req.op) {
    case 'getChannelMessages': {
      const client = buildSessionClient(req.userAddress);
      const cursor =
        req.cursor === null || req.cursor === undefined ? null : BigInt(req.cursor);
      const res = await client.messaging.getChannelMessages({
        channelId: req.channelId,
        userAddress: req.userAddress,
        cursor,
        direction: 'forward',
        ...(req.limit ? { limit: req.limit } : {}),
      });
      return {
        messages: res.messages,
        cursor: res.cursor === null ? null : res.cursor.toString(),
        hasNextPage: res.hasNextPage,
      };
    }
    case 'getUserMemberCap': {
      const client = buildSessionClient(req.userAddress);
      const cap = await client.messaging.getUserMemberCap(req.userAddress, req.channelId);
      return cap;
    }
    case 'getChannelObjectsByChannelIds': {
      const client = buildSessionClient(req.userAddress);
      const channels = await client.messaging.getChannelObjectsByChannelIds({
        channelIds: req.channelIds,
        userAddress: req.userAddress,
      });
      return channels.map((ch) => ({
        encryption_key_history: {
          latest: Array.from(ch.encryption_key_history.latest),
          latest_version: ch.encryption_key_history.latest_version,
        },
      }));
    }
    case 'executeSendMessageTransaction': {
      const signer = loadKeypairFromEnv('SYNAPSE_SESSION_KEY');
      const client = buildSessionClient(signer.toSuiAddress());
      const res = await client.messaging.executeSendMessageTransaction({
        signer,
        channelId: req.channelId,
        memberCapId: req.memberCapId,
        message: req.message,
        encryptedKey: {
          $kind: 'Encrypted',
          encryptedBytes: new Uint8Array(req.encryptedKey.encryptedBytes),
          version: req.encryptedKey.version,
        },
      });
      return { digest: res.digest };
    }
    case 'createChannel': {
      const { client, owner } = buildOwnerClient();
      const members = [...new Set((req.initialMembers ?? []).filter(Boolean))];
      const created = await client.messaging.executeCreateChannelTransaction({
        signer: owner,
        initialMembers: members,
      });
      return {
        channelId: created.channelId,
        digest: created.digest,
        creatorCapId: created.creatorCapId,
        initialMembers: members,
      };
    }
    case 'addChannelMembers': {
      const { client, owner } = buildOwnerClient();
      const ownerAddr = owner.toSuiAddress();
      const ownerCap = await client.messaging.getUserMemberCap(ownerAddr, req.channelId);
      if (!ownerCap) throw new Error('owner MemberCap not found for channel');
      const members = [...new Set(req.members.filter(Boolean))];
      const res = await client.messaging.executeAddMembersTransaction({
        signer: owner,
        channelId: req.channelId,
        memberCapId: ownerCap.id.id,
        newMemberAddresses: members,
      });
      return {
        digest: res.digest,
        addedMembers: res.addedMembers.map((m) => ({
          memberCapId: m.memberCap.id.id,
          ownerAddress: m.ownerAddress,
        })),
      };
    }
    default:
      throw new Error(`unknown op ${(req as { op: string }).op}`);
  }
}

async function main(): Promise<void> {
  const stdin = readFileSync(0, 'utf8').trim();
  if (!stdin) throw new Error('empty stdin');
  const req = JSON.parse(stdin) as RpcRequest;
  try {
    const result = await handle(req);
    const out: RpcOk = { ok: true, result };
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (err) {
    const out: RpcErr = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exitCode = 1;
  }
}

main();
