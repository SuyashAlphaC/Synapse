/**
 * Bootstrap: the seam that turns a SecretsProvider + env into a
 * RuntimeConfig the rest of the runtime consumes. The provider is the
 * "real production secret source"; env stays as the fallback so
 * existing Fargate deployments (env injected from Secrets Manager)
 * keep working unchanged.
 */
import { describe, it, expect } from 'vitest';
import { bootstrapConfig } from '../src/runtime/bootstrap.js';
import type { SecretsProvider, SecretName } from '../src/runtime/secrets.js';

const PACKAGE_ID = '0x' + 'a'.repeat(64);
const AGENT_ID = '0x' + 'b'.repeat(64);
const SESSION_FROM_PROVIDER = 'suiprivkey1qzfromprovider';
const SESSION_FROM_ENV = 'suiprivkey1qzfromenv';

function fakeProvider(values: Partial<Record<SecretName, string>>): SecretsProvider {
  return {
    async get(name) {
      return values[name] ?? null;
    },
  };
}

function baseEnv(): NodeJS.ProcessEnv {
  return {
    SYNAPSE_PACKAGE_ID: PACKAGE_ID,
    SYNAPSE_AGENT_ID: AGENT_ID,
  } as NodeJS.ProcessEnv;
}

describe('bootstrapConfig — session key resolution', () => {
  it('prefers SYNAPSE_SESSION_KEY when set (back-compat with Fargate env)', async () => {
    const result = await bootstrapConfig({
      env: { ...baseEnv(), SYNAPSE_SESSION_KEY: SESSION_FROM_ENV },
      provider: fakeProvider({ session_key: SESSION_FROM_PROVIDER }),
    });
    expect(result.sessionKeySource).toBe('env');
    expect(result.config.sessionKeyEnv).toBe(SESSION_FROM_ENV);
  });

  it('falls back to the provider when no env / path is set', async () => {
    const result = await bootstrapConfig({
      env: baseEnv(),
      provider: fakeProvider({ session_key: SESSION_FROM_PROVIDER }),
    });
    expect(result.sessionKeySource).toBe('provider');
    expect(result.config.sessionKeyEnv).toBe(SESSION_FROM_PROVIDER);
  });

  it('respects --session-key-path overrides without touching provider', async () => {
    const result = await bootstrapConfig({
      env: baseEnv(),
      overrides: { sessionKeyPath: '/tmp/session.key' },
      provider: fakeProvider({ session_key: SESSION_FROM_PROVIDER }),
    });
    expect(result.sessionKeySource).toBe('path');
    expect(result.config.sessionKeyPath).toBe('/tmp/session.key');
  });

  it('lets loadFromEnv throw its canonical error when neither env nor provider supplies a key', async () => {
    await expect(
      bootstrapConfig({
        env: baseEnv(),
        provider: fakeProvider({}),
      }),
    ).rejects.toThrow(/SYNAPSE_SESSION_KEY/);
  });
});

describe('bootstrapConfig — MemWal delegate resolution', () => {
  it('uses env-provided delegate when present', async () => {
    const result = await bootstrapConfig({
      env: { ...baseEnv(), SYNAPSE_SESSION_KEY: SESSION_FROM_ENV, MEMWAL_DELEGATE_KEY: 'deadbeef' },
      provider: fakeProvider({ memwal_delegate: 'fromprovider' }),
    });
    expect(result.memwalDelegateSource).toBe('env');
    expect(result.config.memwal?.delegateKeyHex).toBe('deadbeef');
  });

  it('falls back to the provider when env has no delegate', async () => {
    const result = await bootstrapConfig({
      env: { ...baseEnv(), SYNAPSE_SESSION_KEY: SESSION_FROM_ENV },
      provider: fakeProvider({ memwal_delegate: 'fromprovider' }),
    });
    expect(result.memwalDelegateSource).toBe('provider');
    expect(result.config.memwal?.delegateKeyHex).toBe('fromprovider');
  });

  it('reports "none" when no delegate is configured anywhere', async () => {
    const result = await bootstrapConfig({
      env: { ...baseEnv(), SYNAPSE_SESSION_KEY: SESSION_FROM_ENV },
      provider: fakeProvider({}),
    });
    expect(result.memwalDelegateSource).toBe('none');
    expect(result.config.memwal).toBeUndefined();
  });
});
