/**
 * Deterministic, human-friendly display name for a vault.
 *
 * Vaults have NO on-chain name field — on-chain a vault is just an
 * `AgentIdentity` object addressed by its ID. To give each vault a
 * stable, memorable label (instead of a single hardcoded placeholder
 * shared by every vault), we derive the name deterministically from the
 * vault ID: the same ID always yields the same name, and distinct IDs
 * spread across the word list. This is a cosmetic identifier only — the
 * canonical identity is always the full vault ID, shown verbatim in the
 * toolbar and "View on suiscan".
 */

const VAULT_NAME_WORDS = [
  'Helios', 'Aurora', 'Cobalt', 'Meridian', 'Solace', 'Vanta', 'Lumen', 'Atlas',
  'Zephyr', 'Onyx', 'Halcyon', 'Ember', 'Cirrus', 'Pallas', 'Nimbus', 'Vertex',
  'Selene', 'Borealis', 'Caldera', 'Equinox', 'Sable', 'Tundra', 'Vesper', 'Quartz',
  'Lyra', 'Castor', 'Polaris', 'Cygnus', 'Helix', 'Sirius', 'Altair', 'Rigel',
] as const;

/** FNV-1a over the lowercased hex — small, stable, dependency-free. */
function hashHex(input: string): number {
  let hash = 0x811c9dc5;
  const lower = input.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    hash ^= lower.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Stable "{Word} Treasury" derived from the vault ID. */
export function vaultDisplayName(vaultId: string): string {
  const cleaned = vaultId.replace(/^0x/, '');
  if (cleaned.length === 0) return 'Unnamed Treasury';
  const word = VAULT_NAME_WORDS[hashHex(cleaned) % VAULT_NAME_WORDS.length];
  return `${word} Treasury`;
}
