#!/usr/bin/env npx tsx
/**
 * Provision a shared Sui Stack Messaging channel for a vault pair (or group).
 *
 * Creates the channel with all vault session keys as members, then attaches
 * inbox=outbox on each vault and optionally adds missing members.
 *
 * Env:
 *   SYNAPSE_PACKAGE_ID
 *   OWNER_KEY              owner suiprivkey (creates channel + attach_messaging)
 *   VAULT_IDS              comma/newline-separated AgentIdentity ids (this + peers)
 *   SUI_FULLNODE_URL       default testnet
 *
 * Example:
 *   OWNER_KEY=suiprivkey… VAULT_IDS=0xalpha,0xbeta SYNAPSE_PACKAGE_ID=0x… npx tsx scripts/provision-messaging-channel.ts
 */
import { spawn } from 'node:child_process';
import { accessSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(__dirname, '..', 'examples', 'messaging-runtime-bridge', 'dist', 'rpc.js');

function req(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function parseVaultIds(raw: string): string[] {
  return [...new Set(raw.split(/[\n,]+/).map((s) => s.trim()).filter((s) => s.startsWith('0x')))];
}

async function bridgeRpc(payload: Record<string, unknown>, ownerKey: string): Promise<unknown> {
  accessSync(BRIDGE);
  const fullnodeUrl = process.env.SUI_FULLNODE_URL ?? getFullnodeUrl('testnet');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BRIDGE], {
      env: {
        ...process.env,
        SYNAPSE_OWNER_KEY: ownerKey,
        SUI_FULLNODE_URL: fullnodeUrl,
        SYNAPSE_MESSAGING_NETWORK: 'testnet',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('close', (code) => {
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr || `bridge exit ${code}`));
        return;
      }
      const parsed = JSON.parse(stdout.trim()) as { ok: boolean; result?: unknown; error?: string };
      if (!parsed.ok) reject(new Error(parsed.error ?? 'bridge error'));
      else resolve(parsed.result);
    });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    child.stdin.end();
  });
}

async function loadSessionAddr(client: SuiClient, vaultId: string, packageId: string): Promise<string> {
  const obj = await client.getObject({ id: vaultId, options: { showContent: true } });
  const fields = (obj.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields;
  const session = fields?.session_addr as string | undefined;
  if (!session?.startsWith('0x')) throw new Error(`vault ${vaultId} missing session_addr`);
  return session;
}

async function attachMessaging(
  client: SuiClient,
  owner: Ed25519Keypair,
  packageId: string,
  vaultId: string,
  channelId: string,
): Promise<void> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::agent::attach_messaging`,
    arguments: [tx.object(vaultId), tx.pure.id(channelId), tx.pure.id(channelId)],
  });
  try {
    const r = await client.signAndExecuteTransaction({ signer: owner, transaction: tx });
    console.log(`  attach_messaging ${vaultId.slice(0, 10)}… tx ${r.digest}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/AlreadySet|abort/i.test(msg)) {
      console.log(`  attach_messaging ${vaultId.slice(0, 10)}… already attached`);
      return;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const packageId = req('SYNAPSE_PACKAGE_ID');
  const ownerKey = req('OWNER_KEY');
  const vaultIds = parseVaultIds(req('VAULT_IDS'));
  if (vaultIds.length === 0) throw new Error('VAULT_IDS must list at least one 0x vault id');

  const owner = Ed25519Keypair.fromSecretKey(ownerKey);
  const url = process.env.SUI_FULLNODE_URL ?? getFullnodeUrl('testnet');
  const client = new SuiClient({ url });

  const sessionAddrs: string[] = [];
  for (const vaultId of vaultIds) {
    sessionAddrs.push(await loadSessionAddr(client, vaultId, packageId));
  }
  const initialMembers = [...new Set(sessionAddrs)];

  console.log(`creating channel with ${initialMembers.length} session member(s)…`);
  const created = (await bridgeRpc({ op: 'createChannel', initialMembers }, ownerKey)) as {
    channelId: string;
    digest: string;
  };
  console.log(`  channel ${created.channelId} (tx ${created.digest})`);

  for (const vaultId of vaultIds) {
    await attachMessaging(client, owner, packageId, vaultId, created.channelId);
  }

  console.log('done — runtime will emit/consume on next ticks when messaging bridge is enabled');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
