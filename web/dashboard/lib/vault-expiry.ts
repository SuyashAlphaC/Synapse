/**
 * Move allows action while `ctx.epoch() < identity.expiry_epoch`.
 * At `currentEpoch >= expiryEpoch` the vault is expired (hosted runtime noops).
 */
export function isVaultExpired(currentEpoch: bigint, expiryEpoch: bigint): boolean {
  return currentEpoch >= expiryEpoch;
}
