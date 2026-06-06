/**
 * Resolve messaging bridge script + construct subprocess client at bootstrap.
 */

import { accessSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RuntimeConfig } from './config.js';
import type { MessagingLike } from './messaging.js';
import { createSubprocessMessagingClient } from './subprocess-messaging.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Default bridge location relative to compiled vault runtime output. */
export function defaultMessagingBridgeScriptPath(): string {
  return join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    'examples',
    'messaging-runtime-bridge',
    'dist',
    'rpc.js',
  );
}

function bridgeScriptExists(path: string): boolean {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a subprocess {@link MessagingLike} when messaging is enabled and the
 * bridge script is present. Returns null when disabled or unavailable.
 */
export function createMessagingClientForRuntime(args: {
  config: RuntimeConfig;
  sessionKey: string;
}): MessagingLike | null {
  if (args.config.messagingEnabled === false) return null;

  const bridgePath = args.config.messagingBridgeScriptPath ?? defaultMessagingBridgeScriptPath();
  if (!bridgeScriptExists(bridgePath)) return null;

  return createSubprocessMessagingClient({
    bridgeScriptPath: bridgePath,
    sessionKey: args.sessionKey,
    fullnodeUrl: args.config.fullnodeUrl,
    network: args.config.walrusNetwork,
  });
}
