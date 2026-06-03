import { describe, expect, it } from 'vitest';
import { fromBase64 } from '@mysten/sui/utils';
import { generateSessionKey, restoreSessionKey } from './session-key.js';

describe('session key', () => {
  it('generates a 32-byte base64 secret', () => {
    const sk = generateSessionKey();
    expect(fromBase64(sk.secretBase64).length).toBe(32);
  });

  it('round-trips generate -> restore preserving address + keypair', () => {
    const sk = generateSessionKey();
    const restored = restoreSessionKey(sk.secretBase64);
    expect(restored.address).toBe(sk.address);
    expect(restored.address).toBe(sk.keypair.toSuiAddress());
    expect(restored.secretBase64).toBe(sk.secretBase64);
    // The restored keypair must derive the same on-chain session_addr.
    expect(restored.keypair.toSuiAddress()).toBe(sk.keypair.toSuiAddress());
  });

  it('rejects a malformed (non 32-byte) secret', () => {
    expect(() => restoreSessionKey('AAAA')).toThrow();
  });
});
