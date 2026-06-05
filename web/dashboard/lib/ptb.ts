/**
 * Real PTB builders for the dashboard. These construct the exact same
 * Move calls the Move tests exercise — `agent::new + fund + share` for
 * minting, `agent::revoke` for revocation. Every call targets the
 * deployed package on Sui testnet.
 *
 * Coin types are real:
 *   - 0x2::sui::SUI is the gas + funding coin for the v1 demo.
 *
 * Returns a `Transaction` ready to pass into `useSignAndExecuteTransaction`.
 */

import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { toBase64 } from '@mysten/sui/utils';
import { synapseTarget } from './synapse-config';

/**
 * The Sui-canonical SUI coin type. Used both as gas and as the v1 funding
 * coin in the dashboard mint flow.
 */
export const SUI_COIN_TYPE_TAG = '0x2::sui::SUI';

export interface MintAgentParams {
  /** ID of the published Strategy this vault is being minted against. */
  strategyId: string;
  /** Address of the agent's ephemeral session key. */
  sessionAddr: string;
  /** Epoch the agent expires at. Must be strictly greater than current epoch. */
  expiryEpoch: bigint;
  /** Per-epoch spend cap in MIST (1 SUI = 1e9 MIST). */
  spendPerEpochMist: bigint;
  /** Contract package allowlist. */
  approvedPackages: string[];
  /**
   * MemWal account ID bytes. For the v1 demo this is filled with a stable
   * placeholder; production wires it to a real MemWal relayer-issued ID.
   */
  memwalAccountId: Uint8Array;
  /** MemWal delegate-key ID bytes. */
  memwalDelegateKeyId: Uint8Array;
  /** MemWal namespace bytes. */
  memwalNamespace: Uint8Array;
  /** Amount of SUI to seed the treasury with (in MIST). */
  fundingMist: bigint;
  /**
   * One-time SUI buffer transferred to the session address as part of
   * the mint PTB. The session needs *some* gas to sign its first
   * pull_operational_funds call (chicken-and-egg) — this breaks the
   * cycle. Default 0.02 SUI ≈ 4 tick signatures' worth of gas.
   */
  sessionGasSeedMist: bigint;
  /**
   * Per-epoch cap on `pull_operational_funds<SUI>`. Set as part of mint
   * so the runtime can auto-refuel from tick 1. Zero disables auto-refuel
   * (legacy behavior — owner refuels manually). Defaults to 0.05 SUI/epoch
   * which covers ~10 ticks at testnet gas prices.
   */
  operationalCapMist: bigint;
  /**
   * Opt this vault into dynamic Walrus-loaded strategy execution at
   * mint time. When true, the mint PTB appends
   * `agent::set_walrus_consent(identity, true)` so the runtime is
   * allowed to fetch + hash-verify + execute the strategy's bundle
   * from Walrus. When false (or omitted), the runtime treats this
   * vault as opt-out and falls back to its locally bundled
   * implementations — required for any strategy not in the seeded
   * set. Toggleable post-mint via `buildSetWalrusConsentPTB`.
   */
  acceptWalrusExecution?: boolean;
}

/**
 * Build the canonical mint PTB:
 *   1. `splitCoins(gas, [funding, sessionGasSeed])` → 2 Coin<SUI> handles
 *   2. `agent::new(...)`                            → hot-potato `AgentIdentity`
 *   3. `agent::fund<SUI>(identity, fundingCoin)`
 *   4. (optional) `agent::set_operational_cap(identity, cap)`
 *   5. `transfer(sessionGasCoin, sessionAddr)`     → seed session for first tick
 *   6. `agent::share(identity)`                    → shared object on-chain
 *
 * Steps 4–5 enable the auto-refuel loop from the very first tick — no
 * post-mint owner refueling required. The session's first
 * `pull_operational_funds` call is paid by the seed coin from step 5,
 * which itself was paid by the owner via the mint tx gas.
 */
