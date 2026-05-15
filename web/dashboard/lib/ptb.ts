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
}

/**
 * Build the canonical mint PTB:
 *   1. `agent::new(...)`                          → hot-potato `AgentIdentity`
 *   2. SplitCoins(gas, [funding])                  → `Coin<SUI>`
 *   3. `agent::fund<SUI>(identity, coin)`
 *   4. `agent::share(identity)`                    → shared object on-chain
 */
export function buildMintPTB(params: MintAgentParams): Transaction {
  const tx = new Transaction();

  const [fundingCoin] = tx.splitCoins(tx.gas, [params.fundingMist]);
  if (!fundingCoin) throw new Error('splitCoins did not return a coin handle');

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

  tx.moveCall({
    target: synapseTarget('agent', 'share'),
    arguments: [identity],
  });

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
 * Returns the keypair, address, and a base64-encoded 32-byte secret so
 * downstream code can persist it (Seal-encrypted, or via the agent runtime).
 */
export function generateSessionKeypair(): { keypair: Ed25519Keypair; address: string; secretBase64: string } {
  const keypair = new Ed25519Keypair();
  const address = keypair.toSuiAddress();
  const secret = keypair.getSecretKey();
  const base64 = secret.replace(/^suiprivkey/, '');
  return { keypair, address, secretBase64: base64 };
}
