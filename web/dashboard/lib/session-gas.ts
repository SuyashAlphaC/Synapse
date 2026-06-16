/**
 * Session gas + operational budget health — mirrors runtime thresholds in
 * `sdk/packages/vault/src/runtime/wal-refuel.ts` and `runtime.ts`.
 */

export const MIST_PER_SUI = 1_000_000_000n;

/** Runtime `DEFAULT_REFUEL_THRESHOLD_MIST` — auto-refuel fires below this. */
export const SESSION_REFUEL_THRESHOLD_MIST = 20_000_000n;

/** Below this, even lightweight on-chain noops typically fail (observed ~3.1M). */
export const SESSION_NOOP_MIN_MIST = 6_000_000n;

const MIN_SESSION_GAS_MIST = 10_000_000n;
const PULL_OPERATIONAL_FUNDS_GAS_MIST = 5_000_000n;
const WALRUS_UPLOAD_MIN_SUI_MIST = 20_000_000n;

/** Minimum session SUI before ticks + Walrus upload (Walrus-enabled vaults). */
export const SESSION_WALRUS_OPERATING_MIN_MIST =
  MIN_SESSION_GAS_MIST + WALRUS_UPLOAD_MIN_SUI_MIST;

/** Minimum session SUI for non-Walrus vaults (tick gas + pull headroom). */
export const SESSION_BASIC_OPERATING_MIN_MIST =
  MIN_SESSION_GAS_MIST + PULL_OPERATIONAL_FUNDS_GAS_MIST;

export function sessionOperatingMinMist(acceptsWalrusExecution: boolean): bigint {
  return acceptsWalrusExecution
    ? SESSION_WALRUS_OPERATING_MIN_MIST
    : SESSION_BASIC_OPERATING_MIN_MIST;
}

export function isSessionGasLow(
  balanceMist: bigint,
  acceptsWalrusExecution: boolean,
): boolean {
  return balanceMist < sessionOperatingMinMist(acceptsWalrusExecution);
}

/** Ticks are likely failing on-chain right now. */
export function isSessionGasCritical(balanceMist: bigint): boolean {
  return balanceMist < SESSION_NOOP_MIN_MIST;
}

/** Match Move `pull_operational_funds` epoch roll on read. */
export function effectiveOperationalSpent(
  currentEpoch: bigint,
  spentThisEpoch: bigint,
  operationalLastEpochSeen: bigint,
): bigint {
  if (currentEpoch > operationalLastEpochSeen) return 0n;
  return spentThisEpoch;
}

export function isOperationalBudgetExhausted(
  currentEpoch: bigint,
  capPerEpoch: bigint,
  spentThisEpoch: bigint,
  operationalLastEpochSeen: bigint,
): boolean {
  if (capPerEpoch === 0n) return false;
  return (
    effectiveOperationalSpent(currentEpoch, spentThisEpoch, operationalLastEpochSeen) >=
    capPerEpoch
  );
}

export function formatSuiFromMist(mist: bigint, fractionDigits = 4): string {
  return (Number(mist) / Number(MIST_PER_SUI)).toFixed(fractionDigits);
}
