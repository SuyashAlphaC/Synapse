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

Mapped 1:1 to the official problem statement. **LIVE** = exercised on
testnet (tx / round-trip cited). **PROTOCOL-READY** = Move module + SDK in
place, not yet wired into a live demo flow (flagged honestly).

### Core deliverables

| Ask | Status | Evidence |
|---|---|---|
| **Long-term memory** (persistent, verifiable) | **LIVE** | MemWal `recall`/`remember` every tick — [`memwal-bridge`](../sdk/packages/memwal-bridge/); DCA counters + EMA persist across ticks/restarts. Browser recall panel: [`memwal-recall-panel.tsx`](../web/dashboard/app/components/dashboard/memwal-recall-panel.tsx) · `b205e63` |
| **Persistent data/files via Walrus** | **LIVE** | Markdown audit report uploaded to Walrus every tick — [`runtime.ts`](../sdk/packages/vault/src/runtime/runtime.ts); `ArtifactRef` on-chain — [`artifacts.move`](../move/synapse_core/sources/artifacts.move); browse + open raw blob in the Artifacts panel |
| **Integrations/tooling for devs** | **LIVE** | LangGraph `SynapseStore` (`BaseStore` → MemWal/Walrus) — [`adapters/langgraph`](../sdk/packages/adapters/langgraph/) with 8 unit tests + runnable example + README · `d3077cd` |

### Especially interested in

| Ask | Status | Evidence |
|---|---|---|
| **Long-running stateful workflow** | **LIVE** | Trading agent ticks 24/7; headless runtime resumes on restart; state in MemWal |
| **Multi-agent coordination** | **LIVE** | Two vaults, shared MemWal namespace, reader recalls writer's memory + attests on-chain — `synapse-cross-agent-read` CLI · `26f5e31`. Verified tx `AQQZhQRQZ8vK1Y7zPrxaGT7MS9cRkVAoXLYHvSSEDzRm` (`CrossAgentReadEvent`) |
| **Artifact-driven workflows** | **LIVE** | Agent generates audit reports → stores on Walrus → **reused** via cross-agent read (a peer recalls the artifact's memory) |

### Tooling axis + named references

| Ask / reference | Status | Evidence |
|---|---|---|
| Add memory to existing frameworks | **LIVE** | LangGraph adapter (above) |
| Cross-tool/cross-agent memory sharing | **LIVE** | Shared MemWal namespace, read + write, attested on-chain (cross-agent read tx above) |
| Inspect/debug agent memory on Walrus | **LIVE** | Recall panel (semantic query → SEAL-decrypted hits → Walrus blob links) + Artifacts panel + audit timeline |
| **Seal** (named ref) | **LIVE** | `synapse_seal` policy published `0x14a1cbc6…69bc91a`; encrypt→`seal_approve`→decrypt round-trip verified · `44f18b3` · [`docs/SEAL.md`](./SEAL.md) |
| **Walrus Sites** (named ref) | **LIVE** | Marketing site published to Walrus Sites — Site object `0x55c33a39…001a` · [`web/site/`](../web/site/) |
| **Sui Stack Messaging** (named ref) | **CODE-COMPLETE** | Real `@mysten/messaging` send (Walrus-stored, Seal-encrypted) + on-chain `record_send`/`record_receive` correlator — [`examples/messaging-demo`](../examples/messaging-demo/). Isolated package (SDK pins sui 1.x; ours is 2.x). Typecheck-verified; live run pending a funded owner wallet |
| Cryptographic revocation cascade | **LIVE** | On-chain revoke + owner-signed MemWal delegate removal — [`danger-zone.tsx`](../web/dashboard/app/components/dashboard/danger-zone.tsx) · `5274518` |

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

### 5. Walrus Sites deployment

| What | File / commit |
|---|---|
| Marketing site deployed to Walrus Sites (testnet) | [`web/site/`](../web/site/) — Site Object `0x55c33a…001a` |
| `dashboard-link.js` — portable dashboard URL rewriter | [`web/site/dashboard-link.js`](../web/site/dashboard-link.js) |
| `ws-resources.json` — routes, headers, metadata | [`web/site/ws-resources.json`](../web/site/ws-resources.json) |

### 6. Webhook alerts + self-hosting docs

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
sdk/packages/vault tests:        59 passing
  - bootstrap / secrets          — secret resolution precedence
  - logger                       — redaction (field-name, value-shape, Error)
  - alerts                       — webhook payload, non-blocking on errors
  - walrus-loader                — allowlist enforcement, env parsing
  - runtime                      — TickSkippedError, failure isolation
adapters/langgraph tests:         8 passing
  - synapse-store                — put/get/recall/tombstone/search/filter
Move tests:                      synapse_core + synapse_seal — clean
Dashboard typecheck + build:     clean (strict mode, 11/11 prerender)
Forbidden-pattern scan:          clean
```

---

## Threat model

[`docs/threat-model.md`](../docs/threat-model.md) — covers session-key compromise, Walrus code injection, MemWal namespace poisoning, oracle manipulation, and the mitigations built into the architecture.

---

## What's not done (honest)

| Gap | Why it's acceptable |
|---|---|
| Sui Stack Messaging not run end-to-end | Full real flow is built + typecheck-verified ([`examples/messaging-demo`](../examples/messaging-demo/)); channel creation needs a funded owner wallet, so the live run is operator-side (same model as the Seal publish). |
| No third-party security audit | Judges expect audit-awareness, not a completed audit. Threat model + allowlist + CI cover the intent. |
| Mainnet not published | Testnet-only; mainnet publish costs real SUI and is planned for Phase 6. |
| DEEP fee path tested with zero-DEEP workaround | DeepBook testnet pool accepts the swap; the `pay_with_deep = true` path is exercised but with a zero-balance edge case. Documented in code. |
| Marketing site on testnet only | Deployed to Walrus Sites testnet (`0x55c33a39757a4487ca8cebdaffd5b7b9f9ba9601456a82ef5f031c689ae0001a`). Mainnet deploy is a single `site-builder` command with a mainnet wallet. |

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
