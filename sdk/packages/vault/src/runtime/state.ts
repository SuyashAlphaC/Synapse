import type { SuiJsonRpcClient, DynamicFieldName } from '@mysten/sui/jsonRpc';
import type { AgentIdentity } from '@synapse-core/client';
import type { HoldingSnapshot, VaultPolicy } from '../types.js';

export interface TreasuryBalance {
  coinTypeTag: string;
  symbol: string;
  amount: bigint;
  decimals: number;
}

export interface OnChainAgentState {
  identity: AgentIdentity;
  policy: VaultPolicy;
  balances: TreasuryBalance[];
  holdings: HoldingSnapshot[];
}

export async function loadAgentState(args: {
  client: SuiJsonRpcClient;
  agentId: string;
  packageId: string;
}): Promise<OnChainAgentState> {
  const object = await args.client.getObject({
    id: args.agentId,
    options: { showContent: true },
  });
  if (object.error) {
    throw new Error(`AgentIdentity ${args.agentId} could not be loaded: ${object.error.code}`);
  }
  const content = object.data?.content;
  if (!content || content.dataType !== 'moveObject') {
    throw new Error(`AgentIdentity ${args.agentId} is not a Move object`);
  }
  if (!content.type.startsWith(`${args.packageId}::agent::AgentIdentity`)) {
    throw new Error(`Object ${args.agentId} is ${content.type}, not this package AgentIdentity`);
  }

  const fields = asRecord(content.fields, 'AgentIdentity.fields');
  const treasury = asRecord(fields.treasury, 'AgentIdentity.treasury');
  const treasuryFields = asRecord(treasury.fields, 'AgentIdentity.treasury.fields');
  const treasuryId = idFromField(treasuryFields.id, 'treasury.id');
  const identity = parseIdentity(args.agentId, fields);
  const balances = await loadTreasuryBalances(args.client, treasuryId);

  const holdings = balances.map((balance) => ({
    coinTypeTag: balance.coinTypeTag,
    symbol: balance.symbol,
    amount: balance.amount,
    decimals: balance.decimals,
    priceUsd: 0,
    valueUsd: 0,
  }));

  const policy: VaultPolicy = {
    spendPerEpochUsd: Number(identity.spendPerEpoch) / 1_000_000_000,
    approvedPackages: identity.approvedPackages,
    expiryEpoch: identity.expiryEpoch,
    revoked: identity.revoked,
  };

  return { identity, policy, balances, holdings };
}

async function loadTreasuryBalances(
  client: SuiJsonRpcClient,
  treasuryId: string,
): Promise<TreasuryBalance[]> {
  const balances: TreasuryBalance[] = [];
  let cursor: string | null | undefined;
  do {
    const page = await client.getDynamicFields({ parentId: treasuryId, cursor });
    for (const field of page.data) {
      const coinTypeTag = coinTypeFromDynamicField(field.name);
      const object = await client.getDynamicFieldObject({
        parentId: treasuryId,
        name: field.name,
      });
      const content = object.data?.content;
      if (!content || content.dataType !== 'moveObject') continue;
      const objectFields = asRecord(content.fields, 'treasury balance fields');
      const amount = bigintFromUnknown(findFieldValue(objectFields, 'value'), 'balance.value');
      const metadata = await client.getCoinMetadata({ coinType: coinTypeTag });
      balances.push({
        coinTypeTag,
        symbol: metadata?.symbol ?? symbolFromTypeTag(coinTypeTag),
        decimals: metadata?.decimals ?? 0,
        amount,
      });
    }
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor);
  return balances;
}

function parseIdentity(agentId: string, fields: Record<string, unknown>): AgentIdentity {
  return {
    id: agentId,
    owner: stringField(fields.owner, 'owner'),
    sessionAddr: stringField(fields.session_addr, 'session_addr'),
    expiryEpoch: bigintFromUnknown(fields.expiry_epoch, 'expiry_epoch'),
    spendPerEpoch: bigintFromUnknown(fields.spend_per_epoch, 'spend_per_epoch'),
    spentThisEpoch: bigintFromUnknown(fields.spent_this_epoch, 'spent_this_epoch'),
    lastEpochSeen: bigintFromUnknown(fields.last_epoch_seen, 'last_epoch_seen'),
    approvedPackages: vectorString(fields.approved_packages, 'approved_packages'),
    memwalAccountId: bytesField(fields.memwal_account_id, 'memwal_account_id'),
    memwalDelegateKeyId: bytesField(fields.memwal_delegate_key_id, 'memwal_delegate_key_id'),
    memwalNamespace: bytesField(fields.memwal_namespace, 'memwal_namespace'),
    nextArtifactId: bigintFromUnknown(fields.next_artifact_id, 'next_artifact_id'),
    artifactCount: bigintFromUnknown(fields.artifact_count, 'artifact_count'),
    messagingInbox: optionId(fields.messaging_inbox),
    messagingOutbox: optionId(fields.messaging_outbox),
    revoked: booleanField(fields.revoked, 'revoked'),
    strategyId: idField(fields.strategy_id, 'strategy_id'),
  };
}

function idField(value: unknown, label: string): string {
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

/**
 * Pull the canonical coin type tag (`<addr>::<module>::<type>`) out of a
 * Sui dynamic field name. The Bag treasury keys `Balance<T>` by Move's
 * `TypeName`, which Sui's RPC normalizes to one of: a bare string, or
 * `{ name: "..." }`, sometimes with the leading address missing its `0x`.
 * Accept every variant and normalize.
 */
function coinTypeFromDynamicField(name: DynamicFieldName): string {
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
  const trimmed = raw.trim();
  if (trimmed.startsWith('0x')) return trimmed;
  const colon = trimmed.indexOf('::');
  if (colon === -1) return trimmed;
  const head = trimmed.slice(0, colon);
  if (/^[0-9a-fA-F]+$/.test(head)) return `0x${trimmed}`;
  return trimmed;
}

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

function bigintFromUnknown(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`${label} is not a u64-like value`);
}

function vectorString(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not a vector`);
  return value.map((item, index) => stringField(item, `${label}[${index}]`));
}

function bytesField(value: unknown, label: string): Uint8Array {
  if (!Array.isArray(value)) throw new Error(`${label} is not a byte vector`);
  return Uint8Array.from(value.map((item, index) => numberByte(item, `${label}[${index}]`)));
}

function numberByte(value: unknown, label: string): number {
  if (typeof value !== 'number' || value < 0 || value > 255 || !Number.isInteger(value)) {
    throw new Error(`${label} is not a byte`);
  }
  return value;
}

/**
 * Parse a Move `Option<ID>` from the parsed-JSON RPC response. Sui's
 * normalization can deliver any of these shapes depending on SDK + node
 * version: null, a bare string, `{ vec: [...] }`, `{ fields: { vec: [...] } }`,
 * or `{ vec: [{ id: "0x..." }] }`. We accept them all and never throw.
 */
function optionId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;

  const obj = value as Record<string, unknown>;

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
