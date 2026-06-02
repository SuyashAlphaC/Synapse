import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvSecretsProvider, FileSecretsProvider } from '../src/runtime/secrets.js';

describe('EnvSecretsProvider', () => {
  it('reads the session key from SYNAPSE_SESSION_KEY', async () => {
    const provider = new EnvSecretsProvider({ SYNAPSE_SESSION_KEY: 'suiprivkey1abc' });
    expect(await provider.get('session_key')).toBe('suiprivkey1abc');
  });

  it('reads the memwal delegate from MEMWAL_DELEGATE_KEY', async () => {
    const provider = new EnvSecretsProvider({ MEMWAL_DELEGATE_KEY: 'deadbeef' });
    expect(await provider.get('memwal_delegate')).toBe('deadbeef');
  });

  it('returns null when the env var is unset', async () => {
    const provider = new EnvSecretsProvider({});
    expect(await provider.get('session_key')).toBeNull();
  });

  it('trims surrounding whitespace and treats blank as null', async () => {
    expect(await new EnvSecretsProvider({ SYNAPSE_SESSION_KEY: '  k  ' }).get('session_key')).toBe('k');
    expect(await new EnvSecretsProvider({ SYNAPSE_SESSION_KEY: '   ' }).get('session_key')).toBeNull();
  });
});

describe('FileSecretsProvider', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'synapse-secrets-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a secret from <dir>/<name> using the file naming convention', async () => {
    await writeFile(join(dir, 'session-key'), 'suiprivkey1xyz\n');
    const provider = new FileSecretsProvider(dir);
    expect(await provider.get('session_key')).toBe('suiprivkey1xyz');
  });

  it('maps memwal_delegate to the memwal-delegate file', async () => {
    await writeFile(join(dir, 'memwal-delegate'), '064dae\n');
    expect(await new FileSecretsProvider(dir).get('memwal_delegate')).toBe('064dae');
  });

  it('returns null when the secret file is absent', async () => {
    expect(await new FileSecretsProvider(dir).get('session_key')).toBeNull();
  });

  it('reads the anthropic api key from the anthropic-api-key file', async () => {
    await writeFile(join(dir, 'anthropic-api-key'), '  sk-ant-file  \n');
    expect(await new FileSecretsProvider(dir).get('anthropic_api_key')).toBe('sk-ant-file');
  });
});

describe('anthropic_api_key via env', () => {
  it('reads the anthropic api key from ANTHROPIC_API_KEY', async () => {
    const provider = new EnvSecretsProvider({ ANTHROPIC_API_KEY: 'sk-ant-123' });
    expect(await provider.get('anthropic_api_key')).toBe('sk-ant-123');
  });
  it('returns null when ANTHROPIC_API_KEY is unset', async () => {
    expect(await new EnvSecretsProvider({}).get('anthropic_api_key')).toBeNull();
  });
});
