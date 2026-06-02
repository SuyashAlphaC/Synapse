/**
 * Runtime client for the Synapse decision enclave (Nautilus via Marlin Oyster).
 *
 * When a vault is configured for attested execution, the runtime asks the
 * enclave for the decision instead of computing it locally. The enclave returns
 * the target weight plus a secp256k1 signature over the BCS-serialized
 * `DecisionPayload`; the runtime attaches that signature to the rebalance PTB,
 * where `synapse_core::decision_attestation::attest_decision` verifies it on-chain
 * before the swap executes.
 *
 * Failures here are surfaced to the caller (not swallowed): an attested vault
 * that can't reach its enclave must NOT silently fall back to an unattested
 * trade — it should skip the tick.
 */

/** Inputs the enclave reasons over. Hashed inside the enclave; the host can't forge the signed decision. */
export interface EnclaveAdvisorInput {
  baseSymbol: string;
  quoteSymbol: string;
  baseWeight: number;
  basePriceUsd: number;
  quotePriceUsd: number;
  navUsd: number;
  epoch: number;
  memoryFacts: string[];
}

export interface AttestedDecision {
  /** Target base-asset weight × 1000 (0..=1000) — feeds the rebalancer AND the on-chain check. */
  targetWeightMilli: number;
  confidence: number;
  rationale: string;
  /** sha256 of the advisor inputs, hex — the enclave signed over this. */
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
  input: EnclaveAdvisorInput;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Ask the enclave for a signed decision. Throws on transport/HTTP error or a
 * malformed response — the caller treats that as a skipped tick.
 */
export async function requestAttestedDecision(
  args: RequestAttestedDecisionArgs,
): Promise<AttestedDecision> {
  const doFetch = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 30_000);
  try {
    const res = await doFetch(`${stripSlash(args.enclaveUrl)}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        vaultId: args.vaultId,
        epoch: Number(args.epoch),
        input: args.input,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`enclave /decide ${res.status}: ${(await safeText(res)).slice(0, 200)}`);
    }
    const body = (await res.json()) as {
      decision?: { targetWeightMilli?: number; confidence?: number; rationale?: string; inputsHashHex?: string };
      timestamp_ms?: number;
      signature?: string;
    };
    const d = body.decision;
    if (
      !d ||
      typeof d.targetWeightMilli !== 'number' ||
      typeof d.inputsHashHex !== 'string' ||
      typeof body.timestamp_ms !== 'number' ||
      typeof body.signature !== 'string'
    ) {
      throw new Error('enclave /decide returned a malformed decision');
    }
    return {
      targetWeightMilli: d.targetWeightMilli,
      confidence: typeof d.confidence === 'number' ? d.confidence : 0,
      rationale: typeof d.rationale === 'string' ? d.rationale : '',
      inputsHashHex: d.inputsHashHex,
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