export function buildMintPTB(params: MintAgentParams): Transaction {
  const tx = new Transaction();

  // Split off two SUI coins from the owner's gas: one funds the treasury,
  // one seeds the session's gas for its first auto-refuel call.
  const splits =
    params.sessionGasSeedMist > 0n
      ? tx.splitCoins(tx.gas, [params.fundingMist, params.sessionGasSeedMist])
      : tx.splitCoins(tx.gas, [params.fundingMist]);
  const fundingCoin = splits[0];
  const sessionGasCoin = params.sessionGasSeedMist > 0n ? splits[1] : null;
  if (!fundingCoin) throw new Error('splitCoins did not return a funding coin');
  if (params.sessionGasSeedMist > 0n && !sessionGasCoin) {
    throw new Error('splitCoins did not return a session gas coin');
  }

  const identity = tx.moveCall({
    target: synapseTarget('agent', 'new'),
    arguments: [
      tx.object(params.strategyId),
      tx.pure.address(params.sessionAddr),
      tx.pure.u64(params.expiryEpoch),
      tx.pure.u64(params.spendPerEpochMist),
      tx.pure.vector('address', params.approvedPackages),
      tx.pure.vector('u8', Array.from(params.memwalAccountId)),
      tx.pure.vector('u8', Array.from(params.memwalDelegateKeyId)),
      tx.pure.vector('u8', Array.from(params.memwalNamespace)),
    ],
  });

  tx.moveCall({
    target: synapseTarget('agent', 'fund'),
    typeArguments: [SUI_COIN_TYPE_TAG],
    arguments: [identity, fundingCoin],
  });

  if (params.operationalCapMist > 0n) {
    tx.moveCall({
      target: synapseTarget('agent', 'set_operational_cap'),
      arguments: [identity, tx.pure.u64(params.operationalCapMist)],
    });
  }

  if (sessionGasCoin) {
    tx.transferObjects([sessionGasCoin], tx.pure.address(params.sessionAddr));
  }

  // Opt the vault into Walrus-loaded strategy execution before sharing
  // — this lets the owner's mint signature express consent in one PTB
  // when hiring a marketplace strategy that ships as a Walrus bundle.
  if (params.acceptWalrusExecution) {
    tx.moveCall({
      target: synapseTarget('agent', 'set_walrus_consent'),
      arguments: [identity, tx.pure.bool(true)],
    });
  }

  tx.moveCall({
    target: synapseTarget('agent', 'share'),
    arguments: [identity],
  });

  return tx;
}

/**
 * Post-mint consent toggle. Owner-only; the wallet button that signs
 * this is the same wallet that signed the original mint. Used from the
 * Policy panel for vaults minted before the consent upgrade, or to
 * revoke consent after the fact.
 */
export function buildSetWalrusConsentPTB(args: {
  agentId: string;
  accept: boolean;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: synapseTarget('agent', 'set_walrus_consent'),
    arguments: [tx.object(args.agentId), tx.pure.bool(args.accept)],
  });
  return tx;
}

/**
 * Owner-only: require (or stop requiring) Nautilus enclave attestation before
 * this vault may spend. When enabled, the chain aborts any trade that wasn't
 * preceded by a valid enclave-signed decision in the same epoch.
 */
export function buildSetRequiresAttestationPTB(args: {
  agentId: string;
  required: boolean;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: synapseTarget('agent', 'set_requires_attestation'),
    arguments: [tx.object(args.agentId), tx.pure.bool(args.required)],
  });
  return tx;
}

/**
 * Owner-only partial withdrawal from the vault treasury via
 * `wallet::withdraw<T>`. Returns the coin in the PTB and transfers it to
 * `to` (typically the owner / DAO multisig address).
 */
export function buildWithdrawPTB(args: {
  agentId: string;
  amount: bigint;
  to: string;
  coinTypeTag: string;
}): Transaction {
  const tx = new Transaction();
  const coin = tx.moveCall({
    target: synapseTarget('wallet', 'withdraw'),
    typeArguments: [args.coinTypeTag],
    arguments: [
      tx.object(args.agentId),
      tx.pure.u64(args.amount),
      tx.pure.address(args.to),
    ],
  });
  tx.transferObjects([coin], tx.pure.address(args.to));
  return tx;
}

/**
 * Owner-only full drain of one coin type from the vault treasury. Move
 * transfers the balance directly to the vault owner inside `wallet::drain`.
 */
export function buildDrainPTB(args: { agentId: string; coinTypeTag: string }): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: synapseTarget('wallet', 'drain'),
    typeArguments: [args.coinTypeTag],
    arguments: [tx.object(args.agentId)],
  });
  return tx;
}

