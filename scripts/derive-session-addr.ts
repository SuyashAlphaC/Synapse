import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromBase64 } from '@mysten/sui/utils';
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: derive-session-addr.ts <path-to-key-file>');
  process.exit(1);
}
const raw = readFileSync(path, 'utf8').trim();

let secret = raw;
if (raw.startsWith('{')) {
  const json = JSON.parse(raw) as { secretBase64?: string };
  if (!json.secretBase64) throw new Error('JSON key file missing secretBase64');
  secret = json.secretBase64;
}

// Key files store the raw 32-byte Ed25519 secret as base64 (matching
// SessionKey.secretBase64). `fromSecretKey` wants raw bytes for that form;
// only a `suiprivkey1...` bech32 string is passed through as-is. Prepending
// the literal "suiprivkey" to a base64 body (the previous behavior) produced
// an invalid bech32 string that always threw.
const kp = secret.startsWith('suiprivkey')
  ? Ed25519Keypair.fromSecretKey(secret)
  : Ed25519Keypair.fromSecretKey(fromBase64(secret));
console.log(kp.toSuiAddress());
