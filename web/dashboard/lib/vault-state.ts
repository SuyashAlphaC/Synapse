/**
 * Browser-safe loader that reads the on-chain `AgentIdentity` object plus
 * its `Bag` treasury balances. Pure RPC — no Node-only modules, no env
 * vars. Reuses the same field shapes as the Node runtime so the SDK stays
 * isomorphic.
 */

import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { SYNAPSE_PACKAGE_ID, SYNAPSE_PACKAGE_HISTORY } from './synapse-config';

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
  /** v2+: epoch when operational spent counter was last rolled (Move `last_epoch_seen`). */
  operationalLastEpochSeen: bigint;
  /**
   * v3+: vault owner has opted into dynamic Walrus-loaded strategy
   * execution. Defaults to `false` for any vault that never called
   * `set_walrus_consent` (i.e., every vault minted before the consent
   * upgrade). The runtime gates the Walrus loader on this flag.
   */
  acceptsWalrusExecution: boolean;
  /**
   * v4+: vault requires an enclave-attested decision (Nautilus) before it may
   * spend. Defaults to `false`. When true, the Move spend gate aborts any trade
   * not preceded by a valid `decision_attestation::attest_decision` this epoch.
   */
  requiresAttestation: boolean;
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
  /** Package that minted this vault — owner PTBs must target this, not latest. */
  mintPackageId: string;
}

/** Extract `0x…` package address from a fully-qualified Move type. */
export function packageIdFromMoveType(fullType: string): string {
  const pkg = fullType.split('::')[0];
  if (!pkg?.startsWith('0x')) {
    throw new Error(`Cannot parse package id from Move type: ${fullType}`);
  }
  return pkg;
}

/** True for canonical or padded-address `0x…::sui::SUI` type tags. */
export function isNativeSuiCoinType(coinTypeTag: string): boolean {
  const lower = coinTypeTag.toLowerCase();
  if (lower === '0x2::sui::sui') return true;
  const parts = lower.split('::');
  if (parts.length !== 3 || parts[1] !== 'sui' || parts[2] !== 'sui') return false;
  const addr = parts[0].startsWith('0x') ? parts[0].slice(2) : parts[0];
  return addr.replace(/^0+/, '') === '2';
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
  // Accept AgentIdentity objects minted under ANY historical package
  // version. On Sui, the object's type is namespaced by the package
  // that minted it, so v1-minted vaults stay typed as
  // `<v1-pkg>::agent::AgentIdentity` even after the v2 upgrade —
  // matching only the current package ID would orphan every vault
  // older than the latest deploy.
  if (!isAgentIdentityType(moveContent.type, packageId)) {
    throw new Error(
      `Object ${vaultId} is type ${moveContent.type}, not a Synapse AgentIdentity`,
    );
  }

  const fields = asRecord(moveContent.fields, 'AgentIdentity.fields');
  const treasury = asRecord(fields.treasury, 'AgentIdentity.treasury');
  const treasuryFields = asRecord(treasury.fields, 'AgentIdentity.treasury.fields');
  const treasuryId = idFromField(treasuryFields.id, 'treasury.id');

  const identityCore = parseIdentity(vaultId, fields);
  const [balances, opBudget, acceptsWalrusExecution, requiresAttestation] = await Promise.all([
    loadTreasuryBalances(client, treasuryId),
    loadOperationalBudget(client, vaultId),
    loadWalrusConsent(client, vaultId),
    loadRequiresAttestation(client, vaultId),
  ]);
  const identity: LiveAgentIdentity = {
    ...identityCore,
    operationalCapPerEpoch: opBudget.capPerEpoch,
    operationalSpentThisEpoch: opBudget.spentThisEpoch,
    operationalLastEpochSeen: opBudget.lastEpochSeen,
    acceptsWalrusExecution,
    requiresAttestation,
  };

  return { identity, balances, mintPackageId: packageIdFromMoveType(moveContent.type) };
}

/**
 * Read the per-vault Walrus-execution consent flag (added in package
 * v3). Stored as a dynamic field on the AgentIdentity UID keyed by
 * `WalrusConsentKey`. Returns `false` for any vault whose owner never
 * called `set_walrus_consent` — the safe default for the runtime.
 *
 * Iterates `SYNAPSE_PACKAGE_HISTORY` because the dynamic-field key
 * type is namespaced by the package that defined it; a v3 key won't
 * resolve against a v2-typed parent unless we walk the upgrade chain.
 */
async function loadWalrusConsent(
  client: SuiJsonRpcClient,
  vaultId: string,
): Promise<boolean> {
  const packages =
    SYNAPSE_PACKAGE_HISTORY.length > 0 ? SYNAPSE_PACKAGE_HISTORY : [SYNAPSE_PACKAGE_ID];
  for (const pkg of packages) {
    try {
      const obj = await client.getDynamicFieldObject({
        parentId: vaultId,
        name: {
          // Sui auto-inserts `dummy_field: bool` into unit-struct keys
          // (Move forbids zero-field structs). The RPC rejects
          // `value: {}` with "missing field dummy_field" — must pass
          // the synthetic field explicitly.
          type: `${pkg}::agent::WalrusConsentKey`,
          value: { dummy_field: false },
        },
      });
      const content = obj.data?.content;
      if (!content || content.dataType !== 'moveObject') continue;
      const inner = unwrapMoveValue(
        (content as { fields: unknown }).fields,
        'WalrusConsent',
      );
      const accept = inner['accept'];
      if (typeof accept === 'boolean') return accept;
    } catch {
      // Try the next historical package; missing field is not an error.
    }
  }
  return false;
}