/**
 * Owner-only batched drain: one `wallet::drain<T>` per coin type in a single
 * PTB. Each balance is transferred to the vault owner on-chain.
 */
export function buildDrainAllPTB(args: {
  agentId: string;
  coinTypeTags: string[];
}): Transaction {
  const tx = new Transaction();
  for (const coinTypeTag of args.coinTypeTags) {
    tx.moveCall({
      target: synapseTarget('wallet', 'drain'),
      typeArguments: [coinTypeTag],
      arguments: [tx.object(args.agentId)],
    });
  }
  return tx;
}

/** Build the revoke PTB against a known AgentIdentity object ID. */
export function buildRevokePTB(args: { agentId: string; strategyId: string }): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: synapseTarget('agent', 'revoke'),
    arguments: [tx.object(args.agentId), tx.object(args.strategyId)],
  });
  return tx;
}

/**
 * Generate a fresh ephemeral Ed25519 session keypair. The agent runtime
 * uses this to sign transactions on behalf of the agent; the human owner
 * never needs to hold it past the mint PTB.
 *
 * Returns the keypair, address, and two persistence-friendly serialisations:
 *   - `suiprivkey`: the canonical Sui CLI / SDK format (`suiprivkey1q…`).
 *     This is what `loadSessionKeypair` in @synapse-core/vault expects when
 *     SYNAPSE_SESSION_KEY is set. Round-trips losslessly via
 *     `Ed25519Keypair.fromSecretKey(suiprivkey)`.
 *   - `secretBase64`: raw 32-byte secret base64-encoded (no flag prefix).
 *     Convenient for places that want the bare bytes (Seal, custom
 *     storage). Pass through `fromBase64` then `Ed25519Keypair.fromSecretKey`
 *     to reconstruct.
 *
 * Previous versions misnamed the bech32 string as `secretBase64`. That
 * field now contains real base64 of the 32-byte secret. Any consumer
 * reading the old field can fall back to detecting the `suiprivkey` prefix.
 */
export function generateSessionKeypair(): {
  keypair: Ed25519Keypair;
  address: string;
  suiPrivateKey: string;
  secretBase64: string;
} {
  const keypair = new Ed25519Keypair();
  const address = keypair.toSuiAddress();
  const suiPrivateKey = keypair.getSecretKey();
  // Sui SDK returns the raw 32-byte secret via decodeSuiPrivateKey, but
  // we already have the keypair — re-derive bytes from the BCS form.
  const decoded = decodeSuiPrivateKey(suiPrivateKey);
  const secretBase64 = toBase64(decoded.secretKey);
  return { keypair, address, suiPrivateKey, secretBase64 };
}

/**
 * Generate a fresh MemWal delegate Ed25519 keypair locally. Mirrors
 * `generateSessionKeypair` exactly — same lifecycle, same trust
 * boundary. The PUBLIC key bytes go on-chain as
 * `AgentIdentity.memwal_delegate_key_id`; the PRIVATE key gets
 * bundled into the same downloaded `.key` file the runtime already
 * loads.
 *
 * Returned shape:
 *   - `publicKeyBytes`: 32 raw bytes. Pass to the mint PTB as
 *     `memwalDelegateKeyId`. The mint wizard sends these as a
 *     `vector<u8>` arg; the on-chain length tells future readers
 *     "this is a public key" (32B) vs the legacy footgun "this is
 *     an ASCII-hex of a private key" (64B).
 *   - `privateKeyHex`: 64 hex chars (no `0x` prefix). This is what
 *     the runtime needs as its MemWal signing credential.
 *   - `publicKeyHex`: 64 hex chars (no `0x` prefix). Convenience for
 *     audit / display.
 */
export function generateMemwalDelegateKeypair(): {
  privateKeyHex: string;
  publicKeyHex: string;
  publicKeyBytes: Uint8Array;
} {
  const keypair = new Ed25519Keypair();
  const decoded = decodeSuiPrivateKey(keypair.getSecretKey());
  const privateKeyHex = bytesToHex(decoded.secretKey);
  const publicKeyBytes = keypair.getPublicKey().toRawBytes();
  const publicKeyHex = bytesToHex(publicKeyBytes);
  return { privateKeyHex, publicKeyHex, publicKeyBytes };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
