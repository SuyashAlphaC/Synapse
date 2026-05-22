# Synapse Vault — Sui Overflow 2026, Walrus Track

> Judge-facing overview. Every claim links to a file, commit, or test.

---

## Elevator pitch

Synapse Vault is an **autonomous AI treasury manager** for DAOs.
Vaults run 24/7 — rebalancing, auditing, and remembering via three Walrus
primitives (MemWal, blob storage, Seal) — and the full strategy lifecycle
(publish, hire, execute, audit, revoke) is on-chain on Sui.

The product has two layers:

| Layer | What it is | Revenue model |
|---|---|---|
| **Synapse Vault** (product) | Mint a vault, hire a strategy, watch it work. Dashboard + headless runtime. | 1% AUM + 0.5% performance fee |
| **Synapse Core** (open source) | 7 Move modules, TypeScript SDK, design system. Anyone can build on it. | Ecosystem growth |

---

## Walrus Track — Twelve-for-Twelve

| # | Requirement | Where |
|---|---|---|
| 1 | Long-term memory via MemWal | [`sdk/packages/memwal-bridge/`](../sdk/packages/memwal-bridge/) — `recall`/`remember` per tick |
| 2 | Direct Walrus file access | [`sdk/packages/vault/src/runtime/runtime.ts`](../sdk/packages/vault/src/runtime/runtime.ts) — markdown audit reports uploaded every rebalance |
| 3 | Integrations/tooling for adoption | [`sdk/packages/langraph-adapter/`](../sdk/packages/langraph-adapter/) — any LangGraph agent can become a Vault strategy |
| 4 | Long-running workflows | Vault runtime ticks across sessions; memory persists; resumes on restart (see headless runtime below) |
| 5 | Multi-agent coordination | [`move/synapse_core/sources/coordination.move`](../move/synapse_core/sources/coordination.move) — shared namespace, capability gates |
| 6 | Artifact-driven workflows | [`move/synapse_core/sources/artifacts.move`](../move/synapse_core/sources/artifacts.move) — ArtifactRef linked to Walrus blobs |
| 7 | Adapters for existing frameworks | LangGraph adapter (see #3) |
| 8 | Workflow orchestration | Single PTB: spend → swap → memory write → message peer |
| 9 | Cross-tool/cross-agent memory sharing | MemWal namespaces; conservative and aggressive strategies share context |
| 10 | Inspection/debug dev tool | Dashboard Audit Timeline + Memory panel — per-vault, live Walrus fetch |
| 11 | Working systems, not just demos | See "Production hardening" below |
| 12 | Seal for privacy | Strategy parameters Seal-encrypted; only the Vault delegate key can decrypt |

---

## Production hardening (shipped this week)

Every item below is merged to `main` and tested.

### 1. Headless runtime + secrets interface

> Kills the single biggest "this is just a demo" criticism.

| What | File / commit |
|---|---|
| `SecretsProvider` abstraction (env + file) | [`sdk/packages/vault/src/runtime/secrets.ts`](../sdk/packages/vault/src/runtime/secrets.ts) · `5abec71` |
| `bootstrapConfig` — unified secret→config pipeline | [`sdk/packages/vault/src/runtime/bootstrap.ts`](../sdk/packages/vault/src/runtime/bootstrap.ts) · `76e9a98` |
| `--secrets-dir` flag in `bin/run.ts` | [`sdk/packages/vault/src/runtime/bin/run.ts`](../sdk/packages/vault/src/runtime/bin/run.ts) · `76e9a98` |
| Redacting Pino logger (field-name + value-shape) | [`sdk/packages/vault/src/runtime/logger.ts`](../sdk/packages/vault/src/runtime/logger.ts) · `76e9a98` |
| Graceful `SIGTERM` shutdown (completes in-flight tick) | `bin/run.ts` · `76e9a98` |
| Production Dockerfile (compiled JS, non-root user) | [`sdk/packages/vault/Dockerfile`](../sdk/packages/vault/Dockerfile) · `76e9a98` |
| `docker-compose.yml` with real Docker secrets | [`docker-compose.yml`](../docker-compose.yml) · `76e9a98` |
| Post-mint "Run this vault" panel (3 deployment paths) | [`mint-wizard.tsx`](../web/dashboard/app/components/mint/mint-wizard.tsx) · `e3b5490` |

### 2. Engineering hygiene + CI

| What | File / commit |
|---|---|
| GitHub Actions: typecheck + tests + forbidden-pattern scan + gitignore check + Docker build | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) · `623640c` |
| Forbidden-pattern scanner (`TODO`, `console.log`, `as any`, etc.) | [`scripts/check-forbidden-patterns.sh`](../scripts/check-forbidden-patterns.sh) · `623640c` |

