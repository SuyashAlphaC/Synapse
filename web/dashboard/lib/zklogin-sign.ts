/**
 * zkLogin transaction signing helpers.
 *
 * Given an active zkLogin account, this signs a Sui `Transaction` with the
 * ephemeral keypair, then wraps the signature in a `ZkLoginSignature` that
 * the network validates against the on-chain ZKP + JWT.
 */

import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import type { Transaction } from '@mysten/sui/transactions';
import { getZkLoginSignature } from '@mysten/sui/zklogin';
import { ephemeralKeypair, type ActiveZkLoginAccount } from './zklogin';

export interface ZkLoginSignAndExecuteArgs {
  client: SuiJsonRpcClient;
  account: ActiveZkLoginAccount;
  transaction: Transaction;
}

export async function zkLoginSignAndExecute({
  client,
  account,
  transaction,
}: ZkLoginSignAndExecuteArgs): Promise<{ digest: string }> {
  const kp = ephemeralKeypair(account);
  transaction.setSender(account.address);
  const txBytes = await transaction.build({ client });
  const { signature: userSignature } = await kp.signTransaction(txBytes);

  const zkSignature = getZkLoginSignature({
    inputs: account.zkProofInputs,
    maxEpoch: account.maxEpoch,
    userSignature,
  });

  const result = await client.executeTransactionBlock({
    transactionBlock: txBytes,
    signature: zkSignature,
    options: { showEffects: true, showObjectChanges: true },
  });
  return { digest: result.digest };
}
