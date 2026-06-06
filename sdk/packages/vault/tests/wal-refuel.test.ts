import { describe, expect, it } from 'vitest';
import {
  classifyPullOperationalFundsFailure,
  computeWalSwapAmountMist,
  estimateWalFrostForUpload,
  isInsufficientSuiGasError,
  isInsufficientWalBalanceError,
  MIN_WAL_REFUEL_SWAP_MIST,
  sessionOperatingMinMist,
  sessionWalrusOperatingMinMist,
  suiNeededBeforeWalSwap,
  swapPreservesSessionGasFloor,
  walSwapGasReserveMist,
  WAL_REFUEL_GAS_RESERVE_MIST,
  walTargetFrost,
} from '../src/runtime/wal-refuel.js';

describe('estimateWalFrostForUpload', () => {
  it('covers observed testnet noop upload cost', () => {
    const est = estimateWalFrostForUpload(2048, 5);
    expect(est).toBeGreaterThanOrEqual(1_221_129n);
  });
});

describe('computeWalSwapAmountMist', () => {
  it('swaps up to configured max when session is flush', () => {
    expect(
      computeWalSwapAmountMist({
        suiBalanceMist: 500_000_000n,
        configuredMaxMist: 50_000_000n,
      }),
    ).toBe(50_000_000n);
  });

  it('uses adaptive partial swap for ~0.055 SUI session (production gap)', () => {
    const swap = computeWalSwapAmountMist({
      suiBalanceMist: 55_280_660n,
      configuredMaxMist: 50_000_000n,
    });
    expect(swap).not.toBeNull();
    expect(swap!).toBeGreaterThanOrEqual(MIN_WAL_REFUEL_SWAP_MIST);
    expect(swap!).toBeLessThanOrEqual(55_280_660n - walSwapGasReserveMist());
  });

  it('returns null when session cannot afford min swap + walrus reserve', () => {
    expect(
      computeWalSwapAmountMist({
        suiBalanceMist: 15_000_000n,
        configuredMaxMist: 50_000_000n,
      }),
    ).toBeNull();
  });

  it('returns null when swap would breach the hard session gas floor', () => {
    expect(
      computeWalSwapAmountMist({
        suiBalanceMist: 34_000_000n,
        configuredMaxMist: 50_000_000n,
        gasReserveMist: 30_000_000n,
      }),
    ).toBeNull();
  });
});

describe('sessionOperatingMinMist', () => {
  it('requires more headroom for Walrus-enabled vaults', () => {
    expect(sessionOperatingMinMist(true)).toBe(sessionWalrusOperatingMinMist());
    expect(sessionOperatingMinMist(true)).toBeGreaterThan(sessionOperatingMinMist(false));
  });
});

describe('swapPreservesSessionGasFloor', () => {
  it('rejects swaps that would leave the session below the floor', () => {
    expect(swapPreservesSessionGasFloor(35_000_000n, 10_000_000n, 30_000_000n)).toBe(false);
    expect(swapPreservesSessionGasFloor(60_000_000n, 10_000_000n, 30_000_000n)).toBe(true);
  });
});

describe('classifyPullOperationalFundsFailure', () => {
  it('detects session gas starvation', () => {
    expect(
      classifyPullOperationalFundsFailure(
        new Error(
          'Error checking transaction input objects: Balance of gas object 2918852 is lower than the needed amount: 4074648',
        ),
      ),
    ).toBe('session-gas');
  });
});

describe('suiNeededBeforeWalSwap', () => {
  it('requires swap + gas reserve', () => {
    expect(suiNeededBeforeWalSwap(50_000_000n)).toBe(50_000_000n + WAL_REFUEL_GAS_RESERVE_MIST);
  });
});

describe('walTargetFrost', () => {
  it('targets the higher of threshold and upload estimate', () => {
    expect(
      walTargetFrost({
        walBalance: 0n,
        thresholdFrost: 10_000_000n,
        requiredFrost: 1_500_000n,
      }),
    ).toBe(10_000_000n);
  });
});

describe('isInsufficientWalBalanceError', () => {
  it('detects WAL exhaustion messages', () => {
    expect(
      isInsufficientWalBalanceError(
        new Error(
          'Insufficient balance of 0x8270…::wal::WAL for owner 0xabc. Required: 1221129, Available: 0',
        ),
      ),
    ).toBe(true);
  });
});

describe('isInsufficientSuiGasError', () => {
  it('detects gas coin too small for Walrus upload', () => {
    expect(
      isInsufficientSuiGasError(
        new Error(
          'Error checking transaction input objects: Balance of gas object 9664604 is lower than the needed amount: 9902444',
        ),
      ),
    ).toBe(true);
  });
});
