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
 * Matches the canonical Move signatures exactly (verified against
 * deepbookv3 `packages/deepbook/sources/pool.move` + the
 * `@mysten/deepbook-v3` SDK):
 *
 *   swap_exact_base_for_quote<Base, Quote>(
 *     pool, base_in, deep_in, min_quote_out, clock, ctx
 *   ) -> (Coin<Base>, Coin<Quote>, Coin<DEEP>)
 *
 *   swap_exact_quote_for_base<Base, Quote>(
 *     pool, quote_in, deep_in, min_base_out, clock, ctx
 *   ) -> (Coin<Base>, Coin<Quote>, Coin<DEEP>)
 *
 * Type params are ALWAYS `[Base, Quote]` regardless of direction.
 * Returns the output coin to the executor for `wallet::deposit`; the
 * unspent input remainder is deposited back to the treasury so a
 * partial fill doesn't abort the PTB.
 *
 * DEEP fee model: these entry points set `pay_with_deep = true`
 * internally — fees come from the `deep_in` coin, NOT the input asset.
 * We pass `coin::zero<DEEP>`, which works on whitelisted / stable
 * testnet pools that waive DEEP fees (verified: our SUI/DBUSDC
 * testnet swaps land with a zero DEEP coin). On a mainnet
 * non-whitelisted pool the swap would abort with insufficient DEEP —
 * production must fund a real DEEP coin (hold DEEP in treasury + pull
 * it, or add a DEEP-acquiring leg). Tracked as a mainnet-readiness
 * follow-up; zero-DEEP is correct for the testnet pools we use.
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
