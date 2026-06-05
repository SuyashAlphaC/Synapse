#!/usr/bin/env tsx
/**
 * Bundle a strategy source file for Walrus publish + Nautilus attestation.
 *
 *   npx tsx scripts/bundle-strategy.ts path/to/strategy.ts
 *   npx tsx scripts/bundle-strategy.ts path/to/strategy.ts --mode=langgraph
 *
 * Writes `strategy.bundle.mjs` + prints sha256 for `republish-strategies.ts`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  bundleStrategyForWalrus,
  detectBundleMode,
  type StrategyBundleMode,
} from '../sdk/packages/vault/src/runtime/strategy-bundle.ts';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const modeArg = args.find((a) => a.startsWith('--mode='));
  const positional = args.filter((a) => !a.startsWith('--'));
  const sourcePath = positional[0];

  if (!sourcePath) {
    console.error('usage: bundle-strategy.ts <strategy.ts> [--mode=legacy|langgraph]');
    process.exit(1);
  }

  const absolute = resolve(sourcePath);
  const source = readFileSync(absolute, 'utf8');
  const filename = basename(absolute);
  const mode = (modeArg?.split('=')[1] as StrategyBundleMode | undefined) ?? detectBundleMode(source);

  const result = await bundleStrategyForWalrus({
    source,
    filename,
    mode,
    entryPath: mode === 'langgraph' ? absolute : undefined,
  });
  const outPath = resolve(process.cwd(), 'strategy.bundle.mjs');
  writeFileSync(outPath, result.bytes);

  console.log(JSON.stringify({
    outPath,
    mode: result.mode,
    bytes: result.bytes.byteLength,
    sha256Hex: result.sha256Hex,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
