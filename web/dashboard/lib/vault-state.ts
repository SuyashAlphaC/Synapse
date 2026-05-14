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

  const identity = parseIdentity(vaultId, fields);
  const balances = await loadTreasuryBalances(client, treasuryId);

  return { identity, balances };
}

// ---------------------------------------------------------------------------
// Treasury (Bag dynamic field walker)
// ---------------------------------------------------------------------------

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

function coinTypeFromDynamicField(name: { type: string; value: unknown }): string {
  const value = name.value;
  if (typeof value === 'string') return value;
  const record = asRecord(value, 'dynamic field name value');
  const definingId = stringField(record.defining_id, 'dynamic name defining_id');
  const moduleName = stringField(record.module, 'dynamic name module');
  const typeName = stringField(record.name, 'dynamic name name');
  return `${definingId}::${moduleName}::${typeName}`;
}

// ---------------------------------------------------------------------------
// Identity parser
// ---------------------------------------------------------------------------

function parseIdentity(id: string, fields: Record<string, unknown>): LiveAgentIdentity {
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
  };
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

function optionId(value: unknown): string | null {
  const record = asRecord(value, 'option');
  const fields = asRecord(record.fields, 'option.fields');
  const vec = fields.vec;
  if (!Array.isArray(vec) || vec.length === 0) return null;
  const first = vec[0];
  if (typeof first === 'string') return first;
  return idFromField(first, 'option.vec[0]');
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
