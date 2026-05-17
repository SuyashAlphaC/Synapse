/**
 * Real VaultRuntime.tickOnce() coverage. Mocks the sibling modules' Sui /
 * Walrus / MemWal calls via `vi.mock` and injects a fake `SuiJsonRpcClient`
 * via the constructor's `deps` override so the runtime's wiring (decision
 * → publish → submit → record → memorize) runs for real.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import { ActionKind, publishArtifactCall, target } from '@synapse-core/client';
import { buildRebalancePTB } from '../src/executor.js';
import type {
  AuditReport,
  HoldingSnapshot,
  MarketSnapshot,
  PlannedTrade,
  RebalancePlan,
  Strategy,
} from '../src/types.js';
import {
  DEEPBOOK_PACKAGE_ID_TESTNET,
  SUI_TYPE_TAG_TESTNET,
  SUI_USDC_POOL_ID_TESTNET,
  USDC_TYPE_TAG_TESTNET,
  deepbookSwap,
} from '../src/runtime/deepbook.js';
import { VaultRuntime } from '../src/runtime/runtime.js';
import type { OnChainAgentState } from '../src/runtime/state.js';

const PACKAGE_ID = '0x70db8ce760ac41322284f1fab73016438639e4f5ab5ae2ad6f5362cb3f50ec16';
const AGENT_ID = '0xa758924d6ac5db6680ae7a32011f759af3d991fbc58e0c5c8637680ff824138f';

// ---------------------------------------------------------------------------
// Module-level mocks. These intercept every network-touching helper so the
// runtime exercises its real branching, control flow, and PTB construction
// without leaving the test process.
// ---------------------------------------------------------------------------

vi.mock('../src/runtime/state.js', () => ({
  loadAgentState: vi.fn(),
}));
vi.mock('../src/runtime/market.js', () => ({
  loadMarketSnapshot: vi.fn(),
  requiredPoolsForStrategy: vi.fn(() => [SUI_USDC_POOL_ID_TESTNET]),
}));
vi.mock('../src/runtime/memory.js', () => ({
  createRuntimeMemWalClient: vi.fn(() => null),
  emptyStrategyMemory: vi.fn(() => ({ recentDecisions: [], counters: {}, facts: [] })),
  namespaceFromIdentity: vi.fn(() => 'test-namespace'),
  recallStrategyMemory: vi.fn(),
  rememberStrategyOutcome: vi.fn(async () => undefined),
}));
vi.mock('../src/runtime/publisher.js', () => ({
  uploadReportBlob: vi.fn(),
  parseArtifactSlot: vi.fn(() => 7n),
}));
vi.mock('../src/runtime/keypair.js', () => ({
  loadSessionKeypair: vi.fn(),
}));

import { loadAgentState } from '../src/runtime/state.js';
import { loadMarketSnapshot } from '../src/runtime/market.js';
import {
  createRuntimeMemWalClient,
  rememberStrategyOutcome,
} from '../src/runtime/memory.js';
import { uploadReportBlob } from '../src/runtime/publisher.js';
import { loadSessionKeypair } from '../src/runtime/keypair.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeHoldings(): HoldingSnapshot[] {
  return [
    {
      coinTypeTag: SUI_TYPE_TAG_TESTNET,
      symbol: 'SUI',
      amount: 1_000_000_000n,
      decimals: 9,
      priceUsd: 0,
      valueUsd: 0,
    },
    {
      coinTypeTag: USDC_TYPE_TAG_TESTNET,
      symbol: 'DBUSDC',
      amount: 1_000_000n,
      decimals: 6,
      priceUsd: 0,
      valueUsd: 0,
    },
  ];
}

function makeOnChainState(): OnChainAgentState {
  const holdings = makeHoldings();
  return {
    identity: {
      id: AGENT_ID,
      owner: '0xa11ce',
      sessionAddr: '0xbeef',
      expiryEpoch: 100n,
      spendPerEpoch: 1_000_000_000n,
      spentThisEpoch: 0n,
      lastEpochSeen: 0n,
      approvedPackages: [DEEPBOOK_PACKAGE_ID_TESTNET],
      memwalAccountId: new TextEncoder().encode('mw-acct'),
      memwalDelegateKeyId: new TextEncoder().encode('mw-delegate'),
      memwalNamespace: new TextEncoder().encode('ns'),
      nextArtifactId: 0n,
      artifactCount: 0n,
      messagingInbox: null,
      messagingOutbox: null,
      revoked: false,
      // Bogus strategy id — keeps the runtime's strategy resolver from
      // overriding the test's injected mock strategy with a real one.
      strategyId: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    },
    policy: {
      spendPerEpochUsd: 0,
      approvedPackages: [DEEPBOOK_PACKAGE_ID_TESTNET],
      expiryEpoch: 100n,
      revoked: false,
    },
    balances: holdings.map((h) => ({
      coinTypeTag: h.coinTypeTag,
      symbol: h.symbol,
      amount: h.amount,
      decimals: h.decimals,
    })),
    holdings,
    // Default off — matches a freshly-minted vault that hasn't opted in.
    acceptsWalrusExecution: false,
  };
}

function makeMarket(): MarketSnapshot {
  return {
    prices: { SUI: 1.5, DBUSDC: 1 },
    pools: [
      {
        poolId: SUI_USDC_POOL_ID_TESTNET,
        baseTypeTag: SUI_TYPE_TAG_TESTNET,
        quoteTypeTag: USDC_TYPE_TAG_TESTNET,
        bestBid: 1.499,
        bestAsk: 1.501,
        mid: 1.5,
        volume24h: 0,
      },
    ],
    asOf: '2026-05-13T00:00:00.000Z',
  };
}

function makeNoopStrategy(): Strategy {
  return {
    id: 'noop-strategy',
    name: 'Noop Strategy',
    version: '1.0.0',
    description: 'Always returns noop.',
    evaluate: async () => ({ kind: 'noop', rationale: 'test noop' }),
  };
}

function makeRebalanceStrategy(trade: PlannedTrade, planId: string): Strategy {
  const plan: RebalancePlan = {
    kind: 'rebalance',
    planId,
    summary: 'test rebalance',
    rationaleMarkdown: 'fixed rationale',
    signals: {},
    trades: [trade],
  };
  return {
    id: 'fixed-rebalance',
    name: 'Fixed Rebalance',
    version: '1.0.0',
    description: 'Always returns a fixed rebalance plan.',
    evaluate: async () => plan,
  };
}

// ---------------------------------------------------------------------------
// Fake SuiClient — captures the PTBs the runtime submits.
// ---------------------------------------------------------------------------

interface CapturedSubmission {
  transaction: Transaction;
  digest: string;
}

function makeFakeClient() {
  const captured: CapturedSubmission[] = [];
  const fake = {
    getLatestSuiSystemState: vi.fn(async () => ({ epoch: '10' })),
    signAndExecuteTransaction: vi.fn(async (args: { transaction: Transaction }) => {
      const digest = `0xfake${captured.length}`;
      captured.push({ transaction: args.transaction, digest });
      return {
        digest,
        events: [
          {
            type: `${PACKAGE_ID}::deepbook_adapter::SwapEvent`,
            parsedJson: { output_amount: '999' },
          },
        ],
      };
    }),
    waitForTransaction: vi.fn(async () => undefined),
  };
  return { fake, captured };
}

function moveCallTargets(tx: Transaction): string[] {
  return tx
    .getData()
    .commands.flatMap((c) =>
      c.$kind === 'MoveCall'
        ? [`${c.MoveCall.package}::${c.MoveCall.module}::${c.MoveCall.function}`]
        : [],
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VaultRuntime.tickOnce', () => {
  const silentLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as ConstructorParameters<typeof VaultRuntime>[1] extends infer T
    ? T extends { logger?: infer L }
      ? L
      : never
    : never;

  beforeEach(() => {
    vi.clearAllMocks();
    (loadAgentState as Mock).mockResolvedValue(makeOnChainState());
    (loadMarketSnapshot as Mock).mockResolvedValue(makeMarket());
    (loadSessionKeypair as Mock).mockResolvedValue(new Ed25519Keypair());
    (uploadReportBlob as Mock).mockResolvedValue({
      blobId: 'walrus-blob-id',
      sha256: sha256(new TextEncoder().encode('payload')),
      sizeBytes: 7,
      blobObjectId: '0xblob',
      registeredEpoch: 10,
    });
    (createRuntimeMemWalClient as Mock).mockReturnValue(null);
  });

  it('noop path: publishes audit artifact + action log, returns receipt', async () => {
    const { fake, captured } = makeFakeClient();
    const runtime = new VaultRuntime(makeConfig(makeNoopStrategy()), {
      client: fake as unknown as NonNullable<
        ConstructorParameters<typeof VaultRuntime>[1]
      >['client'],
      logger: silentLogger,
    });

    const receipt = await runtime.tickOnce();
    expect(receipt).not.toBeNull();
    expect(receipt!.trades).toHaveLength(0);
    expect(receipt!.txDigest).toMatch(/^0xfake/);
    expect(receipt!.reportWalrusBlobId).toBe('walrus-blob-id');
    expect(receipt!.artifactSlot).toBe(7n);

    expect(fake.signAndExecuteTransaction).toHaveBeenCalledTimes(1);
    expect(fake.waitForTransaction).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(1);
    const targets = moveCallTargets(captured[0]!.transaction);
    expect(targets).toContain(`${PACKAGE_ID}::artifacts::publish`);
    expect(targets).toContain(`${PACKAGE_ID}::attestation::log_action`);

    // Runtime always invokes rememberStrategyOutcome (fires on noop + rebalance
    // so stateful strategies advance every tick). The function itself no-ops
    // internally when memwal is null, so we assert the call shape, not absence.
    expect(vi.mocked(rememberStrategyOutcome)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(rememberStrategyOutcome).mock.calls[0]![0];
    expect(call.memwal).toBeNull();
    expect(call.decision.kind).toBe('noop');
    expect(call.memoryWrite).toBeNull();
  });

  it('rebalance path: composes Synapse-gated DeepBookV3 swap, remembers outcome', async () => {
    const { fake, captured } = makeFakeClient();
    (createRuntimeMemWalClient as Mock).mockReturnValue({ tag: 'mock-memwal' });

    const trade: PlannedTrade = {
      poolId: SUI_USDC_POOL_ID_TESTNET,
      fromTypeTag: SUI_TYPE_TAG_TESTNET,
      toTypeTag: USDC_TYPE_TAG_TESTNET,
      amountIn: 1_000_000n,
      minAmountOut: 1n,
      direction: 0,
    };
    const runtime = new VaultRuntime(
      makeConfig(makeRebalanceStrategy(trade, 'plan-runtime-test')),
      {
        client: fake as unknown as NonNullable<
          ConstructorParameters<typeof VaultRuntime>[1]
        >['client'],
        logger: silentLogger,
      },
    );

    const receipt = await runtime.tickOnce();
    expect(receipt).not.toBeNull();
    expect(receipt!.planId).toBe('plan-runtime-test');
    expect(receipt!.trades).toHaveLength(1);
    expect(receipt!.trades[0]!.amountOut).toBe(999n); // parsed from fake SwapEvent
    expect(receipt!.trades[0]!.executionPrice).toBeCloseTo(0.000999);

    // The submitted PTB should contain every Synapse policy gate, the real
    // DeepBookV3 swap call, the remainder deposit (no destroy_zero on base),
    // and the artifact publish + log_action wrap.
    const targets = moveCallTargets(captured[0]!.transaction);
    expect(targets).toContain(`${PACKAGE_ID}::deepbook_adapter::authorize_swap`);
    expect(targets).toContain(`${PACKAGE_ID}::wallet::spend`);
    expect(targets).toContain(`${DEEPBOOK_PACKAGE_ID_TESTNET}::pool::swap_exact_base_for_quote`);
    expect(targets).toContain(`${PACKAGE_ID}::wallet::deposit`);
    expect(targets).toContain(`${PACKAGE_ID}::deepbook_adapter::record_swap`);
    expect(targets).toContain(`${PACKAGE_ID}::artifacts::publish`);
    expect(targets).toContain(`${PACKAGE_ID}::attestation::log_action`);

    // Critically: no destroy_zero on the base remainder (only the DEEP coin).
    const destroyZeroCount = targets.filter((t) => t === '0x0000000000000000000000000000000000000000000000000000000000000002::coin::destroy_zero').length;
    expect(destroyZeroCount).toBe(1);

    // Outcome was recorded into MemWal.
    expect(vi.mocked(rememberStrategyOutcome)).toHaveBeenCalledTimes(1);
  });

  it('skips work when the agent is revoked', async () => {
    const state = makeOnChainState();
    state.identity.revoked = true;
    (loadAgentState as Mock).mockResolvedValue(state);

    const { fake } = makeFakeClient();
    const runtime = new VaultRuntime(makeConfig(makeNoopStrategy()), {
      client: fake as unknown as NonNullable<
        ConstructorParameters<typeof VaultRuntime>[1]
      >['client'],
      logger: silentLogger,
    });
    const receipt = await runtime.tickOnce();
    expect(receipt).toBeNull();
    expect(fake.signAndExecuteTransaction).not.toHaveBeenCalled();
  });

  it('skips work when the agent has expired', async () => {
    const state = makeOnChainState();
    state.identity.expiryEpoch = 5n; // current epoch is 10 in the fake client
    (loadAgentState as Mock).mockResolvedValue(state);

    const { fake } = makeFakeClient();
    const runtime = new VaultRuntime(makeConfig(makeNoopStrategy()), {
      client: fake as unknown as NonNullable<
        ConstructorParameters<typeof VaultRuntime>[1]
      >['client'],
      logger: silentLogger,
    });
    const receipt = await runtime.tickOnce();
    expect(receipt).toBeNull();
    expect(fake.signAndExecuteTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Static PTB tests validate the executor + DeepBook adapter shape
// independently of the runtime wiring above.
// ---------------------------------------------------------------------------

describe('vault PTB construction (static)', () => {
  it('constructs the noop artifact publish + action log PTB', () => {
    const report = makeReport('noop-fixed');
    const tx = new Transaction();
    publishArtifactCall(tx, PACKAGE_ID, {
      agentId: AGENT_ID,
      walrusBlobId: new TextEncoder().encode('walrus-noop-blob'),
      sha256: report.sha256,
      mimeType: 'text/markdown',
      sizeBytes: BigInt(report.markdown.length),
      sealEncrypted: false,
      label: `audit-${report.planId}`,
    });
    tx.moveCall({
      target: target(PACKAGE_ID, 'attestation', 'log_action'),
      arguments: [
        tx.object(AGENT_ID),
        tx.pure.u8(ActionKind.ArtifactPublish),
        tx.pure.string(`noop ${report.planId}`),
        tx.pure.vector('u8', Array.from(report.sha256)),
      ],
    });

    expect(moveCallTargets(tx)).toEqual([
      `${PACKAGE_ID}::artifacts::publish`,
      `${PACKAGE_ID}::attestation::log_action`,
    ]);
  });

  it('constructs the rebalance PTB with Synapse gates, DeepBook swap, deposit, artifact, and log', () => {
    const report = makeReport('plan-fixed');
    const plan: RebalancePlan = {
      kind: 'rebalance',
      planId: 'plan-fixed',
      summary: 'sell SUI for DBUSDC',
      rationaleMarkdown: 'deterministic test rationale',
      signals: { drift: 0.12 },
      trades: [
        {
          poolId: SUI_USDC_POOL_ID_TESTNET,
          fromTypeTag: SUI_TYPE_TAG_TESTNET,
          toTypeTag: USDC_TYPE_TAG_TESTNET,
          amountIn: 1_000_000n,
          minAmountOut: 1n,
          direction: 0,
        },
      ],
    };
    const tx = new Transaction();
    buildRebalancePTB({
      tx,
      synapsePackageId: PACKAGE_ID,
      vaultId: AGENT_ID,
      plan,
      report,
      reportWalrusBlobId: 'walrus-rebalance-blob',
      deepbookPkg: DEEPBOOK_PACKAGE_ID_TESTNET,
      swap: deepbookSwap,
    });

    const targets = moveCallTargets(tx);
    expect(targets).toContain(`${PACKAGE_ID}::deepbook_adapter::authorize_swap`);
    expect(targets).toContain(`${PACKAGE_ID}::wallet::spend`);
    expect(targets).toContain(`${DEEPBOOK_PACKAGE_ID_TESTNET}::pool::swap_exact_base_for_quote`);
    expect(targets).toContain(`${PACKAGE_ID}::wallet::deposit`);
    expect(targets).toContain(`${PACKAGE_ID}::deepbook_adapter::record_swap`);
    expect(targets).toContain(`${PACKAGE_ID}::artifacts::publish`);
    expect(targets).toContain(`${PACKAGE_ID}::attestation::log_action`);
    // Two wallet::deposit calls: one for the swap output, one for the base
    // remainder. Confirms the destroy_zero fix is in place.
    const depositCount = targets.filter((t) => t === `${PACKAGE_ID}::wallet::deposit`).length;
    expect(depositCount).toBe(2);
    // Only one destroy_zero (DEEP fee coin), proving we no longer torch the base remainder.
    const destroyZeroCount = targets.filter((t) => t === '0x0000000000000000000000000000000000000000000000000000000000000002::coin::destroy_zero').length;
    expect(destroyZeroCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReport(planId: string): AuditReport {
  const markdown = `# ${planId}`;
  return {
    planId,
    vaultId: AGENT_ID,
    strategyId: 'test-strategy',
    renderedAt: '2026-05-13T00:00:00.000Z',
    epoch: 1n,
    markdown,
    sha256: sha256(new TextEncoder().encode(markdown)),
  };
}

function makeConfig(strategy: Strategy) {
  return {
    packageId: PACKAGE_ID,
    packageHistory: [PACKAGE_ID],
    agentId: AGENT_ID,
    fullnodeUrl: 'https://fullnode.testnet.sui.io:443',
    walrusNetwork: 'testnet' as const,
    sessionKeyPath: '/tmp/test-session-key',
    strategy,
    tickIntervalMs: 1_000,
    maxConsecutiveFailures: 1,
    walrusEpochs: 5,
  };
}
