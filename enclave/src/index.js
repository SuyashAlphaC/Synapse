// Synapse decision enclave server.
//
// Runs inside an attested AWS Nitro enclave (deployed via Marlin Oyster). Holds
// an ephemeral secp256k1 signing key whose public key is bound to the enclave's
// PCR measurement by the Nitro attestation document. Each `/decide` call runs the
// advisor (Claude) over the host-supplied market + recalled memory, then signs a
// `DecisionPayload` the Move contract verifies before the trade can execute.
//
// Endpoints (the Oyster runtime also exposes `/attestation/hex` for registration):
//   GET  /health       -> liveness
//   GET  /public-key   -> { public_key } compressed secp256k1 hex (for register_enclave)
//   POST /decide       -> { decision, signature, timestamp_ms } over a signed DecisionPayload

import express from 'express';
import fs from 'fs';
import { sign, getPublicKey, hashes } from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { advise } from './advisor.js';
import { serializeDecisionIntent } from './payload.js';

// @noble/secp256k1 v3 needs these wired up explicitly.
hashes.sha256 = sha256;
hashes.hmacSha256 = (key, msg) => hmac(sha256, key, msg);

let signingKey = null;

/** Load a 32-byte secp256k1 private key from a file (mounted secret in Oyster). */
function loadSigningKey(path) {
  const keyBytes = fs.readFileSync(path);
  if (keyBytes.length !== 32) {
    throw new Error(`expected 32-byte secp256k1 key, got ${keyBytes.length}`);
  }
  getPublicKey(keyBytes); // validate
  return new Uint8Array(keyBytes);
}

/** Canonical sha256 of the advisor inputs — binds the reasoning to its inputs. */
function inputsHash(input) {
  return sha256(new TextEncoder().encode(JSON.stringify(input)));
}

const app = express();
app.use(express.json({ limit: '256kb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/public-key', (_req, res) => {
  const pk = getPublicKey(signingKey, true); // compressed (33 bytes)
  res.json({ public_key: Buffer.from(pk).toString('hex') });
});

app.post('/decide', async (req, res) => {
  try {
    const { vaultId, epoch, input } = req.body ?? {};
    if (!vaultId || epoch === undefined || !input) {
      return res.status(400).json({ error: 'vaultId, epoch, input required' });
    }

    const rec = await advise(input, {});
    if (!rec) {
      return res.status(503).json({ error: 'advisor not configured or unparseable' });
    }

    const targetWeightMilli = Math.max(0, Math.min(1000, Math.round(rec.targetBaseWeight * 1000)));
    const timestampMs = Date.now();
    const hash = inputsHash(input);

    // Serialize exactly as the Move contract will, then sign sha256(bytes).
    const messageBytes = serializeDecisionIntent({
      vaultId,
      epoch: BigInt(epoch),
      targetWeightMilli,
      inputsHash: hash,
      timestampMs: BigInt(timestampMs),
    });
    const digest = sha256(messageBytes);
    const signature = sign(digest, signingKey, { prehash: false });

    res.json({
      decision: {
        vaultId,
        epoch,
        targetWeightMilli,
        inputsHashHex: Buffer.from(hash).toString('hex'),
        confidence: rec.confidence,
        rationale: rec.rationale,
      },
      timestamp_ms: timestampMs,
      signature: Buffer.from(signature).toString('hex'),
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
  const pk = getPublicKey(signingKey, true);
  console.log(`enclave public key: ${Buffer.from(pk).toString('hex')}`);
  app.listen(3000, '0.0.0.0', () => console.log('synapse decision enclave on 0.0.0.0:3000'));
}

main();
