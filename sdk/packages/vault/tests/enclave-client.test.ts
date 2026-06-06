import { describe, it, expect } from 'vitest';
import { requestAttestedDecision, hexToBytes } from '../src/runtime/enclave-client.js';
import type { StrategyInput } from '../src/types.js';

const INPUT = {
  vaultId: '0xvault',
  navUsd: 100,
  currentEpoch: 100n,
  holdings: [],
  market: { prices: { SUI: 1 }, pools: [], asOf: '0' },
  memory: { strategyId: 'dca', counters: {}, facts: [] },
  policy: { spendPerEpochUsd: 1000, expiryEpoch: 1_000_000n, revoked: false, approvedPackages: [] },
} as unknown as StrategyInput;

function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () =>
    ({
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response) as unknown as typeof fetch;
}

const base = {
  enclaveUrl: 'http://enclave:3000/',
  vaultId: '0xvault',
  epoch: 100n,
  blobId: 'blob123',
  codeHashHex: 'aa'.repeat(32),
  network: 'testnet' as const,
  input: INPUT,
};

describe('requestAttestedDecision', () => {
  it('parses the enclave-run decision + hashes', async () => {
    const res = await requestAttestedDecision({
      ...base,
      fetchImpl: fakeFetch({
        decision: JSON.stringify({ kind: 'noop', rationale: 'held' }),
        decision_hash: 'de',
        code_hash: 'aa'.repeat(32),
        inputs_hash: 'ab',
        timestamp_ms: 1744038900000,
        signature: 'cd',
      }),
    });
    expect(res.decision.kind).toBe('noop');
    expect(res.codeHashHex).toBe('aa'.repeat(32));
    expect(res.decisionHashHex).toBe('de');
    expect(res.inputsHashHex).toBe('ab');
    expect(res.signatureHex).toBe('cd');
    expect(res.timestampMs).toBe(1744038900000);
  });

  it('forwards per-vault anthropicApiKey in the POST body (model A)', async () => {
    let capturedBody: string | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          decision: JSON.stringify({ kind: 'noop', rationale: 'held' }),
          decision_hash: 'de',
          code_hash: 'aa'.repeat(32),
          inputs_hash: 'ab',
          timestamp_ms: 1744038900000,
          signature: 'cd',
        }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;

    await requestAttestedDecision({
      ...base,
      anthropicApiKey: 'sk-ant-vault',
      fetchImpl,
    });
    expect(JSON.parse(capturedBody!).anthropicApiKey).toBe('sk-ant-vault');
  });

  it('omits anthropicApiKey when unset', async () => {
    let capturedBody: string | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          decision: JSON.stringify({ kind: 'noop', rationale: 'held' }),
          decision_hash: 'de',
          code_hash: 'aa'.repeat(32),
          inputs_hash: 'ab',
          timestamp_ms: 1744038900000,
          signature: 'cd',
        }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;

    await requestAttestedDecision({ ...base, fetchImpl });
    expect(JSON.parse(capturedBody!).anthropicApiKey).toBeUndefined();
  });

  it('throws on a non-OK response (attested vault must skip, not fall back)', async () => {
    await expect(
      requestAttestedDecision({ ...base, fetchImpl: fakeFetch({ error: 'down' }, false, 503) }),
    ).rejects.toThrow(/enclave \/decide 503/);
  });

  it('throws on a malformed response', async () => {
    await expect(
      requestAttestedDecision({
        ...base,
        fetchImpl: fakeFetch({ decision: 123, timestamp_ms: 1, signature: 'x' }),
      }),
    ).rejects.toThrow(/malformed/);
  });
});

describe('hexToBytes', () => {
  it('decodes hex with and without 0x', () => {
    expect(hexToBytes('0x0a0b0c')).toEqual([10, 11, 12]);
    expect(hexToBytes('ff00')).toEqual([255, 0]);
  });
});