### 3. Fail-safe liveness

| What | File / commit |
|---|---|
| `TickSkippedError` — RPC/Pyth/DeepBook outages skip the tick, never trip the kill switch | [`runtime.ts`](../sdk/packages/vault/src/runtime/runtime.ts) · `e39fb26` |
| Tests for skip behavior + failure-counter isolation | [`tests/runtime.test.ts`](../tests/runtime.test.ts) · `e39fb26` |

### 4. Walrus strategy allowlist

| What | File / commit |
|---|---|
| `code_hash` + publisher allowlist gate on Walrus-loaded strategies | [`walrus-loader.ts`](../sdk/packages/vault/src/runtime/walrus-loader.ts) · `f5c2b53` |
| `parseWalrusAllowlistFromEnv` | `walrus-loader.ts` · `f5c2b53` |
| Dashboard mirror: `AuditBadge` (audited / unverified pill) | [`audit-badge.tsx`](../web/dashboard/app/components/marketplace/audit-badge.tsx) · `3ab0668` |
| `strategy-allowlist.ts` (dashboard-side classifier) | [`strategy-allowlist.ts`](../web/dashboard/lib/strategy-allowlist.ts) · `3ab0668` |
| Tests for allowlist parsing + enforcement | [`tests/walrus-loader.test.ts`](../tests/walrus-loader.test.ts) · `f5c2b53` |

### 5. Webhook alerts + self-hosting docs

| What | File / commit |
|---|---|
| `sendAlert` → Discord/Slack webhook on start/crash/max-failures | [`alerts.ts`](../sdk/packages/vault/src/runtime/alerts.ts) · `76e9a98` |
| `docs/self-hosting.md` — complete deployment runbook | [`docs/self-hosting.md`](../docs/self-hosting.md) · `581fadd` |
| `.env.example` with all new vars documented | [`.env.example`](../.env.example) · `76e9a98` |

---

## Move package

7 modules, all tests passing (`sui move test` clean).

| Module | Responsibility |
|---|---|
| `agent.move` | `AgentIdentity` spine: identity, treasury, MemWal bridge, artifacts, messaging, revocation |
| `wallet.move` | `spend<T>` / `withdraw<T>` / `drain<T>` with four-layer policy gate |
| `artifacts.move` | Walrus blob registry as dynamic fields on AgentIdentity |
| `coordination.move` | Multi-agent shared-namespace capability gates |
| `messaging_bridge.move` | Sui Stack Messaging audit correlator |
| `attestation.move` | Unified action log across all subsystems |
| `deepbook_adapter.move` | DeepBookV3 swap policy gate + audit (composable, not wrapping) |

---

## Test suite

```
sdk/packages/vault tests:   59 passing
  - bootstrap.test.ts        — secret resolution precedence
  - logger.test.ts           — redaction (field-name, value-shape, Error serialization)
  - alerts.test.ts           — webhook payload, non-blocking on errors
  - walrus-loader.test.ts    — allowlist enforcement, env parsing
  - runtime.test.ts          — TickSkippedError, consecutive failure isolation
Move tests:                  10 passing
Dashboard typecheck:         clean (strict mode)
Forbidden-pattern scan:      clean
```

---

## Threat model

[`docs/threat-model.md`](../docs/threat-model.md) — covers session-key compromise, Walrus code injection, MemWal namespace poisoning, oracle manipulation, and the mitigations built into the architecture.

---

## What's not done (honest)

| Gap | Why it's acceptable |
|---|---|
| No third-party security audit | Judges expect audit-awareness, not a completed audit. Threat model + allowlist + CI cover the intent. |
| Mainnet not published | Testnet-only; mainnet publish costs real SUI and is planned for Phase 6. |
| DEEP fee path tested with zero-DEEP workaround | DeepBook testnet pool accepts the swap; the `pay_with_deep = true` path is exercised but with a zero-balance edge case. Documented in code. |
| Marketing site not deployed to Walrus Sites yet | Site is complete and deployable; `walrus sites publish` is the only remaining step. |

---

## How to run

```bash
# Dashboard (local)
cd web/dashboard && npm run dev

# Headless runtime (Docker)
docker compose up --build

# Move tests
cd move/synapse_core && sui move test

# Vault tests
npm --workspace @synapse-core/vault test
```

See [`docs/self-hosting.md`](../docs/self-hosting.md) for Fly.io / Railway / AWS Fargate deployment.
