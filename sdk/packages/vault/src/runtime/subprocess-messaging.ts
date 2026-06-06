/**
 * Subprocess-backed {@link MessagingLike} client.
 *
 * Spawns `examples/messaging-runtime-bridge/dist/rpc.js` (sui 1.x isolated)
 * so the vault runtime never imports `@mysten/messaging` directly.
 */

import { spawn } from 'node:child_process';
import type { MessagingLike, EncryptedSymmetricKeyLike } from './messaging.js';

export interface SubprocessMessagingOptions {
  /** Absolute path to messaging-runtime-bridge/dist/rpc.js */
  bridgeScriptPath: string;
  /** Session secret forwarded as SYNAPSE_SESSION_KEY to the child. */
  sessionKey: string;
  /** JSON-RPC URL for the child (SUI_FULLNODE_URL). */
  fullnodeUrl: string;
  /** testnet | mainnet */
  network: 'testnet' | 'mainnet';
}

async function rpcCall(
  opts: SubprocessMessagingOptions,
  payload: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [opts.bridgeScriptPath], {
      env: {
        ...process.env,
        SYNAPSE_SESSION_KEY: opts.sessionKey,
        SUI_FULLNODE_URL: opts.fullnodeUrl,
        SYNAPSE_MESSAGING_NETWORK: opts.network,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `messaging bridge exited ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as { ok: boolean; result?: unknown; error?: string };
        if (!parsed.ok) {
          reject(new Error(parsed.error ?? 'messaging bridge error'));
          return;
        }
        resolve(parsed.result);
      } catch (err) {
        reject(
          new Error(
            `messaging bridge invalid JSON: ${stdout.slice(0, 200)} (${err instanceof Error ? err.message : String(err)})`,
          ),
        );
      }
    });

    child.stdin.write(`${JSON.stringify(payload)}\n`);
    child.stdin.end();
  });
}

export function createSubprocessMessagingClient(
  opts: SubprocessMessagingOptions,
): MessagingLike {
  const call = (payload: Record<string, unknown>) => rpcCall(opts, payload);

  return {
    messaging: {
      async getChannelMessages(req) {
        const res = (await call({
          op: 'getChannelMessages',
          channelId: req.channelId,
          userAddress: req.userAddress,
          cursor: req.cursor === null || req.cursor === undefined ? null : req.cursor.toString(),
          ...(req.limit ? { limit: req.limit } : {}),
        })) as {
          messages: { text: string; sender: string; createdAtMs: string }[];
          cursor: string | null;
          hasNextPage: boolean;
        };
        return {
          messages: res.messages,
          cursor: res.cursor === null ? null : BigInt(res.cursor),
          hasNextPage: res.hasNextPage,
        };
      },
      async getUserMemberCap(userAddress, channelId) {
        return (await call({
          op: 'getUserMemberCap',
          userAddress,
          channelId,
        })) as { id: { id: string } } | null;
      },
      async getChannelObjectsByChannelIds(req) {
        const rows = (await call({
          op: 'getChannelObjectsByChannelIds',
          channelIds: req.channelIds,
          userAddress: req.userAddress,
        })) as {
          encryption_key_history: { latest: number[]; latest_version: number };
        }[];
        return rows.map((row) => ({
          encryption_key_history: {
            latest: row.encryption_key_history.latest,
            latest_version: row.encryption_key_history.latest_version,
          },
        }));
      },
      async executeSendMessageTransaction(req) {
        const encryptedKey = req.encryptedKey as EncryptedSymmetricKeyLike;
        const res = (await call({
          op: 'executeSendMessageTransaction',
          channelId: req.channelId,
          memberCapId: req.memberCapId,
          message: req.message,
          encryptedKey: {
            encryptedBytes: Array.from(encryptedKey.encryptedBytes),
            version: encryptedKey.version,
          },
        })) as { digest: string };
        return { digest: res.digest };
      },
    },
  };
}
