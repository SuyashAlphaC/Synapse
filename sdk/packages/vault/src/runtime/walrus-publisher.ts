/**
 * Runtime-side Walrus publisher fallback.
 *
 * The direct-write path through `@mysten/walrus` SDK depends on the
 * runtime reaching enough storage nodes for a write quorum. On testnet
 * that quorum is unreliable — we routinely see "Too many failures
 * while writing blob …" or "Too many invalid confirmations received".
 *
 * Walrus also operates an HTTP **publisher** service that handles all
 * the storage-node fan-out + retries server-side. From the client's
 * perspective it's a single PUT request that either succeeds or
 * fails — no SDK, no signer needed (the publisher pays storage fees
 * on its side; we cover them only if it routes back to a Sui PTB).
 *
 * Mirrors `web/dashboard/lib/walrus-publisher.ts` but lives on the
 * Node side and returns the same `WalrusUploadResult` shape the rest
 * of the runtime expects.
 */

import type { WalrusUploadResult } from '@synapse-core/client';

async function sha256Bytes(input: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input as BufferSource);
  return new Uint8Array(digest);
}

const WALRUS_TESTNET_PUBLISHER = 'https://publisher.walrus-testnet.walrus.space';
const WALRUS_MAINNET_PUBLISHER = 'https://publisher.walrus-mainnet.walrus.space';

export type WalrusNetwork = 'testnet' | 'mainnet';

function publisherUrlForNetwork(network: WalrusNetwork): string {
  return network === 'mainnet' ? WALRUS_MAINNET_PUBLISHER : WALRUS_TESTNET_PUBLISHER;
}

export interface UploadViaPublisherArgs {
  bytes: Uint8Array;
  network: WalrusNetwork;
  epochs: number;
  signal?: AbortSignal;
}

/**
 * PUT `bytes` to the public Walrus publisher. Returns the same shape
 * as `@mysten/walrus`'s `uploadBlob` so callers can swap upload paths
 * without touching downstream code.
 *
 * Throws on any non-2xx response. Callers should catch + decide
 * whether to retry or fall through to direct upload.
 */
export async function uploadViaPublisher(args: UploadViaPublisherArgs): Promise<WalrusUploadResult> {
  if (args.bytes.length === 0) {
    throw new Error('uploadViaPublisher: refusing to upload zero-byte payload');
  }
  if (args.epochs < 1 || args.epochs > 200) {
    throw new Error(`uploadViaPublisher: epochs must be in [1, 200], got ${args.epochs}`);
  }
  const url = `${publisherUrlForNetwork(args.network)}/v1/blobs?epochs=${args.epochs}`;
  const init: RequestInit = {
    method: 'PUT',
    body: args.bytes as BodyInit,
    ...(args.signal ? { signal: args.signal } : {}),
  };
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Walrus publisher returned ${response.status} ${response.statusText}` +
        (body ? `: ${body.slice(0, 200)}` : ''),
    );
  }
  const json = (await response.json()) as unknown;
  const parsed = parsePublisherResponse(json);
  const sha256 = await sha256Bytes(args.bytes);
  return {
    blobId: parsed.blobId,
    sha256,
    sizeBytes: args.bytes.length,
    blobObjectId: parsed.blobObjectId,
    registeredEpoch: parsed.endEpoch ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Internal: response parsing
// ---------------------------------------------------------------------------

interface ParsedPublisherResponse {
  blobId: string;
  blobObjectId: string;
  endEpoch: number | null;
}

function parsePublisherResponse(value: unknown): ParsedPublisherResponse {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Walrus publisher returned a non-object response');
  }
  const record = value as Record<string, unknown>;
  if ('newlyCreated' in record && record.newlyCreated) {
    const newly = record.newlyCreated as Record<string, unknown>;
    const blobObject = newly.blobObject as Record<string, unknown> | undefined;
    return {
      blobId: stringField(blobObject?.['blobId'], 'newlyCreated.blobObject.blobId'),
      blobObjectId: stringField(blobObject?.['id'], 'newlyCreated.blobObject.id'),
      endEpoch: extractEndEpoch(blobObject?.['storage']),
    };
  }
  if ('alreadyCertified' in record && record.alreadyCertified) {
    const ac = record.alreadyCertified as Record<string, unknown>;
    return {
      blobId: stringField(ac['blobId'], 'alreadyCertified.blobId'),
      // `alreadyCertified` doesn't always carry the blob object id —
      // the previous registrant owns the on-chain Blob object. We
      // return empty here; downstream `artifacts::publish` only
      // commits the blob ID + sha256, not the Sui object ref.
      blobObjectId: '',
      endEpoch: numberFieldOrNull(ac['endEpoch']),
    };
  }
  throw new Error(
    'Walrus publisher returned an unexpected response shape (no newlyCreated / alreadyCertified)',
  );
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is missing or not a non-empty string`);
  }
  return value;
}

function numberFieldOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function extractEndEpoch(storage: unknown): number | null {
  if (typeof storage !== 'object' || storage === null) return null;
  const record = storage as Record<string, unknown>;
  return numberFieldOrNull(record['endEpoch']);
}
