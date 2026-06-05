import { sign, getPublicKey, hashes } from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { serializeDecisionIntent } from '../src/payload.js';
hashes.sha256 = sha256;
hashes.hmacSha256 = (k, m) => hmac(sha256, k, m);

// Deterministic test key (32 bytes of 0x01..0x20).
const sk = new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1));
const pk = getPublicKey(sk, true); // compressed 33B

const vaultId = '0x1234';
const epoch = 100n;
const codeHash = sha256(new TextEncoder().encode('strategy-bundle-bytes'));
const decisionHash = sha256(new TextEncoder().encode('the-decision'));
const inputsHash = sha256(new TextEncoder().encode('test-inputs'));
const timestampMs = 1744038900000n;

const msg = serializeDecisionIntent({ vaultId, epoch, codeHash, decisionHash, inputsHash, timestampMs });
const sig = sign(sha256(msg), sk, { prehash: false });

const hex = (b) => Buffer.from(b).toString('hex');
const arr = (b) => '[' + Array.from(b).join(',') + ']';
console.log('PK_COMPRESSED =', hex(pk));
console.log('CODE_HASH     =', arr(codeHash));
console.log('DECISION_HASH =', arr(decisionHash));
console.log('INPUTS_HASH   =', arr(inputsHash));
console.log('SIGNATURE     =', arr(sig), '(len', sig.length + ')');
