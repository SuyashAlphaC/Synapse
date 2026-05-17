/**
 * Browser-side Walrus publisher client.
 *
 * Wraps the public Walrus HTTP publisher API
 * (`PUT /v1/blobs?epochs=N`) so the dashboard can upload arbitrary
 * bytes (strategy bundles, audit reports, anything) directly from a
 * connected user's browser without a Node-side relay or wallet
 * keypair access.
 *
 * The publisher returns one of two response shapes:
 *  - `newlyCreated` — first upload of these content-addressed bytes
 *  - `alreadyCertified` — same sha256 was already stored by someone
 *    earlier; the publisher returns the existing blob id and we reuse
 *    it (no extra WAL spent, no duplicate work).
 */
import { aggregatorUrlForNetwork } from './artifacts-client';

export type WalrusNetwork = 'mainnet' | 'testnet';

const WALRUS_TESTNET_PUBLISHER = 'https://publisher.walrus-testnet.walrus.space';
const WALRUS_MAINNET_PUBLISHER = 'https://publisher.walrus-mainnet.walrus.space';

export function publisherUrlForNetwork(network: WalrusNetwork): string {
  return network === 'mainnet' ? WALRUS_MAINNET_PUBLISHER : WALRUS_TESTNET_PUBLISHER;
}

export interface WalrusUploadResult {
  blobId: string;
  /** True when the publisher recognized the sha256 and reused an existing blob. */
  alreadyCertified: boolean;
  /** Number of bytes that landed on Walrus. */
  sizeBytes: number;
  /** sha256(bytes), lowercase hex, no `0x` prefix. */
  sha256Hex: string;
  /** End epoch reported by the publisher (storage lifetime). */
  endEpoch: number | null;
  /** Verifying aggregator URL anyone can use to download the blob. */
  publicUrl: string;
}

/**
 * Upload `bytes` to Walrus via the public testnet/mainnet publisher.
 *
 * Storage is paid by whoever runs the publisher (it's a public good).
 * Anyone with the returned `blobId` can fetch the content via the
 * aggregator. The blob is content-addressed: re-uploading the same
 * bytes is idempotent.
 */
export async function publishToWalrus(args: {
  bytes: Uint8Array;
  network: WalrusNetwork;
  epochs: number;
  signal?: AbortSignal;
}): Promise<WalrusUploadResult> {
  if (args.bytes.length === 0) {
    throw new Error('publishToWalrus: refusing to upload zero-byte payload');
  }
  if (args.epochs < 1 || args.epochs > 200) {
    throw new Error(`publishToWalrus: epochs must be in [1, 200], got ${args.epochs}`);
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
  const sha256Hex = await computeSha256Hex(args.bytes);
  return {
    blobId: parsed.blobId,
    alreadyCertified: parsed.alreadyCertified,
    sizeBytes: args.bytes.length,
    sha256Hex,
    endEpoch: parsed.endEpoch,
    publicUrl: `${aggregatorUrlForNetwork(args.network)}/v1/blobs/${parsed.blobId}`,
  };
}

export async function computeSha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Internal: response parsing
// ---------------------------------------------------------------------------

interface ParsedPublisherResponse {
  blobId: string;
  alreadyCertified: boolean;
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
    const blobId = stringField(blobObject?.['blobId'], 'newlyCreated.blobObject.blobId');
    const endEpoch = numberFieldOrNull(blobObject?.['storage'], 'storage');
    return {
      blobId,
      alreadyCertified: false,
      endEpoch: extractEndEpoch(blobObject?.['storage']) ?? endEpoch,
    };
  }
  if ('alreadyCertified' in record && record.alreadyCertified) {
    const ac = record.alreadyCertified as Record<string, unknown>;
    const blobId = stringField(ac['blobId'], 'alreadyCertified.blobId');
    const endEpoch = numberFieldOrNull(ac['endEpoch'], 'alreadyCertified.endEpoch');
    return { blobId, alreadyCertified: true, endEpoch };
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

function numberFieldOrNull(value: unknown, _label: string): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

function extractEndEpoch(storage: unknown): number | null {
  if (typeof storage !== 'object' || storage === null) return null;
  const record = storage as Record<string, unknown>;
  return numberFieldOrNull(record['endEpoch'], 'storage.endEpoch');
}
