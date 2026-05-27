# Multi-agent: cross-agent memory read

Two Synapse vaults that share a MemWal namespace can read each other's memory,
and attest that read on-chain via `coordination::record_cross_agent_read`. This
turns the protocol capability into an observable, live multi-agent edge (a
`CrossAgentReadEvent` the indexer + dashboard timeline render).

## What's already done (code, verified)

- `coordination.move::record_cross_agent_read(reader, writer, memory_id, ctx)` —
  enforces shared namespace + writer-not-revoked + reader session signature,
  emits `CrossAgentReadEvent`.
- `synapse-cross-agent-read` CLI (`sdk/packages/vault/src/runtime/bin/cross-agent-read.ts`):
  recalls a memory from the shared namespace with the reader's delegate (or
  takes `--memory-id`), then submits the attestation PTB signed by the reader's
  session key. typecheck + build + vault tests pass.

## What you run (needs two funded vaults)

1. **Mint two vaults with the SAME MemWal namespace.** In the mint wizard, set
   the same namespace for both (e.g. `synapse/shared/alpha`). Fund the reader
   vault's session address with a little SUI for gas.

2. **Seed a memory** under the shared namespace from the writer vault (any tick
   that runs `remember`, or the writer's runtime). The reader will recall it.

3. **Run the cross-read** with the reader's `.key`:

   ```bash
   export SYNAPSE_PACKAGE_ID=0x<core>
   export SYNAPSE_PACKAGE_HISTORY=0x<v3>,0x<v2>,0x<v1>
   synapse-cross-agent-read \
     --reader 0x<vaultA> \
     --writer 0x<vaultB> \
     --session-key-path ./vaultA.key \
     --query "shared strategy signal"
   # or attest a specific memory directly:
   #   --memory-id <walrus-blob-id>
   ```

   It recalls a memory the writer persisted in the shared namespace, then
   submits `record_cross_agent_read`. On success it logs the tx digest and the
   emitted `CrossAgentReadEvent`.

## Verify

- **On-chain**: the tx emits `…::coordination::CrossAgentReadEvent` with
  `reader_id`, `writer_id`, `namespace`, `memwal_memory_id` — visible on
  suiscan.
- **Dashboard**: the reader vault's audit timeline shows a `cross_agent_read`
  entry (the indexer already classifies this event type).

## Notes

- The Move VM enforces the trust rules — if the vaults don't share a namespace,
  or the writer is revoked, the PTB aborts (no event). That's the point: the
  on-chain policy, not the script, is the source of truth.
- Messaging (`messaging_bridge::record_send/record_receive`) and artifact
  sharing (`coordination::record_artifact_share`) follow the same pattern and
  can be layered on later; cross-read is the flagship.
