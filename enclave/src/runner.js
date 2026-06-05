// Generic strategy runner — the heart of the strategy-agnostic enclave.
//
// Given a Walrus blob id + the on-chain code_hash, this fetches the strategy
// bundle, verifies its sha256 matches the code_hash (so the enclave runs the
// EXACT published code, not something swapped in), dynamically imports it, and
// runs its `evaluate(input, undefined)`. LangGraph bundles ship with deps
// inlined; graphs read cross-tick state from input.memory (recalled before
// the enclave call). The enclave then signs the code_hash + a hash of
// the decision — so ANY strategy published to the marketplace is attestable with
// no enclave change.
//
// Trust note: the bundle runs with enclave privileges. The code_hash binding
// means the running code is exactly what the vault owner hired + what the chain
// has committed to; a malicious bundle is identifiable and was chosen by the
// owner. Bundles are self-contained ESM (no imports), default-exporting a
// Strategy with an async `evaluate`.

import { sha256 } from '@noble/hashes/sha2.js';

const AGGREGATOR = {
  testnet: 'https://aggregator.walrus-testnet.walrus.space',
  mainnet: 'https://aggregator.walrus-mainnet.walrus.space',
};

function toHex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

/** Fetch the raw bundle bytes for a Walrus blob id via the public aggregator. */
async function fetchBundle(blobId, network) {
  const base = AGGREGATOR[network] ?? AGGREGATOR.testnet;
  const res = await fetch(`${base}/v1/blobs/${blobId}`);
  if (!res.ok) throw new Error(`walrus aggregator ${res.status} for blob ${blobId}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Fetch + hash-verify + run the strategy bundle. Returns the decision the
 * strategy produced and the verified code_hash bytes.
 *
 * @param {object} a
 * @param {string} a.blobId        Walrus blob id of the strategy bundle
 * @param {string} a.codeHashHex   expected sha256 (the on-chain code_hash), 64-hex
 * @param {string} a.network       'testnet' | 'mainnet'
 * @param {object} a.input         the StrategyInput to evaluate over
 */
export async function runStrategy({ blobId, codeHashHex, network, input }) {
  const bytes = await fetchBundle(blobId, network);
  const actualHex = toHex(sha256(bytes));
  if (actualHex !== codeHashHex.toLowerCase()) {
    throw new Error(
      `bundle sha256 ${actualHex} != on-chain code_hash ${codeHashHex}. Refusing to run.`,
    );
  }

  // Import the verified bundle. Self-contained ESM → a data: URL import needs no
  // temp file and inherits no import resolver.
  const b64 = Buffer.from(bytes).toString('base64');
  const mod = await import(`data:text/javascript;base64,${b64}`);
  const strategy = mod.default ?? mod.strategy;
  if (!strategy || typeof strategy.evaluate !== 'function') {
    throw new Error('strategy bundle has no default export with evaluate()');
  }

  const decision = await strategy.evaluate(input, undefined);
  return { decision, codeHash: sha256(bytes) };
}
