import { describe, expect, it, vi } from 'vitest';

import {
  XATTR_SEEN_PREFIX,
  mergeTickMemoryWrite,
  parseCrossAgentSeenMarkers,
} from '../src/runtime/cross-agent.js';

describe('parseCrossAgentSeenMarkers', () => {
  it('collects blob ids from xattr:seen facts', () => {
    const seen = parseCrossAgentSeenMarkers([
      'pcy:px:1,2,3',
      `${XATTR_SEEN_PREFIX}abc123`,
      `${XATTR_SEEN_PREFIX}def456`,
    ]);
    expect(seen.has('abc123')).toBe(true);
    expect(seen.has('def456')).toBe(true);
    expect(seen.size).toBe(2);
  });
});

describe('peer-coordinated-yield peer parsing', () => {
  it('detects de-risk and yield votes from peer + xattr facts', async () => {
    const mod = await import('../../../../examples/publish/peer-coordinated-yield.strategy.ts');
    const strategy = mod.default;

    const warmFacts = [`pcy:px:${Array.from({ length: 10 }, (_, i) => (2 + i * 0.01).toFixed(4)).join(',')}`, 'pcy:peak:2.5000'];

    const deRisk = await strategy.evaluate({
      vaultId: '0xabc',
      holdings: [
        {
          coinTypeTag:
            '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
          symbol: 'SUI',
          amount: 10_000_000_000n,
          decimals: 9,
          priceUsd: 2.5,
          valueUsd: 25,
        },
        {
          coinTypeTag:
            '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC',
          symbol: 'DBUSDC',
          amount: 5_000_000n,
          decimals: 6,
          priceUsd: 1,
          valueUsd: 5,
        },
      ],
      navUsd: 30,
      market: { prices: { SUI: 2.5, DBUSDC: 1 }, pools: [] },
      memory: {
        recentDecisions: [],
        counters: {},
        facts: [
          ...warmFacts,
          'peer 0xdeadbeef: signal @99: Momentum yield: trim base (de-risk)',
          'peer 0xfeedface: signal @99: hold — noop risk-off freeze',
          'xattr:0xpeer1:blob1: {"kind":"noop","rationale":"hold"}',
        ],
      },
      currentEpoch: 100n,
      policy: {
        revoked: false,
        expiryEpoch: 999n,
        spendPerEpochUsd: 100,
        approvedPackages: [],
      },
    });

    expect(deRisk.signals?.peerDeRiskVotes).toBeGreaterThanOrEqual(2);
    expect(deRisk.signals?.peerForceMinBase).toBe(true);
    expect(deRisk.signals?.targetBaseWeight).toBe(0.32);
  });
});

describe('mergeTickMemoryWrite', () => {
  it('merges msg cursor and extra facts', () => {
    const merged = mergeTickMemoryWrite({
      strategyWrite: { counters: { pcyTicks: 3 }, facts: ['pcy:px:1'] },
      msgCursor: 42n,
      extraFacts: [`${XATTR_SEEN_PREFIX}blob-a`],
    });
    expect(merged?.counters.msgCursor).toBe(42);
    expect(merged?.facts).toEqual(['pcy:px:1', `${XATTR_SEEN_PREFIX}blob-a`]);
  });
});
