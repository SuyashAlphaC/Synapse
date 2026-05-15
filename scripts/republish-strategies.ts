#!/usr/bin/env tsx
/**
 * Bundle each shipped strategy's TypeScript source into a deterministic
 * JSON manifest, upload it to Walrus testnet, compute sha256(manifest) as the
 * canonical `code_hash`, and republish each on-chain `Strategy` with those
 * real values via `strategy_registry::publish_new_version`.
 *
 * After this script runs, the three seeded strategies stop being placeholder
 * descriptions and become real on-chain commitments to deployable code that
 * any auditor can fetch + verify.
 *
 * Requires:
 *   - Local Sui keystore at ~/.sui/sui_config/sui.keystore matching the
 *     wallet that owns the StrategistCaps + Strategy objects.
 *   - Funded testnet SUI for: WAL conversion (Walrus storage cost) + gas
 *     for the publish_new_version PTBs.
 *
 *   PACKAGE_ID=0x7b3f5… npx tsx scripts/republish-strategies.ts
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { fromBase64, toHex } from '@mysten/sui/utils';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import { type Keypair } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const PACKAGE_ID =
  process.env['PACKAGE_ID'] ??
  '0x7b3f59e42edbf2189df644e63162d0b9a2c2984755bab9d3e9557c4ddd4aa67c';

const NETWORK: 'testnet' | 'mainnet' =
  (process.env['SYNAPSE_NETWORK'] as 'testnet' | 'mainnet') ?? 'testnet';

const WALRUS_EPOCHS = Number(process.env['WALRUS_EPOCHS'] ?? '5');

const WALRUS_PUBLISHER =
  process.env['WALRUS_PUBLISHER_URL'] ?? 'https://publisher.walrus-testnet.walrus.space';

/**
 * Upload bytes via the public Walrus HTTP publisher. Returns the canonical
 * blob ID. No WAL conversion required — the public testnet publisher eats
 * the storage cost for small blobs.
 */
