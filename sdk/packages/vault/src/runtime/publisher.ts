import { Transaction } from '@mysten/sui/transactions';
import type { SuiJsonRpcClient, SuiTransactionBlockResponse } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  createWalrusClient,
  publishArtifactCall,
  uploadBlob,
  buildSynapseSealClient,
  sealEncrypt,
  sealIdForAddress,
  type WalrusUploadResult,
} from '@synapse-core/client';
import type { AuditReport } from '../types.js';
import { uploadViaPublisher } from './walrus-publisher.js';

/**
 * Pattern matches against errors that should trigger the HTTP
 * publisher fallback. Everything that isn't a permanent WAL balance
 * issue is fair game — the publisher's job is to absorb transient
 * pain (consensus, network, DNS) that the direct path can't.
 *
 * The one thing we explicitly DON'T fall through on: "insufficient
 * balance" errors. Those mean WAL is exhausted on the caller — the
 * publisher would charge the same to its own balance, so falling
 * back hides the real problem. Better to surface it cleanly.
 */
function isTransientWalrusError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (lower.includes('insufficient balance')) return false;
  return (
    lower.includes('too many failures') ||
    lower.includes('too many invalid confirmations') ||
    lower.includes('fetch failed') ||
    lower.includes('network') ||
    lower.includes('timeout') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('etimedout') ||
    lower.includes('econnreset') ||
    lower.includes('socket hang up')
  );
}

export interface PublishReportArgs {
  suiClient: SuiJsonRpcClient;
  walrusNetwork: 'testnet' | 'mainnet';
  signer: Ed25519Keypair;
  packageId: string;
  agentId: string;
  report: AuditReport;
  epochs: number;
}

export interface PublishReportResult {
  walrusBlobId: string;
  walrusObjectId: string;
  artifactSlot: bigint;
  txDigest: string;
}

export interface SealUploadOptions {
  /** First-version `synapse_seal` package ID (the seal_approve namespace). */
  packageId: string;
  /** Optional key-server object-id override. */
  keyServerObjectIds?: readonly string[];
}

export async function uploadReportBlob(args: {
  suiClient: SuiJsonRpcClient;
  walrusNetwork: 'testnet' | 'mainnet';
  signer: Ed25519Keypair;
  report: AuditReport;
  epochs: number;
  /**
   * When present, the report is Seal-encrypted before upload. The Seal
   * identity is prefixed with the signer (session) address, so only that
   * key can later decrypt it via `synapse_seal::policy::seal_approve`.
   */
  seal?: SealUploadOptions;
}): Promise<WalrusUploadResult> {
  const plaintext = new TextEncoder().encode(args.report.markdown);
  const payload = args.seal ? await sealEncryptReport(args, plaintext) : plaintext;

  // In the browser, skip the @mysten/walrus direct path entirely.
  // That SDK loads a Node/WASM binary (walrus_wasm_bg.wasm) at
  // client construction, which isn't served in the dashboard bundle
  // and throws "Failed to fetch" — aborting the whole tick. The HTTP
  // publisher is plain `fetch` with no WASM, so it's the only viable
  // path in-browser (and is more reliable on testnet anyway).
  const isBrowser =
    typeof window !== 'undefined' || typeof (globalThis as { document?: unknown }).document !== 'undefined';
  if (isBrowser) {
    return uploadViaPublisher({
      bytes: payload,
      network: args.walrusNetwork,
      epochs: args.epochs,
    });
  }

  // Path 1 (Node): direct write via @mysten/walrus SDK. Cheaper
  // (caller's session pays storage), preserves caller sovereignty (no
  // third-party publisher in the trust chain), works on mainnet. On
  // testnet the storage-node quorum is unreliable — every few
  // attempts fails with "Too many failures while writing blob …".
  // `createWalrusClient` is INSIDE the try because it can throw at
  // construction (WASM init) — we want that to fall through to the
  // publisher, not abort the tick.
  try {
    const walrus = createWalrusClient({
      network: args.walrusNetwork,
      suiClient: args.suiClient,
    });
    return await uploadBlob({
      walrus,
      signer: args.signer,
      payload,
      epochs: args.epochs,
      deletable: false,
      attributes: {
        'synapse.report.plan_id': args.report.planId,
        'synapse.report.strategy_id': args.report.strategyId,
        'synapse.report.vault_id': args.report.vaultId,
      },
    });
  } catch (err) {
    // Path 2: HTTP publisher fallback. Triggered only on transient
    // storage-node failures (we don't want to fall through on real
    // problems like insufficient WAL — those should surface up).
    // The publisher handles fan-out + retries server-side and is
    // far more reliable on testnet. Drawback: publisher pays storage
    // (caller pays nothing for WAL) and is a centralized service —
    // both acceptable trade-offs for "every tick on Walrus" demos
    // and for testnet operation.
    if (!isTransientWalrusError(err)) throw err;
    return uploadViaPublisher({
      bytes: payload,
      network: args.walrusNetwork,
      epochs: args.epochs,
    });
  }
}

/**
 * Seal-encrypt a report under an address-prefixed identity. Encryption only
 * needs the key-server public keys + namespace package (no on-chain call), so
 * this works the moment `synapse_seal` is published.
 */
async function sealEncryptReport(
  args: {
    suiClient: SuiJsonRpcClient;
    signer: Ed25519Keypair;
    report: AuditReport;
    seal?: SealUploadOptions;
  },
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const seal = args.seal;
  if (!seal) return plaintext;
  const client = buildSynapseSealClient({
    suiClient: args.suiClient,
    ...(seal.keyServerObjectIds ? { keyServerObjectIds: seal.keyServerObjectIds } : {}),
  });
  const id = sealIdForAddress(
    args.signer.toSuiAddress(),
    new TextEncoder().encode(args.report.planId),
  );
  return sealEncrypt(client, { payload: plaintext, packageId: seal.packageId, id });
}

export async function publishReport(args: PublishReportArgs): Promise<PublishReportResult> {
  const upload = await uploadReportBlob(args);
  const tx = new Transaction();
  publishArtifactCall(tx, args.packageId, {
    agentId: args.agentId,
    walrusBlobId: new TextEncoder().encode(upload.blobId),
    sha256: upload.sha256,
    mimeType: 'text/markdown',
    sizeBytes: BigInt(upload.sizeBytes),
    sealEncrypted: false,
    label: `audit-${args.report.planId}`,
  });

  const result = await args.suiClient.signAndExecuteTransaction({
    transaction: tx,
    signer: args.signer,
    options: { showEvents: true, showEffects: true },
  });
  await args.suiClient.waitForTransaction({ digest: result.digest });
  return {
    walrusBlobId: upload.blobId,
    walrusObjectId: upload.blobObjectId,
    artifactSlot: parseArtifactSlot(result),
    txDigest: result.digest,
  };
}

export function parseArtifactSlot(tx: SuiTransactionBlockResponse): bigint {
  for (const event of tx.events ?? []) {
    if (!event.type.includes('::artifacts::ArtifactPublishedEvent')) continue;
    const parsed = event.parsedJson;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const slot = (parsed as Record<string, unknown>).artifact_slot;
    if (typeof slot === 'string' || typeof slot === 'number') return BigInt(slot);
  }
  throw new Error(`Transaction ${tx.digest}: ArtifactPublishedEvent not found`);
}
