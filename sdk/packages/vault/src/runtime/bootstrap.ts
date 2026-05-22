/**
 * Bootstrap helpers for the headless runtime.
 *
 * `bin/run.ts` is intentionally tiny — it parses argv and hands off to
 * `bootstrapConfig()` here, which:
 *
 *   1. Picks a `SecretsProvider` based on the `--secrets-dir` flag
 *      (FileSecretsProvider for Docker/Fly/Railway mounted files) or
 *      defaults to `EnvSecretsProvider` (`process.env`).
 *   2. Resolves the session key + MemWal delegate from the provider.
 *   3. Overlays those values onto `process.env` and hands the merged
 *      env to `loadFromEnv()`, so the rest of the runtime (and existing
 *      AWS Fargate deployments that already inject env via Secrets
 *      Manager) keep working unchanged.
 *
 * This is the seam that moves keys out of long-lived env files and
 * browser localStorage into a real secrets source — without touching
 * any of the downstream call sites.
 */

import { loadFromEnv } from './config.js';
import type { RuntimeConfig } from './config.js';
import {
  EnvSecretsProvider,
  FileSecretsProvider,
  type SecretsProvider,
} from './secrets.js';
import { loadMemwalDelegateFromKeyFile } from './keypair.js';

export interface BootstrapOptions {
  /** Directory of mounted secret files (FileSecretsProvider). */
  secretsDir?: string;
  /** Explicit provider — wins over `secretsDir`. Useful for tests. */
  provider?: SecretsProvider;
  /** Env to merge resolved secrets onto. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** CLI-flag overrides (highest precedence inside env). */
  overrides?: {
    agentId?: string;
    packageId?: string;
    sessionKeyPath?: string;
  };
}

export interface BootstrapResult {
  config: RuntimeConfig;
  /** Which source actually supplied the session key — for log lines. */
  sessionKeySource: 'provider' | 'env' | 'path';
  /** Which source actually supplied the MemWal delegate. */
  memwalDelegateSource: 'provider' | 'env' | 'file' | 'none';
}

export async function bootstrapConfig(
  opts: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const env = { ...(opts.env ?? process.env) };
  const provider: SecretsProvider =
    opts.provider ??
    (opts.secretsDir ? new FileSecretsProvider(opts.secretsDir) : new EnvSecretsProvider(env));

  // Apply CLI overrides first; provider only fills what's still missing.
  if (opts.overrides?.agentId) env.SYNAPSE_AGENT_ID = opts.overrides.agentId;
  if (opts.overrides?.packageId) env.SYNAPSE_PACKAGE_ID = opts.overrides.packageId;
  if (opts.overrides?.sessionKeyPath) env.SYNAPSE_SESSION_KEY_PATH = opts.overrides.sessionKeyPath;

  let sessionKeySource: BootstrapResult['sessionKeySource'];
  if (env.SYNAPSE_SESSION_KEY) {
    sessionKeySource = 'env';
  } else if (env.SYNAPSE_SESSION_KEY_PATH) {
    sessionKeySource = 'path';
  } else {
    const fromProvider = await provider.get('session_key');
    if (fromProvider) {
      env.SYNAPSE_SESSION_KEY = fromProvider;
      sessionKeySource = 'provider';
    } else {
      // Let loadFromEnv throw its canonical error — that way the message
      // stays consistent whether you're running --once locally or on Fargate.
      sessionKeySource = 'env';
    }
  }

  let memwalDelegateSource: BootstrapResult['memwalDelegateSource'];
  if (env.MEMWAL_DELEGATE_KEY || env.SYNAPSE_MEMWAL_DELEGATE_KEY) {
    memwalDelegateSource = 'env';
  } else {
    const fromProvider = await provider.get('memwal_delegate');
    if (fromProvider) {
      env.MEMWAL_DELEGATE_KEY = fromProvider;
      memwalDelegateSource = 'provider';
    } else {
      // The session .key JSON (dashboard download) may bundle
      // `memwalDelegate.privateKeyHex` alongside the session secret.
      // Extract it here so config.memwal is populated from the start
      // instead of deferring to the tick-time fallback in runtime.ts.
      // Best-effort: if the file doesn't exist yet or isn't JSON, we
      // fall through to 'none' — the runtime's tick-time fallback in
      // #tickOnceInner will try again once the session key is loaded.
      let delegateFromKeyJson: string | null = null;
      try {
        const sessionValue = env.SYNAPSE_SESSION_KEY;
        delegateFromKeyJson = sessionValue
          ? await loadMemwalDelegateFromKeyFile({ sessionKeyEnv: sessionValue })
          : env.SYNAPSE_SESSION_KEY_PATH
            ? await loadMemwalDelegateFromKeyFile({ sessionKeyPath: env.SYNAPSE_SESSION_KEY_PATH })
            : null;
      } catch {
        // File not found or unreadable — non-fatal at bootstrap.
      }
      if (delegateFromKeyJson) {
        env.MEMWAL_DELEGATE_KEY = delegateFromKeyJson;
        memwalDelegateSource = 'file';
      } else {
        memwalDelegateSource = 'none';
      }
    }
  }

  const config = loadFromEnv(env);
  return { config, sessionKeySource, memwalDelegateSource };
}
