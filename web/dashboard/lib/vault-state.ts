/**
 * Browser-safe loader that reads the on-chain `AgentIdentity` object plus
 * its `Bag` treasury balances. Pure RPC — no Node-only modules, no env
 * vars. Reuses the same field shapes as the Node runtime so the SDK stays
 * isomorphic.
 */

import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { SYNAPSE_PACKAGE_ID } from './synapse-config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LiveAgentIdentity {
  id: string;
  owner: string;
  sessionAddr: string;
  expiryEpoch: bigint;
  spendPerEpoch: bigint;
  spentThisEpoch: bigint;
  lastEpochSeen: bigint;
  approvedPackages: string[];
  memwalAccountId: Uint8Array;
  memwalDelegateKeyId: Uint8Array;
  memwalNamespace: Uint8Array;
  nextArtifactId: bigint;
  artifactCount: bigint;
  messagingInbox: string | null;
  messagingOutbox: string | null;
  revoked: boolean;
  strategyId: string;
  /** v2+: per-epoch cap on operational pulls (0 = feature unset on this vault). */
  operationalCapPerEpoch: bigint;
  /** v2+: amount pulled this epoch via pull_operational_funds. */
  operationalSpentThisEpoch: bigint;
}

export interface LiveBalance {
  coinTypeTag: string;
  symbol: string;
  decimals: number;
  /** Raw atomic units (e.g., MIST for SUI). */
  amount: bigint;
}

