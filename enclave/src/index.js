// Synapse decision enclave server — strategy-agnostic.
//
// Runs inside an attested AWS Nitro enclave (Marlin Oyster). Holds an ephemeral
// secp256k1 signing key bound to the enclave's PCR measurement. Each /decide call
// fetches the vault's HIRED strategy bundle from Walrus, verifies its sha256
// against the on-chain code_hash, runs it inside the enclave, and signs
// (code_hash ‖ decision_hash ‖ inputs_hash). `synapse_core::decision_attestation`
// verifies that signature — and that the code_hash matches the registered
// strategy — before the swap. Publishing a new strategy needs NO enclave change.
//
// Endpoints:
//   GET  /health       -> liveness
//   GET  /public-key   -> { public_key } compressed secp256k1 hex (for register)
//   POST /decide       -> { vaultId, epoch, codeHashHex, blobId, network, inputJson,
//                         anthropicApiKey? }  per-vault LLM billing (model A)
//                       <- { decision, decision_hash, code_hash, inputs_hash, signature, timestamp_ms }

import express from 'express';
import fs from 'fs';
import { sign, getPublicKey, hashes } from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { runStrategy } from './runner.js';
import { serializeDecisionIntent } from './payload.js';

hashes.sha256 = sha256;
hashes.hmacSha256 = (key, msg) => hmac(sha256, key, msg);

let signingKey = null;

function loadSigningKey(path) {
  const keyBytes = fs.readFileSync(path);
  if (keyBytes.length !== 32) throw new Error(`expected 32-byte secp256k1 key, got ${keyBytes.length}`);
  getPublicKey(keyBytes); // validate
  return new Uint8Array(keyBytes);
}

const hex = (b) => Buffer.from(b).toString('hex');

// Shared bigint JSON codec — MUST match the runtime's enclave-client. Bigints are
// encoded as { "$bigint": "123" } so StrategyInput/Decision survive the wire.
function reviveBigints(_k, v) {
  if (v && typeof v === 'object' && typeof v.$bigint === 'string') return BigInt(v.$bigint);
  return v;
}
function replaceBigints(_k, v) {
  return typeof v === 'bigint' ? { $bigint: v.toString() } : v;
}

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/public-key', (_req, res) => {
  res.json({ public_key: hex(getPublicKey(signingKey, true)) });
});

app.post('/decide', async (req, res) => {
  try {
    const { vaultId, epoch, codeHashHex, blobId, network, inputJson, anthropicApiKey } =
      req.body ?? {};
    if (!vaultId || epoch === undefined || !codeHashHex || !blobId || typeof inputJson !== 'string') {
      return res.status(400).json({ error: 'vaultId, epoch, codeHashHex, blobId, inputJson required' });
    }

    const input = JSON.parse(inputJson, reviveBigints);
    const { decision } = await runStrategy({
      blobId,
      codeHashHex,
      network: network === 'mainnet' ? 'mainnet' : 'testnet',
      input,
      ...(typeof anthropicApiKey === 'string' && anthropicApiKey.trim()
        ? { anthropicApiKey: anthropicApiKey.trim() }
        : {}),
    });

    const decisionStr = JSON.stringify(decision, replaceBigints);
    const codeHash = Uint8Array.from(Buffer.from(codeHashHex, 'hex'));
    const decisionHash = sha256(new TextEncoder().encode(decisionStr));
    const inputsHash = sha256(new TextEncoder().encode(inputJson)); // hash the exact bytes received
    const timestampMs = Date.now();

    const messageBytes = serializeDecisionIntent({
      vaultId,
      epoch: BigInt(epoch),
      codeHash,
      decisionHash,
      inputsHash,
      timestampMs: BigInt(timestampMs),
    });
    const signature = sign(sha256(messageBytes), signingKey, { prehash: false });

    res.json({
      decision: decisionStr,
      decision_hash: hex(decisionHash),
      code_hash: hex(codeHash),
      inputs_hash: hex(inputsHash),
      timestamp_ms: timestampMs,
      signature: hex(signature),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function main() {
  const keyPath = process.argv[2] ?? process.env.SIGNING_KEY_PATH;
  if (!keyPath) {
    console.error('usage: node src/index.js <signing-key-path>  (or SIGNING_KEY_PATH)');
    process.exit(1);
  }
  signingKey = loadSigningKey(keyPath);
  console.log(`enclave public key: ${hex(getPublicKey(signingKey, true))}`);
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, '0.0.0.0', () => console.log(`synapse decision enclave on 0.0.0.0:${port}`));
}

main();
