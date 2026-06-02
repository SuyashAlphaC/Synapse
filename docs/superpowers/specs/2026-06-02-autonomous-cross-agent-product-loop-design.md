# Autonomous Cross-Agent Product Loop — Design

Date: 2026-06-02
Status: Approved (pre-implementation)

## Problem

Four capabilities exist only as manual/CLI proofs, not product behavior:

- **Sui Stack Messaging** + **cross-agent read** run as standalone scripts
  (`examples/messaging-demo/src/send-message.ts`,
  `sdk/.../runtime/bin/cross-agent-read.ts`), invoked by a human. Neither is in
  the runtime tick loop. The recipient only records a `sha256` digest on-chain —
  it does **not** read, decrypt, or act on the message. Correlate ≠ consume.
- **LLM advisor** calls Claude **every tick** off a single shared
  `ANTHROPIC_API_KEY`. At scale the operator subsidizes every DAO's inference —
  negative unit economics, no per-vault attribution.

This build makes the loop autonomous and gives it positive unit economics.

## Decisions (locked)

- **Operating model: A — DAO self-hosts.** Each DAO runs its own
  `synapse-vault-runtime` and supplies its own Anthropic key. The operator never
  custodies a key. (Managed "B" tier — operator-custodied keys — is explicit
  future work, not this build.)
- **Messaging transport: 1 — persisted channel + full Sui-Stack-Messaging per
  signal.** Real Seal-encrypted, Walrus-stored messages. Channel ids come from
  on-chain agent state (`messaging_inbox` / `messaging_outbox`, set once by
  `attach_messaging`); the loop never creates channels.

## Scope

Single-tenant daemon unchanged (one `VaultRuntime` per process per vault).

| # | Unit | Location | Size |
|---|------|----------|------|
| 1 | Cross-agent messaging in the tick (consume + emit) | new `runtime/messaging.ts` + 2 slots in `tickOnce()` | large |
| 2 | Per-vault API key (model A) | `runtime/secrets.ts`, `runtime/strategy-resolver.ts` | small |
| 3 | LLM tick-gating | `strategies/llm-advisor.ts` | small |
| 4 | Dashboard demo affordance (client-side key config generator) | `web/dashboard` | small |

### Out of scope (explicit)

- Multi-tenant daemon.
- Managed key custody (model B).
- Republishing the **Walrus** llm-advisor blob. Tick-gating lands in the SDK
  strategy; the live demo vault hires the published Walrus copy, so it only picks
  up gating after a separate, optional republish (flagged follow-up).
- The `messaging-demo` CLI — stays as the rich-payload showcase + the one-time
  channel pairing tool.

## Unit 1 — Cross-agent messaging in the tick

New module `sdk/packages/vault/src/runtime/messaging.ts` isolates all
Sui-Stack-Messaging mechanics behind two functions:

```
consumeSignals({ client, agent, sessionSigner, delegate, lastCursor })
  -> { facts: string[], newCursor }
emitSignal({ client, agent, sessionSigner, decision, report })
  -> { digest, messageTx } | null
```

The messaging SDK client (built with the MVR `overrides.packages` fix already
landed in `send-message.ts`) is constructed once per runtime, not per tick.

**Channel lifecycle.** Read `agent.identity.messagingInbox` (read peers) and
`messagingOutbox` (send). Both already on-chain via `attach_messaging` and parsed
by `state.ts`. If both are `none`, both functions no-op (graceful, mirrors the
memwal-disabled path). No channel creation in the loop — pairing is a one-time
setup step done via CLI/dashboard.

**Consume (tick start, before `evaluate`):**
1. List inbox messages since `lastCursor`.
2. Seal-decrypt with the delegate/session key the runtime already loads.
3. Convert each to a fact string (e.g. `"peer 0x…: rotate 5% SUI->USDC (epoch
   1114)"`) and append to `StrategyInput.memory.facts` — so `evaluate`/the LLM
   sees peer signals as memory with **no strategy-API change**.
4. `record_receive(digest)` on-chain per new message (audit edge).
5. Return `newCursor`.

