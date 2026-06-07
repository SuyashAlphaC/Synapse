/**
 * Server-side spawn helper for the isolated messaging-runtime-bridge (sui 1.x).
 * Used by dashboard API routes for channel provisioning — never imported in
 * client components.
 */
import 'server-only';

import { spawn } from 'node:child_process';
import { accessSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Repo root from `web/dashboard/lib` → `../../../` */
const REPO_ROOT_FROM_LIB = join(__dirname, '../../..');

const SCRIPT_CANDIDATES = [
  join(REPO_ROOT_FROM_LIB, 'examples/messaging-runtime-bridge/dist/rpc.bundle.mjs'),
  join(REPO_ROOT_FROM_LIB, 'examples/messaging-runtime-bridge/dist/rpc.js'),
] as const;

export function resolveMessagingBridgeScriptPath(): string {
  for (const path of SCRIPT_CANDIDATES) {
    try {
      accessSync(path);
      return path;
    } catch {
      // try next
    }
  }
  throw new Error(
    'messaging-runtime-bridge not built — run npm run build:deploy in examples/messaging-runtime-bridge',
  );
}

export interface MessagingBridgeCallOptions {
  ownerKey?: string;
  sessionKey?: string;
  fullnodeUrl?: string;
  network?: 'testnet' | 'mainnet';
}

export async function callMessagingBridge(
  payload: Record<string, unknown>,
  opts: MessagingBridgeCallOptions = {},
): Promise<unknown> {
  const bridgeScriptPath = resolveMessagingBridgeScriptPath();
  const bridgeRoot = join(bridgeScriptPath, '..', '..');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SUI_FULLNODE_URL: opts.fullnodeUrl ?? process.env.SUI_FULLNODE_URL ?? '',
    SYNAPSE_MESSAGING_NETWORK: opts.network ?? 'testnet',
  };
  if (opts.ownerKey) env.SYNAPSE_OWNER_KEY = opts.ownerKey;
  if (opts.sessionKey) env.SYNAPSE_SESSION_KEY = opts.sessionKey;

  const useBundle = bridgeScriptPath.endsWith('rpc.bundle.mjs');

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridgeScriptPath], {
      env,
      cwd: useBundle ? dirname(bridgeScriptPath) : bridgeRoot,
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
        const parsed = JSON.parse(stdout.trim()) as {
          ok: boolean;
          result?: unknown;
          error?: string;
        };
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
