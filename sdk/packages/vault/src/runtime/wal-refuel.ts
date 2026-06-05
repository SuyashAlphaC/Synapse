/**
 * Auto WAL refuel helpers — keep the session funded for Walrus uploads even
 * when the session holds enough SUI for tick gas but not for a full 0.5 SUI
 * SUI→WAL swap.
 */

/** Walrus WAL coin type (testnet + mainnet). */
export const WAL_COIN_TYPE =
  '0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL';

/** Refuel when WAL drops below this (0.01 WAL). */
export const DEFAULT_WAL_REFUEL_THRESHOLD_FROST = 10_000_000n;

/** Max SUI MIST to swap per refuel attempt (0.05 SUI — fits ~0.055 SUI sessions). */
export const DEFAULT_WAL_REFUEL_AMOUNT_MIST = 50_000_000n;

/** Minimum SUI swap size (0.005 SUI). */
export const MIN_WAL_REFUEL_SWAP_MIST = 5_000_000n;

/** Leave this much SUI on the session after a WAL swap for gas (tick PTB + Walrus publish). */
export const WAL_REFUEL_GAS_RESERVE_MIST = 20_000_000n;

/** Minimum session SUI before attempting a Walrus upload PTB (~10M observed + margin). */
export const WALRUS_UPLOAD_MIN_SUI_MIST = 20_000_000n;

/** Safety margin on top of per-upload estimate (0.002 WAL). */
export const WAL_UPLOAD_SAFETY_FROST = 2_000_000n;

/**
 * Conservative WAL cost estimate for one audit blob upload.
 * Observed noop reports ≈ 1.22M FROST at 5 epochs on testnet.
 */
export function estimateWalFrostForUpload(payloadBytes: number, epochs: number): bigint {
  const perEpoch = 250_000n;
  const perByte = 50n;
  const base = BigInt(Math.max(1, epochs)) * perEpoch + BigInt(Math.max(0, payloadBytes)) * perByte;
  return base + WAL_UPLOAD_SAFETY_FROST;
}

export function walTargetFrost(args: {
  walBalance: bigint;
  thresholdFrost: bigint;
  requiredFrost: bigint;
}): bigint {
  const floor = args.thresholdFrost > args.requiredFrost ? args.thresholdFrost : args.requiredFrost;
  if (args.walBalance >= floor) return args.walBalance;
  return floor;
}

export function needsWalRefuel(walBalance: bigint, targetFrost: bigint): boolean {
  return walBalance < targetFrost;
}

/**
 * SUI to swap for WAL given current session balance. Returns null when the
 * session cannot afford min swap + gas reserve.
 */
export function computeWalSwapAmountMist(args: {
  suiBalanceMist: bigint;
  configuredMaxMist: bigint;
  gasReserveMist?: bigint;
  minSwapMist?: bigint;
}): bigint | null {
  const gasReserve = args.gasReserveMist ?? WAL_REFUEL_GAS_RESERVE_MIST;
  const minSwap = args.minSwapMist ?? MIN_WAL_REFUEL_SWAP_MIST;
  const available = args.suiBalanceMist > gasReserve ? args.suiBalanceMist - gasReserve : 0n;
  if (available < minSwap) return null;
  const capped =
    available < args.configuredMaxMist ? available : args.configuredMaxMist;
  return capped >= minSwap ? capped : null;
}

/** Session SUI needed before attempting a WAL swap of `swapMist`. */
export function suiNeededBeforeWalSwap(
  swapMist: bigint,
  gasReserveMist: bigint = WAL_REFUEL_GAS_RESERVE_MIST,
): bigint {
  return swapMist + gasReserveMist;
}

export function isInsufficientWalBalanceError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return lower.includes('insufficient balance') && lower.includes('wal');
}

/** Sui gas coin too small to pay for the Walrus upload PTB. */
export function isInsufficientSuiGasError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  return (
    (lower.includes('balance of gas object') && lower.includes('lower than the needed amount')) ||
    lower.includes('insufficient gas')
  );
}
