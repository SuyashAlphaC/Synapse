import type { Transaction, TransactionObjectArgument } from '@mysten/sui/transactions';
import { testnetCoins, testnetPackageIds, testnetPools } from '@mysten/deepbook-v3';
import { target } from '@synapse-core/client';
import type { DeepBookSwapFn } from '../executor.js';
import { SwapDirection } from '../executor.js';

export const DEEPBOOK_PACKAGE_ID_TESTNET = testnetPackageIds.DEEPBOOK_PACKAGE_ID;
export const DEEPBOOK_REGISTRY_ID_TESTNET = testnetPackageIds.REGISTRY_ID;
export const SUI_USDC_POOL_ID_TESTNET = testnetPools.SUI_DBUSDC.address;
export const SUI_TYPE_TAG_TESTNET = testnetCoins.SUI.type;
export const USDC_TYPE_TAG_TESTNET = testnetCoins.DBUSDC.type;
export const DEEP_TYPE_TAG_TESTNET = testnetCoins.DEEP.type;

/**
 * The current DeepBook testnet SDK publishes DBUSDC as the active testnet
 * quote asset for the SUI pool. The public USDC type requested in the Week 1
 * brief is kept here for callers that need to reject mismatched strategies.
 */
export const REQUESTED_TESTNET_USDC_TYPE_TAG =
  '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC';

/**
 * Compose a DeepBookV3 spot swap inside a Synapse rebalance PTB.
 *
 * Returns the output coin to the executor for `wallet::deposit`. Routes any
 * non-zero base/quote remainder back to the vault treasury via
 * `wallet::deposit` so partial fills don't abort the PTB. The DEEP fee coin
 * is created with `coin::zero` so its remainder is provably zero — that one
 * we destroy.
 */
export const deepbookSwap: DeepBookSwapFn = (
  tx,
  { trade, inputCoin, vaultId, synapsePackageId },
) => {
  const deepCoin = tx.moveCall({
    target: '0x2::coin::zero',
    typeArguments: [DEEP_TYPE_TAG_TESTNET],
  });

  if (trade.direction === SwapDirection.BaseToQuote) {
    const [baseRemainder, quoteOut, deepRemainder] = tx.moveCall({
      target: `${DEEPBOOK_PACKAGE_ID_TESTNET}::pool::swap_exact_base_for_quote`,
      typeArguments: [trade.fromTypeTag, trade.toTypeTag],
      arguments: [
        tx.object(trade.poolId),
        inputCoin,
        deepCoin,
        tx.pure.u64(trade.minAmountOut),
        tx.object.clock(),
      ],
    });
    depositRemainder(tx, synapsePackageId, vaultId, trade.fromTypeTag, baseRemainder);
    destroyZeroCoin(tx, DEEP_TYPE_TAG_TESTNET, deepRemainder);
    return quoteOut;
  }

  const [baseOut, quoteRemainder, deepRemainder] = tx.moveCall({
    target: `${DEEPBOOK_PACKAGE_ID_TESTNET}::pool::swap_exact_quote_for_base`,
    typeArguments: [trade.toTypeTag, trade.fromTypeTag],
    arguments: [
      tx.object(trade.poolId),
      inputCoin,
      deepCoin,
      tx.pure.u64(trade.minAmountOut),
      tx.object.clock(),
    ],
  });
  depositRemainder(tx, synapsePackageId, vaultId, trade.fromTypeTag, quoteRemainder);
  destroyZeroCoin(tx, DEEP_TYPE_TAG_TESTNET, deepRemainder);
  return baseOut;
};

/**
 * Route a swap-leftover coin back into the vault treasury via
 * `wallet::deposit<T>`. Safe whether the coin is zero or non-zero — the
 * underlying `agent::fund` either creates a new Balance entry or joins into
 * the existing one, and never aborts on zero values.
 */
function depositRemainder(
  tx: Transaction,
  synapsePackageId: string,
  vaultId: string,
  coinTypeTag: string,
  coin: TransactionObjectArgument,
): void {
  tx.moveCall({
    target: target(synapsePackageId, 'wallet', 'deposit'),
    typeArguments: [coinTypeTag],
    arguments: [tx.object(vaultId), coin],
  });
}

/**
 * Destroy a coin we know is zero (provably constructed via `coin::zero`).
 * Aborts if the coin is non-zero — never use on remainders coming back from
 * DeepBook.
 */
function destroyZeroCoin(tx: Transaction, coinType: string, coin: TransactionObjectArgument): void {
  tx.moveCall({
    target: '0x2::coin::destroy_zero',
    typeArguments: [coinType],
    arguments: [coin],
  });
}
