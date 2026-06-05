# @synapse-core/adapter-langgraph

Give any **LangGraph** agent **Walrus-durable, verifiable memory** by dropping
in `SynapseStore` — a `BaseStore` backed by MemWal (Walrus Memory).

What you get for free:
- **Walrus-persistent semantic memory** — `put` / `get` / `search` over MemWal,
  stored on Walrus, recalled by similarity.
- **On-chain authorization** — every read/write is gated by the agent's
  delegate key bound to its `AgentIdentity`.
- **Cryptographic revocation** — revoke the identity → the delegate is
  invalidated → memory access stops.
- **Cross-session + cross-agent** — another process holding a delegate for the
  same identity reads the same memory. Portable, not siloed.

## Install

```bash
npm install @synapse-core/adapter-langgraph
```

## Production vault runtime

Synapse Vault's tick loop passes {@link SynapseStore} into LangGraph strategies
via `createLangGraphStrategy` in `@synapse-core/vault/langgraph`. Attested
(Nautilus) enclaves run hash-verified LangGraph bundles from Walrus — publish
self-contained strategy files with `scripts/bundle-strategy.ts` or the dashboard
marketplace server bundler (`/api/bundle-strategy`).

## Use — the whole integration is one object

```ts
import { SynapseStore } from '@synapse-core/adapter-langgraph';

const store = new SynapseStore({
  identity,                                   // on-chain AgentIdentity
  credentials: { delegateKeyHex: process.env.MEMWAL_DELEGATE_KEY! },
});

// Walrus-durable write, semantically recallable later — across sessions.
await store.put(['research', 'sui'], 'finding-1', { note: 'thin testnet depth' });

// Read by key…
const item = await store.get(['research', 'sui'], 'finding-1');

// …or semantic search the namespace.
const hits = await store.search(['research', 'sui'], { query: 'liquidity' });
```

Pass `store` to any LangGraph graph (`new StateGraph(...).compile({ store })`)
and its nodes get persistent memory with zero further wiring.

## Mapping

| LangGraph `BaseStore` | Synapse / MemWal |
|---|---|
| `namespace: string[]` | MemWal namespace (`/`-joined) |
| `put(ns, key, value)` | `rememberAndWait` (JSON-encoded item) on Walrus |
| `get(ns, key)` | key-index cache → MemWal `recall` fallback |
| `search(ns, {query, filter})` | MemWal semantic `recall` + local filter |
| `put(ns, key, null)` | tombstone record |

## Run the example

```bash
SYNAPSE_AGENT_ID=0x… SYNAPSE_PACKAGE_ID=0x… MEMWAL_DELEGATE_KEY=<hex> \
  npx tsx examples/persistent-memory.ts
```

## Test

```bash
npm test   # 8 unit tests, in-memory MemWal double — no relayer needed
```

## v1 limitations (documented, not faked)

- `delete` is a tombstone + key-index removal; the underlying MemWal blob is
  not yet evicted (the MemWal SDK exposes no forget API).
- `listNamespaces` returns namespaces observed by this store instance;
  recovering historical namespaces needs the relayer restore endpoint (v2).
