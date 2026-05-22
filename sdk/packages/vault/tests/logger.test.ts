/**
 * Redaction guarantees for the runtime logger.
 *
 * Two layers of defence are tested: field-name match (`sessionKey: …`)
 * and value-shape match (`suiprivkey…`, 64-char hex). Both fire under
 * pino's serialization so a misplaced `logger.info({ sessionKey })`
 * can never leak — even if the field name is something innocuous.
 */
import { describe, it, expect } from 'vitest';
import { redactBindings } from '../src/runtime/logger.js';

describe('redactBindings — field-name match', () => {
  it('redacts sessionKey, secretBase64, delegateKeyHex regardless of casing', () => {
    const input = {
      sessionKey: 'topsecret',
      secretBase64: 'AAAA',
      delegateKeyHex: '0xdeadbeef',
      apiKey: 'sk_live',
      Authorization: 'Bearer xyz',
      memwalDelegate: 'something',
    };
    const out = redactBindings(input) as Record<string, unknown>;
    expect(out.sessionKey).toBe('[REDACTED]');
    expect(out.secretBase64).toBe('[REDACTED]');
    expect(out.delegateKeyHex).toBe('[REDACTED]');
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.Authorization).toBe('[REDACTED]');
    expect(out.memwalDelegate).toBe('[REDACTED]');
  });

  it('leaves ordinary fields untouched', () => {
    const out = redactBindings({ txDigest: 'abc', count: 7, ok: true }) as Record<string, unknown>;
    expect(out).toEqual({ txDigest: 'abc', count: 7, ok: true });
  });

  it('does not redact metadata fields that merely describe a secret', () => {
    // These appear in routine startup logs — leak only metadata, never
    // the secret bytes. Field-name match must be precise enough to keep
    // them visible.
    const out = redactBindings({
      sessionKeySource: 'provider',
      sessionKeyPath: '/run/secrets/session-key',
      memwalDelegateSource: 'env',
      apiKeyHint: 'sk_***',
    }) as Record<string, unknown>;
    expect(out.sessionKeySource).toBe('provider');
    expect(out.sessionKeyPath).toBe('/run/secrets/session-key');
    expect(out.memwalDelegateSource).toBe('env');
    expect(out.apiKeyHint).toBe('sk_***');
  });

  it('recurses into nested objects and arrays', () => {
    const out = redactBindings({
      outer: { sessionKey: 'leak', safe: 'ok' },
      list: [{ delegateKeyHex: 'leak2' }, { fine: 'yes' }],
    }) as Record<string, { sessionKey?: string; safe?: string } | Array<Record<string, string>>>;
    const outer = out.outer as { sessionKey: string; safe: string };
    const list = out.list as Array<Record<string, string>>;
    expect(outer.sessionKey).toBe('[REDACTED]');
    expect(outer.safe).toBe('ok');
    expect(list[0]!.delegateKeyHex).toBe('[REDACTED]');
    expect(list[1]!.fine).toBe('yes');
  });
});

describe('redactBindings — value-shape match', () => {
  it('redacts suiprivkey strings even under innocuous field names', () => {
    const fake = 'suiprivkey1qz' + 'a'.repeat(60);
    const out = redactBindings({ note: fake, value: `wrapped: ${fake} end` }) as Record<
      string,
      string
    >;
    expect(out.note).toBe('[REDACTED:suiprivkey]');
    // value-shape redaction returns the marker — we never want to print
    // the secret, not even partial.
    expect(out.value).toBe('[REDACTED:suiprivkey]');
  });

  it('redacts plain 64-char hex strings (MemWal delegate shape)', () => {
    const hex = 'a'.repeat(64);
    const out = redactBindings({ note: hex }) as Record<string, string>;
    expect(out.note).toBe('[REDACTED:hex64]');
  });

  it('does not over-redact short hex or unrelated strings', () => {
    const out = redactBindings({
      txDigest: '0xabc123',
      shortHex: 'abcd1234',
      msg: 'rebalance ok',
    }) as Record<string, string>;
    expect(out.txDigest).toBe('0xabc123');
    expect(out.shortHex).toBe('abcd1234');
    expect(out.msg).toBe('rebalance ok');
  });
});
