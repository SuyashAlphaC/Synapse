/**
 * Server-side spawn helper for the isolated messaging-runtime-bridge (sui 1.x).
 * Used by dashboard API routes for channel provisioning — never imported in
 * client components.
 *
 * On Vercel we spawn the esbuild bundle (`rpc.bundle.mjs`, self-contained).
 * Locally / in Docker we prefer the bundle when present, else fall back to
 * `dist/rpc.js` + package node_modules.
 */

import { spawn } from 'node:child_process';
import { accessSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BRIDGE_REL = join('examples', 'messaging-runtime-bridge', 'dist');
const SCRIPT_CANDIDATES = ['rpc.bundle.mjs', 'rpc.js'] as const;

function repoRootCandidates(): string[] {
  const cwd = process.cwd();
  return [
    cwd,
    join(cwd, '..'),
    join(cwd, '..', '..'),
    join(cwd, '..', '..', '..'),
    process.env.LAMBDA_TASK_ROOT ?? '',
    process.env.VERCEL ? '/var/task' : '',
  ].filter(Boolean);
}

export function resolveMessagingBridgeScriptPath(): string {
  for (const root of repoRootCandidates()) {
    for (const script of SCRIPT_CANDIDATES) {
      const path = join(root, BRIDGE_REL, script);
      try {
        accessSync(path);
        return path;
      } catch {
        // try next
      }
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