async function uploadViaPublisher(
  bytes: Uint8Array,
  epochs: number,
): Promise<{ blobId: string; blobObjectId: string }> {
  const url = `${WALRUS_PUBLISHER}/v1/blobs?epochs=${epochs}`;
  const response = await fetch(url, {
    method: 'PUT',
    body: bytes,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Walrus publisher ${response.status}: ${text.slice(0, 200)}`);
  }
  const result = (await response.json()) as unknown;
  // Publisher returns either `newlyCreated` or `alreadyCertified` envelope.
  const env = result as {
    newlyCreated?: {
      blobObject: { id: string; blobId: string };
    };
    alreadyCertified?: { blobId: string; eventOrObject?: unknown };
  };
  if (env.newlyCreated) {
    return {
      blobId: env.newlyCreated.blobObject.blobId,
      blobObjectId: env.newlyCreated.blobObject.id,
    };
  }
  if (env.alreadyCertified) {
    return { blobId: env.alreadyCertified.blobId, blobObjectId: '(pre-existing)' };
  }
  throw new Error(`Unrecognized publisher response: ${JSON.stringify(result).slice(0, 200)}`);
}

/**
 * (strategy_id, cap_id, source files relative to repo root, manifest meta)
 * tuples for each strategy seeded on testnet. Cap IDs come from
 * scripts/seed-strategies.ts output.
 */
const STRATEGIES = [
  {
    name: 'Synapse Conservative Rebalancer',
    strategyId: '0x46996c0f9e692968f55a63c3cbc33eb8d19145c123b7a867a02da342e617d3ec',
    capId: '0xbd2a46a5e6d18598f5cdbff4002c1229eea048bce35cd54328e779f970eaaca6',
    sources: [
      'sdk/packages/vault/src/strategies/conservative-rebalancer.ts',
      'sdk/packages/vault/src/types.ts',
      'sdk/packages/vault/src/executor.ts',
    ],
    manifest: {
      slug: 'conservative-rebalancer',
      version: '1.0.0',
      summary:
        'Deterministic 50/50 SUI/USDC rebalancer with 5% drift threshold. ' +
        'Targets benchmark + 50bps with minimal drawdown.',
      entry: 'sdk/packages/vault/src/strategies/conservative-rebalancer.ts',
    },
  },
  {
    name: 'Synapse Balanced Yield',
    strategyId: '0x44c0f7c4f6e04024c9bb1c0ce1eb1965018675cd074e7a410a59c2d43887c679',
    capId: '0x37900489b3f11d2d69f7d295931da4f105f503c8ac8229cd1c1656ef7b8ee39e',
    sources: [
      'sdk/packages/vault/src/strategies/balanced-yield.ts',
      'sdk/packages/vault/src/types.ts',
      'sdk/packages/vault/src/executor.ts',
    ],
    manifest: {
      slug: 'balanced-yield',
      version: '1.0.0',
      summary:
        'Volatility-gated SUI/USDC rebalancer (60/40 base/quote target). ' +
        'Drift threshold scales 2%–8% with realized volatility regime.',
      entry: 'sdk/packages/vault/src/strategies/balanced-yield.ts',
    },
  },
  {
    name: 'Synapse Aggressive Momentum',
    strategyId: '0xa1d73e17bc4c53484a3254c5ed3c0b24e340524d0014703c072f91d60f02d4a1',
    capId: '0x33748b686ad45d109442369aba5e933df28f3ca8becc25822e3637833e7755c7',
    sources: [
      'sdk/packages/vault/src/strategies/aggressive-momentum.ts',
      'sdk/packages/vault/src/types.ts',
      'sdk/packages/vault/src/executor.ts',
    ],
    manifest: {
      slug: 'aggressive-momentum',
      version: '1.0.0',
      summary:
        'Pyth-confidence-gated trend follower on SUI. Enters on ≥2% momentum, ' +
        'exits on ≤-1% reversal, refuses oracle conf > 75bps.',
      entry: 'sdk/packages/vault/src/strategies/aggressive-momentum.ts',
    },
  },
] as const;

interface BundleManifest {
  slug: string;
  version: string;
  summary: string;
  entry: string;
  generatedAt: string;
  files: Record<string, string>;
}

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

function buildManifest(strategy: (typeof STRATEGIES)[number]): {
  manifest: BundleManifest;
  canonicalBytes: Uint8Array;
  sha256: Uint8Array;
} {
  const files: Record<string, string> = {};
  for (const sourceRel of strategy.sources) {
    const absolute = join(REPO_ROOT, sourceRel);
    const content = readFileSync(absolute, 'utf8');
    const canonicalPath = relative(REPO_ROOT, absolute).replace(/\\/g, '/');
    files[canonicalPath] = content;
  }
  const manifest: BundleManifest = {
    slug: strategy.manifest.slug,
    version: strategy.manifest.version,
    summary: strategy.manifest.summary,
    entry: strategy.manifest.entry,
    generatedAt: new Date().toISOString().slice(0, 10),
    files,
  };
  // Canonical bytes = JSON with sorted keys top-level + sorted files keys.
  const canonical = JSON.stringify(
    {
      slug: manifest.slug,
      version: manifest.version,
      summary: manifest.summary,
      entry: manifest.entry,
      generatedAt: manifest.generatedAt,
      files: Object.fromEntries(
        Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)),
      ),
    },
    null,
    2,
  );
  const bytes = new TextEncoder().encode(canonical);
  const digest = new Uint8Array(createHash('sha256').update(bytes).digest());
  return { manifest, canonicalBytes: bytes, sha256: digest };
}

async function main(): Promise<void> {
  const keypair = loadKeypair();
  const sender = keypair.toSuiAddress();
  console.log(`Republishing ${STRATEGIES.length} strategies from ${sender} on ${NETWORK}`);

  const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl(NETWORK) });

  for (const strategy of STRATEGIES) {
    console.log(`\n→ ${strategy.name}`);

    const { canonicalBytes, sha256 } = buildManifest(strategy);
    console.log(`    bundle ${canonicalBytes.byteLength} bytes`);
    console.log(`    sha256 0x${toHex(sha256)}`);

    console.log(`    uploading to Walrus via ${WALRUS_PUBLISHER}…`);
    const upload = await uploadViaPublisher(canonicalBytes, WALRUS_EPOCHS);
    console.log(`    blobId ${upload.blobId}`);
    console.log(`    blobObjectId ${upload.blobObjectId}`);

    const tx = new Transaction();
    tx.moveCall({
      target: `${PACKAGE_ID}::strategy_registry::publish_new_version`,
      arguments: [
        tx.object(strategy.strategyId),
        tx.object(strategy.capId),
        tx.pure.vector('u8', Array.from(sha256)),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode(upload.blobId))),
      ],
    });
    tx.setGasBudget(50_000_000);

    const result = await client.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      options: { showEffects: true, showEvents: true },
    });
    if (result.effects?.status?.status !== 'success') {
      throw new Error(`publish_new_version failed: ${JSON.stringify(result.effects?.status)}`);
    }
    await client.waitForTransaction({ digest: result.digest, timeout: 30_000 });
    console.log(`    publish_new_version digest ${result.digest}`);
  }

  console.log('\nDone. Strategy code_hash + source_walrus_blob are now real on-chain commitments.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