export interface LiveVaultState {
  identity: LiveAgentIdentity;
  balances: LiveBalance[];
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export interface LoadLiveVaultArgs {
  client: SuiJsonRpcClient;
  vaultId: string;
  packageId?: string;
}

export async function loadLiveVault({
  client,
  vaultId,
  packageId = SYNAPSE_PACKAGE_ID,
}: LoadLiveVaultArgs): Promise<LiveVaultState> {
  const object = await client.getObject({ id: vaultId, options: { showContent: true } });
  if (object.error) {
    throw new Error(`AgentIdentity ${vaultId}: ${object.error.code}`);
  }
  const content = object.data?.content;
  if (!content || content.dataType !== 'moveObject') {
    throw new Error(`AgentIdentity ${vaultId} is not a Move object`);
  }
  const moveContent = content as { dataType: 'moveObject'; type: string; fields: unknown };
  if (!moveContent.type.startsWith(`${packageId}::agent::AgentIdentity`)) {
    throw new Error(
      `Object ${vaultId} is type ${moveContent.type}, not the deployed Synapse AgentIdentity`,
    );
  }

  const fields = asRecord(moveContent.fields, 'AgentIdentity.fields');
  const treasury = asRecord(fields.treasury, 'AgentIdentity.treasury');
  const treasuryFields = asRecord(treasury.fields, 'AgentIdentity.treasury.fields');
  const treasuryId = idFromField(treasuryFields.id, 'treasury.id');

  const identityCore = parseIdentity(vaultId, fields);
  const [balances, opBudget] = await Promise.all([
    loadTreasuryBalances(client, treasuryId),
    loadOperationalBudget(client, vaultId),
  ]);
  const identity: LiveAgentIdentity = {
    ...identityCore,
    operationalCapPerEpoch: opBudget.capPerEpoch,
    operationalSpentThisEpoch: opBudget.spentThisEpoch,
  };

  return { identity, balances };
}

// ---------------------------------------------------------------------------
// Treasury (Bag dynamic field walker)
// ---------------------------------------------------------------------------

/**
 * Read the dynamic-field-stored OperationalBudget (added in package v2).
 * Returns zeros when the field is absent (legacy vault, or v2+ vault
 * whose owner never called `set_operational_cap`).
 */
async function loadOperationalBudget(
  client: SuiJsonRpcClient,
  vaultId: string,
): Promise<{ capPerEpoch: bigint; spentThisEpoch: bigint }> {
  try {
    // Move dynamic field key is OperationalBudgetKey {} — a unit struct.
    // The RPC accepts the BCS-encoded struct via name.value = {}.
    const fieldName = {
      type: `${SYNAPSE_PACKAGE_ID}::agent::OperationalBudgetKey`,
      value: {},
    };
    const obj = await client.getDynamicFieldObject({
      parentId: vaultId,
      name: fieldName,
    });
    const content = obj.data?.content;
    if (!content || content.dataType !== 'moveObject') {
      return { capPerEpoch: 0n, spentThisEpoch: 0n };
    }
    const moveFields = (content as { fields: unknown }).fields;
    const valueFields = asRecord(
      (moveFields as { value?: unknown }).value ?? moveFields,
      'OperationalBudget.value',
    );
    return {
      capPerEpoch: bigintField(valueFields.cap_per_epoch, 'cap_per_epoch'),
      spentThisEpoch: bigintField(valueFields.spent_this_epoch, 'spent_this_epoch'),
    };
  } catch {
    return { capPerEpoch: 0n, spentThisEpoch: 0n };
  }
}

async function loadTreasuryBalances(
  client: SuiJsonRpcClient,
  treasuryId: string,
): Promise<LiveBalance[]> {
  const out: LiveBalance[] = [];
  let cursor: string | null | undefined;
  do {
    const page = await client.getDynamicFields({ parentId: treasuryId, cursor });
    for (const field of page.data) {
      const coinTypeTag = coinTypeFromDynamicField(field.name);
      const obj = await client.getDynamicFieldObject({
        parentId: treasuryId,
        name: field.name,
      });
      const content = obj.data?.content;
      if (!content || content.dataType !== 'moveObject') continue;
      const moveFields = (content as { fields: unknown }).fields;
      const inner = asRecord(moveFields, 'treasury balance fields');
      const amount = bigintField(findFieldValue(inner, 'value'), 'balance.value');
      const metadata = await client.getCoinMetadata({ coinType: coinTypeTag });
      out.push({
        coinTypeTag,
        symbol: metadata?.symbol ?? symbolFromTypeTag(coinTypeTag),
        decimals: metadata?.decimals ?? 0,
        amount,
      });
    }
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor);
  return out;
}

/**
 * Pull the canonical coin type tag (`<addr>::<module>::<type>`) out of a
 * dynamic field name. The Bag treasury stores `Balance<T>` keyed by Move's
 * `TypeName` struct, which Sui's RPC normalizes to one of:
 *
 *   - a plain string: `"0x2::sui::SUI"` (rare, SDK-dependent)
 *   - `{ name: "0000…02::sui::SUI" }`               ← typical TypeName shape
 *   - `{ name: "0x2::sui::SUI" }`                   ← already 0x-prefixed
 *   - `{ fields: { name: "…" } }`                   ← deeper wrap
 *
 * We accept all variants and normalize to `0x`-prefixed form.
 */
function coinTypeFromDynamicField(name: { type: string; value: unknown }): string {
  const value = name.value;
  if (typeof value === 'string') return normalizeTypeTag(value);
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.name === 'string') return normalizeTypeTag(obj.name);
    if (typeof obj.fields === 'object' && obj.fields !== null) {
      const f = obj.fields as Record<string, unknown>;
      if (typeof f.name === 'string') return normalizeTypeTag(f.name);
    }
  }
  throw new Error(`Cannot parse dynamic field name: ${JSON.stringify(value)}`);
}

function normalizeTypeTag(raw: string): string {
  // TypeName.name omits the 0x prefix on the leading address; restore it
  // so downstream `getCoinMetadata` calls + UI links resolve correctly.
  const trimmed = raw.trim();
  if (trimmed.startsWith('0x')) return trimmed;
  // Make sure the leading hex looks like an address before prefixing.
  const colon = trimmed.indexOf('::');
  if (colon === -1) return trimmed;
  const head = trimmed.slice(0, colon);
  if (/^[0-9a-fA-F]+$/.test(head)) return `0x${trimmed}`;
  return trimmed;
}

// ---------------------------------------------------------------------------
// Identity parser
// ---------------------------------------------------------------------------

