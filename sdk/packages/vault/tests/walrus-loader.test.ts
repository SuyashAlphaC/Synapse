/**
 * Walrus strategy loader: focused tests for the hash-verify + dynamic
 * import + shape validation flow. Uses a stubbed SuiClient + a stubbed
 * `fetch` so we never touch the network.
 *
 * We exercise:
 *   - Happy path: on-chain hash matches bundle bytes → strategy loads,
 *     evaluates, and the result is cacheable.
 *   - Hash mismatch: refuses to import. Critical safety property.
 *   - Bad export shape: rejects bundles missing `evaluate`.
 *   - Factory pattern: default-exported function is called to build.
 *   - Empty `source_walrus_blob`: returns null (legacy strategies).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  clearWalrusStrategyCache,
  loadStrategyFromWalrus,
  WalrusStrategyError,
} from '../src/runtime/walrus-loader.js';

const PACKAGE_ID = '0x70db8ce760ac41322284f1fab73016438639e4f5ab5ae2ad6f5362cb3f50ec16';
const STRATEGY_ID = '0xcafe000000000000000000000000000000000000000000000000000000000001';
const BLOB_ID = 'walrus-test-blob-id';

function utf8Bytes(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

function sha256Bytes(s: string): number[] {
  return Array.from(createHash('sha256').update(s).digest());
}

function makeStubClient(args: {
  bundleSource: string;
  blobId?: string;
  hashOverride?: number[];
}): { client: { getObject: ReturnType<typeof vi.fn> } } {
  const blobId = args.blobId ?? BLOB_ID;
  const hash = args.hashOverride ?? sha256Bytes(args.bundleSource);
  return {
    client: {
      getObject: vi.fn(async () => ({
        data: {
          content: {
            dataType: 'moveObject',
            type: `${PACKAGE_ID}::strategy_registry::Strategy`,
            fields: {
              source_walrus_blob: utf8Bytes(blobId),
              code_hash: hash,
            },
          },
        },
      })),
    },
  };
}

function mockWalrusFetch(bundleSource: string): void {
  const bytes = new TextEncoder().encode(bundleSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    })),
  );
}

const VALID_STRATEGY_SOURCE = `
const strategy = {
  id: 'walrus-test-strategy',
  name: 'Walrus Test',
  version: '1.0.0',
  description: 'Test strategy loaded from a fake Walrus blob.',
  evaluate: async (input) => ({ kind: 'noop', rationale: 'unit-test no-op' }),
};
export default strategy;
`;

const FACTORY_STRATEGY_SOURCE = `
export default function makeStrategy() {
  return {
    id: 'walrus-factory-strategy',
    name: 'Walrus Factory',
    version: '2.0.0',
    description: 'Factory-pattern strategy.',
    evaluate: async () => ({ kind: 'noop', rationale: 'factory' }),
  };
}
`;

const MISSING_EVALUATE_SOURCE = `
export default { id: 'broken', name: 'Broken', version: '1.0.0', description: 'No evaluate fn.' };
`;

describe('loadStrategyFromWalrus', () => {
  beforeEach(() => {
    clearWalrusStrategyCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads, hash-verifies, imports, and returns a runnable Strategy', async () => {
    const { client } = makeStubClient({ bundleSource: VALID_STRATEGY_SOURCE });
    mockWalrusFetch(VALID_STRATEGY_SOURCE);

    const loaded = await loadStrategyFromWalrus({
      // Cast: stub satisfies the narrow interface we actually use.
      client: client as unknown as Parameters<typeof loadStrategyFromWalrus>[0]['client'],
      packageId: PACKAGE_ID,
      strategyId: STRATEGY_ID,
      network: 'testnet',
    });

    expect(loaded).not.toBeNull();
    expect(loaded!.strategy.id).toBe('walrus-test-strategy');
    expect(loaded!.strategy.name).toBe('Walrus Test');
    expect(loaded!.sourceWalrusBlob).toBe(BLOB_ID);
    expect(loaded!.byteSize).toBeGreaterThan(0);
    expect(loaded!.codeHashHex).toMatch(/^[0-9a-f]{64}$/);

    // Smoke: the loaded evaluate runs.
    const decision = await loaded!.strategy.evaluate({
      vaultId: '0x0',
      holdings: [],
      navUsd: 0,
      market: { prices: {}, pools: [], asOf: new Date(0).toISOString() },
      memory: { recentDecisions: [], counters: {}, facts: [] },
      currentEpoch: 1n,
      policy: { spendPerEpochUsd: 0, approvedPackages: [], expiryEpoch: 100n, revoked: false },
    });
    expect(decision.kind).toBe('noop');
  });

  it('refuses to execute when on-chain code_hash does not match bundle bytes', async () => {
    const TAMPERED_HASH = new Uint8Array(32).fill(0xab);
    const { client } = makeStubClient({
      bundleSource: VALID_STRATEGY_SOURCE,
      hashOverride: Array.from(TAMPERED_HASH),
    });
    mockWalrusFetch(VALID_STRATEGY_SOURCE);

    await expect(
      loadStrategyFromWalrus({
        client: client as unknown as Parameters<typeof loadStrategyFromWalrus>[0]['client'],
        packageId: PACKAGE_ID,
        strategyId: STRATEGY_ID,
        network: 'testnet',
      }),
    ).rejects.toThrow(WalrusStrategyError);
  });

  it('rejects bundles whose default export is missing `evaluate`', async () => {
    const { client } = makeStubClient({ bundleSource: MISSING_EVALUATE_SOURCE });
    mockWalrusFetch(MISSING_EVALUATE_SOURCE);

    await expect(
      loadStrategyFromWalrus({
        client: client as unknown as Parameters<typeof loadStrategyFromWalrus>[0]['client'],
        packageId: PACKAGE_ID,
        strategyId: STRATEGY_ID,
        network: 'testnet',
      }),
    ).rejects.toThrow(/missing async `evaluate`/);
  });

  it('supports the factory pattern (default export is a function)', async () => {
    const { client } = makeStubClient({ bundleSource: FACTORY_STRATEGY_SOURCE });
    mockWalrusFetch(FACTORY_STRATEGY_SOURCE);

    const loaded = await loadStrategyFromWalrus({
      client: client as unknown as Parameters<typeof loadStrategyFromWalrus>[0]['client'],
      packageId: PACKAGE_ID,
      strategyId: STRATEGY_ID,
      network: 'testnet',
    });
    expect(loaded!.strategy.id).toBe('walrus-factory-strategy');
    expect(loaded!.strategy.version).toBe('2.0.0');
  });

  it('returns null when the on-chain Strategy has no source_walrus_blob (legacy)', async () => {
    const { client } = makeStubClient({ bundleSource: VALID_STRATEGY_SOURCE, blobId: '' });

    const loaded = await loadStrategyFromWalrus({
      client: client as unknown as Parameters<typeof loadStrategyFromWalrus>[0]['client'],
      packageId: PACKAGE_ID,
      strategyId: STRATEGY_ID,
      network: 'testnet',
    });
    expect(loaded).toBeNull();
  });

  it('caches by code_hash so repeat loads skip Walrus fetch', async () => {
    const { client } = makeStubClient({ bundleSource: VALID_STRATEGY_SOURCE });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => new TextEncoder().encode(VALID_STRATEGY_SOURCE).buffer,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await loadStrategyFromWalrus({
      client: client as unknown as Parameters<typeof loadStrategyFromWalrus>[0]['client'],
      packageId: PACKAGE_ID,
      strategyId: STRATEGY_ID,
      network: 'testnet',
    });
    const second = await loadStrategyFromWalrus({
      client: client as unknown as Parameters<typeof loadStrategyFromWalrus>[0]['client'],
      packageId: PACKAGE_ID,
      strategyId: STRATEGY_ID,
      network: 'testnet',
    });

    expect(first?.codeHashHex).toBe(second?.codeHashHex);
    // getObject is still called twice (cheap RPC; we always want a fresh
    // hash) but fetch should only fire on the first miss.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
