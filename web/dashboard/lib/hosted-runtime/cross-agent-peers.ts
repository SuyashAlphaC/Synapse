const OBJECT_ID_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Parse comma- or newline-separated vault object ids for
 * `SYNAPSE_CROSS_AGENT_PEERS`. Returns a comma-joined string for ECS env,
 * or null when empty.
 */
export function normalizeCrossAgentPeerVaultIds(
  raw: string | undefined | null,
  options?: { selfVaultId?: string },
): string | null {
  if (!raw?.trim()) return null;
  const ids = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) return null;

  const normalized: string[] = [];
  for (const id of ids) {
    const withPrefix = id.startsWith('0x') ? id : `0x${id}`;
    if (!OBJECT_ID_RE.test(withPrefix)) {
      throw new Error(
        `Invalid peer vault id "${id}" — expected a 32-byte hex object id (0x…, 64 hex chars)`,
      );
    }
    if (
      options?.selfVaultId &&
      withPrefix.toLowerCase() === options.selfVaultId.toLowerCase()
    ) {
      throw new Error('Peer vault ids must not include this vault\'s own id');
    }
    if (!normalized.some((existing) => existing.toLowerCase() === withPrefix.toLowerCase())) {
      normalized.push(withPrefix);
    }
  }
  return normalized.join(',');
}

/** Split a stored ECS env value into individual peer vault ids. */
export function splitCrossAgentPeerVaultIds(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
