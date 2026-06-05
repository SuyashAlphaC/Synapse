/**
 * Runtime client for the strategy-agnostic Synapse decision enclave.
 *
 * For an attested vault, the runtime sends the vault's hired strategy (its Walrus
 * blob id + on-chain code_hash) plus the full `StrategyInput` to the enclave. The
 * enclave fetches + hash-verifies + RUNS that exact strategy bundle inside the
 * TEE, then returns the decision it produced + a secp256k1 signature over
 * (code_hash ‖ decision_hash ‖ inputs_hash). The runtime executes the returned
 * decision and attaches the signature to the rebalance PTB, where the Move gate
 * verifies it — and that the code_hash matches the registered strategy.
 *
 * Failures are surfaced (not swallowed): an attested vault that can't reach its
 * enclave must skip the tick, never fall back to an unattested trade.
 */

import type { StrategyDecision, StrategyInput } from '../types.js';

export interface AttestedDecision {
  /** The decision the enclave's strategy run produced — executed by the runtime. */
  decision: StrategyDecision;
  /** sha256 of the strategy bundle the enclave ran, hex (== on-chain code_hash). */
  codeHashHex: string;
  /** sha256 of the canonical decision, hex. */
  decisionHashHex: string;
  /** sha256 of the inputs the strategy reasoned over, hex. */
  inputsHashHex: string;
  /** Enclave timestamp (ms) that was part of the signed message. */
  timestampMs: number;
  /** secp256k1 compact signature (64 bytes), hex. */
  signatureHex: string;
}

export interface RequestAttestedDecisionArgs {
  enclaveUrl: string;
  vaultId: string;
  epoch: bigint;
  /** Walrus blob id of the hired strategy bundle. */
  blobId: string;
  /** On-chain code_hash of the hired strategy, hex (64 chars). */
  codeHashHex: string;
  network: 'testnet' | 'mainnet';
  input: StrategyInput;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** JSON codec shared with the enclave: bigints ↔ { "$bigint": "123" }. */
function replaceBigints(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? { $bigint: v.toString() } : v;
}
function reviveBigints(_k: string, v: unknown): unknown {
  if (v && typeof v === 'object' && '$bigint' in v && typeof (v as { $bigint: unknown }).$bigint === 'string') {
    return BigInt((v as { $bigint: string }).$bigint);
  }
  return v;
}

/**
 * Ask the enclave to run the hired strategy + sign the decision. Throws on
 * transport/HTTP error or a malformed response — the caller treats that as a
 * skipped tick.
 */
export async function requestAttestedDecision(
  args: RequestAttestedDecisionArgs,
): Promise<AttestedDecision> {
  const doFetch = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 60_000);
  try {
    const inputJson = JSON.stringify(args.input, replaceBigints);
    const res = await doFetch(`${stripSlash(args.enclaveUrl)}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vaultId: args.vaultId,
        epoch: Number(args.epoch),
        codeHashHex: args.codeHashHex,
        blobId: args.blobId,
        network: args.network,
        inputJson,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`enclave /decide ${res.status}: ${(await safeText(res)).slice(0, 200)}`);
    }
    const body = (await res.json()) as {
      decision?: string;
      decision_hash?: string;
      code_hash?: string;
      inputs_hash?: string;
      timestamp_ms?: number;
      signature?: string;
    };
    if (
      typeof body.decision !== 'string' ||
      typeof body.decision_hash !== 'string' ||
      typeof body.code_hash !== 'string' ||
      typeof body.inputs_hash !== 'string' ||
      typeof body.timestamp_ms !== 'number' ||
      typeof body.signature !== 'string'
    ) {
      throw new Error('enclave /decide returned a malformed response');
    }
    const decision = JSON.parse(body.decision, reviveBigints) as StrategyDecision;
    return {
      decision,
      codeHashHex: body.code_hash,
      decisionHashHex: body.decision_hash,
      inputsHashHex: body.inputs_hash,
      timestampMs: body.timestamp_ms,
      signatureHex: body.signature,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Convert a hex string (optionally 0x-prefixed) to a byte array for PTB args. */
export function hexToBytes(hex: string): number[] {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

function stripSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
