import {
  createMemWalClientFromParts,
  recall,
  type RecallResult,
} from '@synapse-core/memwal-bridge';
// walrus-free subpath — the vault root barrel pulls @mysten/walrus (WASM).
import { loadMemwalDelegateFromKeyFile } from '@synapse-core/vault/keypair';

export type { RecallResult } from '@synapse-core/memwal-bridge';

export interface RecallVaultMemoryArgs {
  /** `AgentIdentity.memwalAccountId` bytes from the live on-chain state. */
  memwalAccountId: Uint8Array;
  /** `AgentIdentity.memwalNamespace` bytes from the live on-chain state. */
  memwalNamespace: Uint8Array;
  /** Raw contents of the vault's `.key` file (bundles the MemWal delegate). */
  keyFileContents: string;
  query: string;
  limit?: number;
}

/**
 * Recall a vault's MemWal memories from the browser.
 *
 * The delegate key is read from the `.key` file in-memory and never leaves
 * the tab. The relayer is reached through the same-origin `/api/memwal-proxy`
 * route because the public relayer sends no CORS headers (the proxy relays
 * server-side, preserving the request signature). Returns the top-K
 * semantically-matched memories, decrypted server-side via the delegate's
 * SEAL session.
 */
export async function recallVaultMemory(args: RecallVaultMemoryArgs): Promise<RecallResult> {
  const delegateKeyHex = await loadMemwalDelegateFromKeyFile({
    sessionKeyEnv: args.keyFileContents,
  });
  if (!delegateKeyHex) {
    throw new Error(
      'This .key file has no MemWal delegate (memwalDelegate.privateKeyHex). ' +
        'Use the .key downloaded when the vault was minted with MemWal enabled.',
    );
  }
  const client = createMemWalClientFromParts({
    memwalAccountId: args.memwalAccountId,
    memwalNamespace: args.memwalNamespace,
    delegateKeyHex,
    serverUrl: '/api/memwal-proxy',
  });
  try {
    return await recall({ client, query: args.query, limit: args.limit ?? 8 });
  } finally {
    client.destroy();
  }
}
