/**
 * Lightweight client-side bookmark of the user's minted vaults. Used only as
 * a fallback for the demo dashboard until the indexer's GraphQL endpoint is
 * exposed in production — at that point we read directly from event history.
 *
 * Persists in `localStorage` keyed per-owner address.
 */

const STORAGE_KEY = 'synapse:vaults:v1';

export interface LocalVaultRecord {
  agentId: string;
  ownerAddress: string;
  digest: string;
  sessionAddress: string;
  memwalAccountId: string | null;
  mintedAtMs: number;
}

function read(): LocalVaultRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as LocalVaultRecord[];
  } catch {
    return [];
  }
}

function write(records: LocalVaultRecord[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

export function recordVault(rec: LocalVaultRecord): void {
  const current = read();
  // Upsert by agentId
  const next = [rec, ...current.filter((r) => r.agentId !== rec.agentId)];
  write(next.slice(0, 32));
}

export function listVaults(owner?: string): LocalVaultRecord[] {
  const all = read();
  if (!owner) return all;
  return all.filter((r) => r.ownerAddress.toLowerCase() === owner.toLowerCase());
}

export function latestVaultFor(owner: string): LocalVaultRecord | null {
  const list = listVaults(owner).sort((a, b) => b.mintedAtMs - a.mintedAtMs);
  return list[0] ?? null;
}
