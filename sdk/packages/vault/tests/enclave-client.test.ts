import { describe, it, expect } from 'vitest';
import { requestAttestedDecision, hexToBytes, type EnclaveAdvisorInput } from '../src/runtime/enclave-client.js';

const INPUT: EnclaveAdvisorInput = {
  baseSymbol: 'SUI',
  quoteSymbol: 'USDC',
  baseWeight: 0.6,
  basePriceUsd: 1.1,
  quotePriceUsd: 1,
  navUsd: 100,
  epoch: 100,
  memoryFacts: [],
};

function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () =>
    ({
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response) as unknown as typeof fetch;
}

describe('requestAttestedDecision', () => {
  it('parses a well-formed signed decision', async () => {
    const res = await requestAttestedDecision({
      enclaveUrl: 'http://enclave:3000/',
      vaultId: '0xvault',
      epoch: 100n,
      input: INPUT,
      fetchImpl: fakeFetch({
        decision: { targetWeightMilli: 500, confidence: 0.8, rationale: 'r', inputsHashHex: 'ab' },
        timestamp_ms: 1744038900000,
        signature: 'cd',
      }),
    });
    expect(res.targetWeightMilli).toBe(500);
    expect(res.inputsHashHex).toBe('ab');
    expect(res.signatureHex).toBe('cd');
    expect(res.timestampMs).toBe(1744038900000);
  });

  it('throws on a non-OK response (attested vault must skip, not fall back)', async () => {
    await expect(
      requestAttestedDecision({
        enclaveUrl: 'http://enclave:3000',
        vaultId: '0xvault',
        epoch: 100n,
        input: INPUT,
        fetchImpl: fakeFetch({ error: 'down' }, false, 503),
      }),
    ).rejects.toThrow(/enclave \/decide 503/);
  });

  it('throws on a malformed decision', async () => {
    await expect(
      requestAttestedDecision({
        enclaveUrl: 'http://enclave:3000',
        vaultId: '0xvault',
        epoch: 100n,
        input: INPUT,
        fetchImpl: fakeFetch({ decision: { targetWeightMilli: 'nope' }, timestamp_ms: 1, signature: 'x' }),
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
