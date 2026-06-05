import { SynapseStore } from '@synapse-core/adapter-langgraph';
import type { AgentIdentity } from '@synapse-core/client';
import type { MemWal } from '@synapse-core/memwal-bridge';
import type { StrategyRuntimeContext } from '../types.js';
import type { RuntimeMemWalConfig } from './memory.js';

/**
 * Build the per-tick {@link StrategyRuntimeContext} for LangGraph strategies.
 * Returns `undefined` when MemWal is disabled (no delegate key).
 */
export function buildStrategyRuntimeContext(args: {
  identity: AgentIdentity;
  memwal: MemWal | null;
  memwalConfig: RuntimeMemWalConfig | undefined;
  namespace: string;
  vaultId: string;
}): StrategyRuntimeContext | undefined {
  if (!args.memwal || !args.memwalConfig?.delegateKeyHex) return undefined;

  const store = new SynapseStore({
    identity: args.identity,
    credentials: {
      delegateKeyHex: args.memwalConfig.delegateKeyHex,
      ...(args.memwalConfig.relayerUrl ? { serverUrl: args.memwalConfig.relayerUrl } : {}),
    },
    client: args.memwal,
  });

  return {
    store,
    namespace: args.namespace,
    threadId: args.vaultId,
  };
}