function parseIdentity(
  id: string,
  fields: Record<string, unknown>,
): Omit<LiveAgentIdentity, 'operationalCapPerEpoch' | 'operationalSpentThisEpoch'> {
  return {
    id,
    owner: stringField(fields.owner, 'owner'),
    sessionAddr: stringField(fields.session_addr, 'session_addr'),
    expiryEpoch: bigintField(fields.expiry_epoch, 'expiry_epoch'),
    spendPerEpoch: bigintField(fields.spend_per_epoch, 'spend_per_epoch'),
    spentThisEpoch: bigintField(fields.spent_this_epoch, 'spent_this_epoch'),
    lastEpochSeen: bigintField(fields.last_epoch_seen, 'last_epoch_seen'),
    approvedPackages: vectorString(fields.approved_packages, 'approved_packages'),
    memwalAccountId: bytesField(fields.memwal_account_id, 'memwal_account_id'),
    memwalDelegateKeyId: bytesField(fields.memwal_delegate_key_id, 'memwal_delegate_key_id'),
    memwalNamespace: bytesField(fields.memwal_namespace, 'memwal_namespace'),
    nextArtifactId: bigintField(fields.next_artifact_id, 'next_artifact_id'),
    artifactCount: bigintField(fields.artifact_count, 'artifact_count'),
    messagingInbox: optionId(fields.messaging_inbox),
    messagingOutbox: optionId(fields.messaging_outbox),
    revoked: booleanField(fields.revoked, 'revoked'),
    strategyId: idField(fields.strategy_id, 'strategy_id'),
  };
}

function idField(value: unknown, label: string): string {
  // Sui parsed `ID` arrives as either a plain string or `{ id: "0x..." }`.
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.id === 'string') return obj.id;
    if (typeof obj.fields === 'object' && obj.fields !== null) {
      const f = obj.fields as Record<string, unknown>;
      if (typeof f.id === 'string') return f.id;
    }
  }
  throw new Error(`${label} is not an ID-like value`);
}

// ---------------------------------------------------------------------------
// Strict scalar parsers
// ---------------------------------------------------------------------------

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function idFromField(value: unknown, label: string): string {
  const outer = asRecord(value, label);
  return stringField(outer.id, `${label}.id`);
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is not a string`);
  return value;
}

function booleanField(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} is not a boolean`);
  return value;
}

function bigintField(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`${label} is not a u64-like value`);
}

function vectorString(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not a vector`);
  return value.map((v, i) => stringField(v, `${label}[${i}]`));
}

function bytesField(value: unknown, label: string): Uint8Array {
  if (!Array.isArray(value)) throw new Error(`${label} is not a byte vector`);
  return Uint8Array.from(value.map((v, i) => byte(v, `${label}[${i}]`)));
}

function byte(value: unknown, label: string): number {
  if (typeof value !== 'number' || value < 0 || value > 255 || !Number.isInteger(value)) {
    throw new Error(`${label} is not a byte`);
  }
  return value;
}

/**
 * Parse a Move `Option<ID>` from the parsed-JSON RPC response. Sui's
 * normalization can deliver any of the following shapes depending on
 * SDK + node version:
 *
 *   - `null` / `undefined`                           ← canonical None
 *   - a plain `"0x..."` string                       ← canonical Some
 *   - `{ vec: ["0x..."] }`                           ← BCS-derived Some
 *   - `{ vec: [] }`                                  ← BCS-derived None
 *   - `{ fields: { vec: [...] } }`                   ← deeper wrapper
 *   - `{ vec: [{ id: "0x..." }] }`                   ← ID struct form
 *   - `{ vec: [{ fields: { id: "0x..." } }] }`       ← double-wrapped
 *
 * We accept all of them. Never throws — an unrecognized shape returns null.
 */
function optionId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;

  const obj = value as Record<string, unknown>;

  // Drill into `fields.vec` then `vec` to find the wrapped array.
  let vec: unknown = obj.vec;
  if (vec === undefined && typeof obj.fields === 'object' && obj.fields !== null) {
    vec = (obj.fields as Record<string, unknown>).vec;
  }
  if (!Array.isArray(vec) || vec.length === 0) return null;

  const first = vec[0];
  if (typeof first === 'string') return first.length > 0 ? first : null;
  if (typeof first === 'object' && first !== null) {
    const f = first as Record<string, unknown>;
    if (typeof f.id === 'string') return f.id;
    if (typeof f.fields === 'object' && f.fields !== null) {
      const ff = f.fields as Record<string, unknown>;
      if (typeof ff.id === 'string') return ff.id;
    }
  }
  return null;
}

function findFieldValue(record: Record<string, unknown>, key: string): unknown {
  if (key in record) return record[key];
  for (const value of Object.values(record)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const found = findFieldValue(value as Record<string, unknown>, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function symbolFromTypeTag(typeTag: string): string {
  return typeTag.split('::').at(-1) ?? typeTag;
}
