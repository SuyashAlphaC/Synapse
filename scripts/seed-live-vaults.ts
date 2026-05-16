#!/usr/bin/env tsx
/**
 * One-shot: mint a real on-chain vault against each of the three active
 * Synapse strategies on testnet, fund each with a small amount of SUI, and
 * persist the resulting state (vault id, session keypair) to disk for the
 * live-tick runner to consume.
 *
 *   npx tsx scripts/seed-live-vaults.ts
 *
 * Idempotent in the dumb sense: each invocation creates new vaults.
 * Existing state at scripts/live-vaults.json is preserved (we append).
 * Manual cleanup if you want to recycle: rm scripts/live-vaults.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { fromBase64, toBase64 } from '@mysten/sui/utils';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import { type Keypair } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const STATE_PATH = resolve(__dirname, 'live-vaults.json');

const PACKAGE_ID =
  process.env['PACKAGE_ID'] ??
  '0x7b3f59e42edbf2189df644e63162d0b9a2c2984755bab9d3e9557c4ddd4aa67c';

const NETWORK: 'testnet' | 'mainnet' =
  (process.env['SYNAPSE_NETWORK'] as 'testnet' | 'mainnet') ?? 'testnet';

const FUNDING_MIST = BigInt(process.env['FUNDING_MIST'] ?? '50000000'); // 0.05 SUI
const SPEND_PER_EPOCH_MIST = (FUNDING_MIST * 50n) / 1000n; // 5%
const EXPIRY_OFFSET_EPOCHS = 30n;

// Allowlist DeepBookV3 testnet pkg so attempted swaps don't fail policy.
const APPROVED_PACKAGES = [
  '0xcaf6ba059d539a97646d47f0b9ddf843e138d215e2a12ca1f4585d386f7aec3a',
];

interface LiveVaultEntry {
  strategyId: string;
  strategyName: string;
  vaultId: string;
  sessionAddress: string;
  sessionSecretBase64: string;
  ownerAddress: string;
  digest: string;
  mintedAtMs: number;
  fundingMist: string;
}

interface SeedTarget {
  strategyId: string;
  name: string;
}

const TARGETS: SeedTarget[] = [
  {
    strategyId: '0x46996c0f9e692968f55a63c3cbc33eb8d19145c123b7a867a02da342e617d3ec',
    name: 'Synapse Conservative Rebalancer',
  },
  {
    strategyId: '0x44c0f7c4f6e04024c9bb1c0ce1eb1965018675cd074e7a410a59c2d43887c679',
    name: 'Synapse Balanced Yield',
  },
  {
    strategyId: '0xa1d73e17bc4c53484a3254c5ed3c0b24e340524d0014703c072f91d60f02d4a1',
    name: 'Synapse Aggressive Momentum',
  },
];

function loadKeypair(): Keypair {
  const path = join(homedir(), '.sui', 'sui_config', 'sui.keystore');
  const entries = JSON.parse(readFileSync(path, 'utf8')) as string[];
  if (entries.length === 0) throw new Error('Sui keystore is empty');
  const raw = fromBase64(entries[0]!);
  const scheme = raw[0]!;
  const secret = raw.slice(1);
  switch (scheme) {
    case 0x00:
      return Ed25519Keypair.fromSecretKey(secret);
    case 0x01:
      return Secp256k1Keypair.fromSecretKey(secret);
    case 0x02:
      return Secp256r1Keypair.fromSecretKey(secret);
    default:
      throw new Error(`Unsupported key scheme 0x${scheme.toString(16)}`);
  }
}

function loadState(): LiveVaultEntry[] {
  if (!existsSync(STATE_PATH)) return [];
  return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as LiveVaultEntry[];
}

function saveState(state: LiveVaultEntry[]): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

async function mintVault(args: {
  client: SuiJsonRpcClient;
  owner: Keypair;
  ownerAddress: string;
  strategyId: string;
  currentEpoch: bigint;
}): Promise<{
  vaultId: string;
  digest: string;
  sessionKeypair: Ed25519Keypair;
}> {
  const sessionKeypair = new Ed25519Keypair();
  const sessionAddress = sessionKeypair.toSuiAddress();
  const expiryEpoch = args.currentEpoch + EXPIRY_OFFSET_EPOCHS;

  const tx = new Transaction();
  const [fundingCoin] = tx.splitCoins(tx.gas, [FUNDING_MIST]);
  if (!fundingCoin) throw new Error('splitCoins returned no coin');

  const identity = tx.moveCall({
    target: `${PACKAGE_ID}::agent::new`,
    arguments: [
      tx.object(args.strategyId),
      tx.pure.address(sessionAddress),
      tx.pure.u64(expiryEpoch),
      tx.pure.u64(SPEND_PER_EPOCH_MIST),
      tx.pure.vector('address', APPROVED_PACKAGES),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(`memwal:${sessionAddress}`))),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode('delegate-live-tick'))),
      tx.pure.vector(
        'u8',
        Array.from(new TextEncoder().encode(`synapse:live:${args.strategyId.slice(2, 10)}`)),
      ),
    ],
  });
  tx.moveCall({
    target: `${PACKAGE_ID}::agent::fund`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [identity, fundingCoin],
  });
  tx.moveCall({
    target: `${PACKAGE_ID}::agent::share`,
    arguments: [identity],
  });
  tx.setGasBudget(80_000_000);

  const result = await args.client.signAndExecuteTransaction({
    signer: args.owner,
    transaction: tx,
    options: { showEffects: true, showObjectChanges: true },
  });
  if (result.effects?.status?.status !== 'success') {
    throw new Error(`Mint failed: ${JSON.stringify(result.effects?.status)}`);
  }
  await args.client.waitForTransaction({ digest: result.digest, timeout: 30_000 });

  const created = (result.objectChanges ?? []).filter((c) => c.type === 'created');
  const agentChange = created.find(
    (c) => 'objectType' in c && c.objectType.endsWith('::agent::AgentIdentity'),
  );
  if (!agentChange || !('objectId' in agentChange)) {
    throw new Error('AgentIdentity not found in created objects');
  }
  return {
    vaultId: agentChange.objectId as string,
    digest: result.digest,
    sessionKeypair,
  };
}

async function main(): Promise<void> {
  const owner = loadKeypair();
  const ownerAddress = owner.toSuiAddress();
  const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl(NETWORK) });
  console.log(`Seeding ${TARGETS.length} live vaults from ${ownerAddress}`);

  const state = loadState();
  const { epoch } = await client.getLatestSuiSystemState();
  const currentEpoch = BigInt(epoch);

  for (const target of TARGETS) {
    console.log(`\n→ ${target.name}`);
    const already = state.find((e) => e.strategyId === target.strategyId);
    if (already) {
      console.log(`  already minted: ${already.vaultId} (skipping)`);
      continue;
    }
    const minted = await mintVault({
      client,
      owner,
      ownerAddress,
      strategyId: target.strategyId,
      currentEpoch,
    });
    const sessionSecret = minted.sessionKeypair.getSecretKey().replace(/^suiprivkey/, '');
    const entry: LiveVaultEntry = {
      strategyId: target.strategyId,
      strategyName: target.name,
      vaultId: minted.vaultId,
      sessionAddress: minted.sessionKeypair.toSuiAddress(),
      sessionSecretBase64: sessionSecret,
      ownerAddress,
      digest: minted.digest,
      mintedAtMs: Date.now(),
      fundingMist: FUNDING_MIST.toString(),
    };
    state.push(entry);
    saveState(state);
    console.log(`  vault   ${entry.vaultId}`);
    console.log(`  session ${entry.sessionAddress}`);
    console.log(`  digest  ${entry.digest}`);
  }

  console.log(`\nState written → ${STATE_PATH}`);
  console.log('Next: npx tsx scripts/run-live-tick.ts');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
