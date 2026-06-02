/**
 * Pluggable secret resolution for the headless runtime.
 *
 * The runtime needs two secrets — the vault session key and (optionally)
 * the MemWal delegate key. In the browser these arrive directly from the
 * `.key` file; on a server they must come from a real secrets source, not
 * a file checked into the image or an env var printed in logs.
 *
 * `SecretsProvider` is the seam: `EnvSecretsProvider` and
 * `FileSecretsProvider` cover local/dev and every container host
 * (Docker/Fly/Railway mount secrets as files under a directory). A cloud
 * provider (AWS Secrets Manager, Vault) is a future implementation of the
 * same interface — it does not change any call site.
 */

export type SecretName = 'session_key' | 'memwal_delegate' | 'anthropic_api_key';

export interface SecretsProvider {
  /** Resolve a named secret, or `null` when it isn't configured. */
  get(name: SecretName): Promise<string | null>;
}

/** Env var that backs each secret in `EnvSecretsProvider`. */
const ENV_VAR_BY_SECRET: Record<SecretName, string> = {
  session_key: 'SYNAPSE_SESSION_KEY',
  memwal_delegate: 'MEMWAL_DELEGATE_KEY',
  anthropic_api_key: 'ANTHROPIC_API_KEY',
};

/** Resolves secrets from environment variables (local/dev default). */
export class EnvSecretsProvider implements SecretsProvider {
  readonly #env: Record<string, string | undefined>;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.#env = env;
  }

  async get(name: SecretName): Promise<string | null> {
    const raw = this.#env[ENV_VAR_BY_SECRET[name]];
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
  }
}

/** Filename that backs each secret in `FileSecretsProvider`. */
const FILE_NAME_BY_SECRET: Record<SecretName, string> = {
  session_key: 'session-key',
  memwal_delegate: 'memwal-delegate',
  anthropic_api_key: 'anthropic-api-key',
};

/**
 * Resolves secrets from files under a directory — the convention every
 * container host uses (Docker secrets at `/run/secrets`, Fly/Railway
 * mounted files). The secret value is the file's trimmed contents.
 */
export class FileSecretsProvider implements SecretsProvider {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async get(name: SecretName): Promise<string | null> {
    // Dynamic import keeps node:fs out of any browser bundle that pulls
    // in the runtime barrel (the browser path never uses this provider).
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const path = join(this.#dir, FILE_NAME_BY_SECRET[name]);
    try {
      const value = (await readFile(path, 'utf8')).trim();
      return value.length > 0 ? value : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
}