/**
 * Read the per-vault attestation requirement (added in package v4). Stored as a
 * dynamic field keyed by `AttestationGateKey`. Returns `false` for any vault
 * whose owner never called `set_requires_attestation`. Walks the package history
 * because the key type is namespaced by the package that defined it.
 */
async function loadRequiresAttestation(
  client: SuiJsonRpcClient,
  vaultId: string,
): Promise<boolean> {
  const packages =
    SYNAPSE_PACKAGE_HISTORY.length > 0 ? SYNAPSE_PACKAGE_HISTORY : [SYNAPSE_PACKAGE_ID];
  for (const pkg of packages) {
    try {
      const obj = await client.getDynamicFieldObject({
        parentId: vaultId,
        name: {
          type: `${pkg}::agent::AttestationGateKey`,
          value: { dummy_field: false },
        },
      });
      const content = obj.data?.content;
      if (!content || content.dataType !== 'moveObject') continue;
      const inner = unwrapMoveValue((content as { fields: unknown }).fields, 'AttestationGate');
      const required = inner['required'];
      if (typeof required === 'boolean') return required;
    } catch {
      // Try the next historical package; missing field is not an error.
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Treasury (Bag dynamic field walker)
// ---------------------------------------------------------------------------

/**
 * Read the dynamic-field-stored OperationalBudget (added in package v2).
 * Returns zeros when the field is absent (legacy vault, or v2+ vault
 * whose owner never called `set_operational_cap`).
 *
 * Two subtleties this loader handles:
 *  1. The dynamic-field name is namespaced by the package version
 *     that *defined* OperationalBudgetKey (v2), not the latest. After
 *     the v3 upgrade we can't hardcode `SYNAPSE_PACKAGE_ID` here —
 *     we walk SYNAPSE_PACKAGE_HISTORY to find whichever version
 *     introduced the field.
 *  2. Move forbids zero-field structs, so Sui auto-inserts a
 *     `dummy_field: bool` into unit-struct keys to satisfy BCS. The
 *     RPC rejects `value: {}` with "missing field dummy_field" — we
 *     must pass `{ dummy_field: false }` explicitly.
 */
async function loadOperationalBudget(
  client: SuiJsonRpcClient,
  vaultId: string,
): Promise<{ capPerEpoch: bigint; spentThisEpoch: bigint; lastEpochSeen: bigint }> {
  const packages =
    SYNAPSE_PACKAGE_HISTORY.length > 0 ? SYNAPSE_PACKAGE_HISTORY : [SYNAPSE_PACKAGE_ID];
  for (const pkg of packages) {
    try {
      const obj = await client.getDynamicFieldObject({
        parentId: vaultId,
        name: {
          type: `${pkg}::agent::OperationalBudgetKey`,
          value: { dummy_field: false },
        },
      });
      const content = obj.data?.content;
      if (!content || content.dataType !== 'moveObject') continue;
      const valueFields = unwrapMoveValue(
        (content as { fields: unknown }).fields,
        'OperationalBudget',
      );
      return {
        capPerEpoch: bigintField(valueFields.cap_per_epoch, 'cap_per_epoch'),
        spentThisEpoch: bigintField(valueFields.spent_this_epoch, 'spent_this_epoch'),
        lastEpochSeen: bigintField(valueFields.last_epoch_seen, 'last_epoch_seen'),
      };
    } catch {
      // Try the next package version; absence is the common case, not an error.
    }
  }
  return { capPerEpoch: 0n, spentThisEpoch: 0n, lastEpochSeen: 0n };
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
): Omit<
  LiveAgentIdentity,
  | 'operationalCapPerEpoch'
  | 'operationalSpentThisEpoch'
  | 'operationalLastEpochSeen'
  | 'acceptsWalrusExecution'
  | 'requiresAttestation'
> {
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

/**
 * Pull the inner Move-struct field map out of a `0x2::dynamic_field::Field`
 * response. The wire shape from `getDynamicFieldObject` is:
 *
 *   content.fields = {
 *     id: { id: '0x…' },
 *     name: { type: '<pkg>::…::Key', fields: { dummy_field: false } },
 *     value: { type: '<pkg>::…::Value', fields: { <real fields> } }
 *   }
 *
 * Two layers of unwrapping needed: `content.fields.value` then
 * `.fields` again to get the actual struct members. Accepts either
 * shape — some SDK versions flatten the typed wrapper.
 */
function unwrapMoveValue(rawFields: unknown, label: string): Record<string, unknown> {
  const outer = asRecord(rawFields, `${label}.outer`);
  const value = (outer as { value?: unknown }).value;
  const wrapper = value !== undefined ? asRecord(value, `${label}.value`) : outer;
  // If wrapper has its own `.fields` (typed Move struct shape), use that.
  // Otherwise, treat wrapper itself as the field map (flattened shape).
  if ('fields' in wrapper && typeof wrapper.fields === 'object' && wrapper.fields !== null) {
    return asRecord(wrapper.fields, `${label}.value.fields`);
  }
  return wrapper;
}

function isAgentIdentityType(typeStr: string, currentPackageId: string): boolean {
  if (typeStr.startsWith(`${currentPackageId}::agent::AgentIdentity`)) return true;
  for (const pkg of SYNAPSE_PACKAGE_HISTORY) {
    if (typeStr.startsWith(`${pkg}::agent::AgentIdentity`)) return true;
  }
  return false;
}
