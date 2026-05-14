/**
 * Browser helpers for reading the on-chain artifact registry attached to an
 * AgentIdentity (dynamic fields keyed by `u64` slot) and fetching the
 * corresponding Walrus blob content.
 */

import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { SYNAPSE_PACKAGE_ID } from './synapse-config';

export interface ArtifactRecord {
  slot: bigint;
  walrusBlobId: string;
  sha256: Uint8Array;
  mimeType: string;
  sizeBytes: bigint;
  createdAtEpoch: bigint;
  sealEncrypted: boolean;
  label: string;
}

const WALRUS_TESTNET_AGGREGATOR = 'https://aggregator.walrus-testnet.walrus.space';
const WALRUS_MAINNET_AGGREGATOR = 'https://aggregator.walrus-mainnet.walrus.space';

type Network = 'mainnet' | 'testnet';

export function aggregatorUrlForNetwork(network: Network): string {
  return network === 'mainnet' ? WALRUS_MAINNET_AGGREGATOR : WALRUS_TESTNET_AGGREGATOR;
}

/**
 * List every published artifact attached to the given vault. Walks all
 * dynamic fields of type `u64` on the AgentIdentity UID.
 */
export async function listVaultArtifacts(args: {
  client: SuiJsonRpcClient;
  vaultId: string;
  packageId?: string;
}): Promise<ArtifactRecord[]> {
  const records: ArtifactRecord[] = [];
  let cursor: string | null | undefined;
  do {
    const page = await args.client.getDynamicFields({ parentId: args.vaultId, cursor });
    for (const field of page.data) {
      if (!isU64FieldName(field.name)) continue;
      const obj = await args.client.getDynamicFieldObject({
        parentId: args.vaultId,
        name: field.name,
      });
      const content = obj.data?.content;
      if (!content || content.dataType !== 'moveObject') continue;
      if (!content.type.includes(`${args.packageId ?? SYNAPSE_PACKAGE_ID}::artifacts::ArtifactRef`)) continue;
      const fields = (content as { fields: Record<string, unknown> }).fields;
      const inner = asRecord(fields.value ?? fields, 'ArtifactRef.value');
      const slot = bigintFromUnknown(field.name.value, 'artifact slot');
      records.push({
        slot,
        walrusBlobId: bytesToUtf8(bytesField(inner.walrus_blob_id, 'walrus_blob_id')),
        sha256: bytesField(inner.sha256, 'sha256'),
        mimeType: stringField(inner.mime_type, 'mime_type'),
        sizeBytes: bigintFromUnknown(inner.size_bytes, 'size_bytes'),
        createdAtEpoch: bigintFromUnknown(inner.created_at_epoch, 'created_at_epoch'),
        sealEncrypted: booleanField(inner.seal_encrypted, 'seal_encrypted'),
        label: stringField(inner.label, 'label'),
      });
    }
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor);

  records.sort((a, b) => Number(b.slot - a.slot));
  return records;
}

/**
 * Fetch raw bytes for a Walrus blob via the network's public aggregator.
 */
export async function fetchWalrusBlob(args: {
  walrusBlobId: string;
  network: Network;
  signal?: AbortSignal;
}): Promise<Uint8Array> {
  const url = `${aggregatorUrlForNetwork(args.network)}/v1/blobs/${args.walrusBlobId}`;
  const opts: RequestInit = args.signal ? { signal: args.signal } : {};
  const response = await fetch(url, opts);
  if (!response.ok) {
    throw new Error(`Walrus aggregator returned ${response.status} ${response.statusText}`);
  }
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

export async function fetchWalrusBlobAsText(args: {
  walrusBlobId: string;
  network: Network;
  signal?: AbortSignal;
}): Promise<string> {
  const bytes = await fetchWalrusBlob(args);
  return new TextDecoder('utf-8').decode(bytes);
}

// ---------------------------------------------------------------------------
// Internal parsers
// ---------------------------------------------------------------------------

function isU64FieldName(name: { type: string }): boolean {
  return typeof name.type === 'string' && name.type === 'u64';
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
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

function bytesField(value: unknown, label: string): Uint8Array {
  if (!Array.isArray(value)) throw new Error(`${label} is not a byte vector`);
  return Uint8Array.from(
    value.map((v, i) => {
      if (typeof v !== 'number' || v < 0 || v > 255) {
        throw new Error(`${label}[${i}] is not a byte`);
      }
      return v;
    }),
  );
}

function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}
