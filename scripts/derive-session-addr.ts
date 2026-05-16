import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
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
  secret = json.secretBase64.startsWith('suiprivkey')
    ? json.secretBase64
    : `suiprivkey${json.secretBase64}`;
}
const kp = Ed25519Keypair.fromSecretKey(secret);
console.log(kp.toSuiAddress());
