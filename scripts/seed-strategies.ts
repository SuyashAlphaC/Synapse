#!/usr/bin/env tsx
/**
 * One-shot script: publish the three default Synapse strategies on testnet
 * (Conservative, Balanced, Aggressive). Run after a fresh package deploy so
 * the marketplace UI has something to display on first load.
 *
 *   PACKAGE_ID=0x7b3f5... npx tsx scripts/seed-strategies.ts
 *
 * Reads the local Sui CLI keystore (~/.sui/sui_config/sui.keystore) so it
 * publishes from the same address the CLI is configured with.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { fromBase64, toHex } from '@mysten/sui/utils';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import { type Keypair } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { createHash } from 'node:crypto';

const PACKAGE_ID =
  process.env['PACKAGE_ID'] ??
  '0x7b3f59e42edbf2189df644e63162d0b9a2c2984755bab9d3e9557c4ddd4aa67c';

interface SeedStrategy {
  name: string;
  description: string;
  source: string;
  riskProfile: 0 | 1 | 2;
  royaltyBps: number;
}

const STRATEGIES: SeedStrategy[] = [
  {
    name: 'Synapse Conservative Rebalancer',
    description:
      'Daily SUI/USDC rebalance with 5% per-epoch cap. Targets benchmark + 50bps with minimal drawdown.',
    source: 'walrus-blob-conservative-v1',
    riskProfile: 0,
    royaltyBps: 1500,
  },
  {
    name: 'Synapse Balanced Yield',
    description:
      'Rotates between SUI/USDC and SUI/USDT depending on Pyth volatility. Targets benchmark + 200bps.',
    source: 'walrus-blob-balanced-v1',
    riskProfile: 1,
    royaltyBps: 2000,
  },
  {
    name: 'Synapse Aggressive Momentum',
    description:
      'Momentum-following on 4-hour SUI candles via DeepBookV3. Higher drawdown tolerance, alpha target +500bps.',
    source: 'walrus-blob-aggressive-v1',
    riskProfile: 2,
    royaltyBps: 2500,
  },
];

function loadKeypair(): Keypair {
  const keystorePath = join(homedir(), '.sui', 'sui_config', 'sui.keystore');
  const entries = JSON.parse(readFileSync(keystorePath, 'utf8')) as string[];
  if (entries.length === 0) {
    throw new Error('Sui keystore is empty');
  }
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

function codeHashOf(text: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(text).digest());
}

async function main(): Promise<void> {
  const keypair = loadKeypair();
  const address = keypair.toSuiAddress();
  console.log(`Seeding ${STRATEGIES.length} strategies from ${address}`);

  const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl('testnet') });

  for (const s of STRATEGIES) {
    const tx = new Transaction();
    const cap = tx.moveCall({
      target: `${PACKAGE_ID}::strategy_registry::publish`,
      arguments: [
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(s.name))),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(s.description))),
        tx.pure.vector('u8', Array.from(codeHashOf(s.name))),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(s.source))),
        tx.pure.u8(s.riskProfile),
        tx.pure.u16(s.royaltyBps),
      ],
    });
    tx.transferObjects([cap], tx.pure.address(address));
    tx.setGasBudget(50_000_000);

    const result = await client.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      options: { showEffects: true, showObjectChanges: true, showEvents: true },
    });

    if (result.effects?.status?.status !== 'success') {
      throw new Error(`Publish failed for ${s.name}: ${JSON.stringify(result.effects?.status)}`);
    }

    // Wait for the transaction to finalize so the next tx sees fresh gas
    // object versions instead of the cached stale ones.
    await client.waitForTransaction({ digest: result.digest, timeout: 30_000 });

    const created = (result.objectChanges ?? []).filter(
      (c) => c.type === 'created' && 'objectType' in c,
    );
    const strategy = created.find(
      (c) => 'objectType' in c && c.objectType.endsWith('::strategy_registry::Strategy'),
    );
    const capObj = created.find(
      (c) => 'objectType' in c && c.objectType.endsWith('::strategy_registry::StrategistCap'),
    );
    const strategyId =
      strategy && 'objectId' in strategy ? strategy.objectId : '(unknown)';
    const capId = capObj && 'objectId' in capObj ? capObj.objectId : '(unknown)';

    console.log(`  ✓ ${s.name}`);
    console.log(`      strategy: ${strategyId}`);
    console.log(`      cap:      ${capId}`);
    console.log(`      digest:   ${result.digest}`);
    console.log(`      hash:     0x${toHex(codeHashOf(s.name))}`);
  }

  console.log('\nDone. Update web/dashboard/lib/strategy-seed.ts with these IDs if you want');
  console.log('the marketplace to highlight them as the canonical starter set.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