**Emit (after `evaluate`, only on a real signal):**
- "Signal" = `decision.kind === 'rebalance'`. Noops stay silent (cost gate).
- Send **one** Seal-encrypted, Walrus-stored message to the outbox channel
  carrying rationale + target weight (already in `report`).
- Piggyback `record_send(digest)` into the existing rebalance PTB where possible,
  else a follow-up tx.

**Idempotency & cost control:**
- Read-cursor persisted as MemWal counter `msgCursor` + dedupe by message
  digest — never reprocess, never double-`record_receive`.
- No channel spawning — existing on-chain channel ids only.
- Emit only on rebalance — most ticks are noops → no WAL burn most ticks.
- Message Walrus retention uses the configurable `walrusEpochs`.

**Failure handling:** all messaging wrapped like the existing Walrus upload —
`try/catch`, log + degrade. Must never trip the kill-switch or block the
rebalance. Consume failure → proceed with no peer facts this tick. Emit failure →
rebalance still lands; signal just isn't broadcast (logged).

## Unit 2 — Per-vault API key (model A)

- Add `'anthropic_api_key'` to `SecretName`. `EnvSecretsProvider` →
  `ANTHROPIC_API_KEY`; `FileSecretsProvider` → file `anthropic-api-key`.
- `strategy-resolver` resolves it from the provider and passes it as
  `llmAdvisorConfig.apiKey` (field already exists). Removes the implicit
  `process.env` reach inside `defaultAdvise` for the SDK path — key flows
  explicitly per runtime.
- One daemon = one vault, so "the daemon's secret" is that vault's key. No change
  to the multitenancy model.

## Unit 3 — LLM tick-gating

Wrap `advise` in `llm-advisor.ts` with a gate that **skips the Claude call**
(reusing the last target weight) unless one of:

- **drift trigger** — base-asset price moved more than `llmRecallThreshold`
  (default ~1.5%) since the last LLM call, or
- **staleness trigger** — at least `llmMaxIdleEpochs` (default 1) since the last
  call.

State via existing memory counters: `lastLlmEpoch`, `lastLlmPriceMilli`,
`lastTargetWeightMilli`. Gated tick → reuse `lastTargetWeight`, rationale
`"reused prior AI target (no material change)"`, **no API spend**. First run (no
stored prior) falls through to a real call.

Model tiering: config `model` default → Haiku for routine; optional
`escalateModel` (Opus) on large drift. Defaults aim for ~10x spend cut.

## Unit 4 — Dashboard demo affordance

A "Bring your Anthropic key" panel (mint final step or vault settings): user
pastes the key locally → panel renders the exact `synapse-vault-runtime` config
(a copy-paste `.env` block + a downloadable `anthropic-api-key` secret file). The
key never leaves the browser / never hits the operator server — templated
client-side. Makes model A visible on screen without custody.

## Error handling (cross-cutting)

Consistent with the existing tick discipline — nothing raises an unclassified
error into `tickOnce`'s failure counter:

- Messaging relayer/Walrus/Seal failure → `try/catch`, log + degrade.
- Missing API key → advisor returns transparent noop (unchanged).
- Gated tick with no stored prior weight → fall through to a real LLM call.
- `messagingInbox/Outbox = none` → messaging no-ops cleanly.

## Testing

- **`messaging.ts`** — unit-test `consumeSignals`/`emitSignal` with a faked
  messaging client: cursor advance, digest dedupe (no double `record_receive`),
  emit-only-on-rebalance, none-channel no-op, decrypt-failure degrade. No live
  network.
- **Tick-gating** — unit-test the `advise` wrapper with a stub `AdviseFn`: assert
  Claude is **not** called when under drift threshold AND within idle epochs;
  **is** called on drift breach; reuses stored weight when gated; first-run falls
  through. Call-count is the cost contract.
- **`secrets.ts`** — `anthropic_api_key` resolves from env and from file; trims;
  null when unset.
- **Existing `llm-advisor` tests** — stay green (injected `advise` path
  unchanged).
- **Live smoke (manual, testnet)** — one daemon tick on the paired demo vaults:
  consume a seeded message, emit on a rebalance, confirm `record_send` /
  `record_receive` digests + a real Walrus message blob. Reuses the two vaults
  already wired.
