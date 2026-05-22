# Synapse Vault

> **Autonomous AI Treasury Management on Sui.**
> Hire an AI portfolio manager. Pay it in basis points. Revoke it in one click.

**Sui Overflow 2026 Submission** · Walrus Specialized Track (Headline Partner)
**Building Period:** May 7 – June 21, 2026 · **Submission Deadline:** June 21, 2026
**Mainnet Target:** August 20, 2026 (captures full $35K prize upfront)

---

## The Product

**Synapse Vault** is an autonomous AI treasury manager that DAOs and tokenized RWA fund managers can hire today. It rebalances portfolios, executes trades on DeepBookV3, and produces a cryptographically auditable record of every decision — all within hard policy bounds the human owner sets at mint time.

| | |
|---|---|
| **Customer** | DAOs with $10M+ treasuries · Tokenized RWA fund managers · Crypto-native asset managers |
| **Revenue model** | **1% AUM** annually (industry standard) + **0.5% performance fee** on alpha vs benchmark |
| **Realistic Y1 ARR** | $50K – $500K from 3–5 early design partners |
| **TAM** | $30B+ (DAO treasuries $5B+ · Tokenized RWA $24B+ · Crypto-native funds $2B+) |
| **Sales cycle** | 2–6 weeks (crypto-native, not enterprise) |

### Why Synapse Vault Exists

Every DAO, every tokenized fund manager, every crypto-native treasurer is asking the same question in 2026: *"Can we hire an AI to manage this?"*

The answer until now has been *no*, for four reasons:

1. **No agent-level audit trail** — compliance can't sign off without one.
2. **No spending controls** — CFOs can't approve an AI that holds unbounded keys.
3. **No atomic kill switch** — CISOs can't deploy without an instant off-button.
4. **Custodial AI agents** (Coinbase AgentKit, Crossmint) push the policy boundary off-chain, where it can't be cryptographically verified.

Synapse Vault is the first AI treasury manager that solves all four. Underneath, it's powered by **Synapse Core** — the identity, policy, and coordination substrate we built because no one else had.

---

## Two-Layer Architecture

### Layer 1: Synapse Vault (the product)

The user-facing autonomous AI treasury manager. DAOs and fund managers hire a Vault, fund it, and let it rebalance their portfolio according to a strategy they pick (or write themselves). Every decision is recorded as a Walrus artifact. Every action passes through hard on-chain policy gates.

### Layer 2: Synapse Core (the substrate)

The composable identity + policy + coordination layer for ANY autonomous AI agent on Sui. Synapse Vault is the canonical reference implementation, but any other team can build their own vertical agent product on top of `@synapse-core/client`:

| What Synapse Core Provides | Examples of Apps That Could Be Built |
|---|---|
| `AgentIdentity` on-chain object with policy enforcement | Autonomous trading bots (retail or pro) |
| MemWal-backed long-term memory | AI research assistants with audit |
| Walrus artifact registry | AI content studios with provenance |
| Policy-bounded wallet (allowlist + spend caps + expiry) | Autonomous SaaS billing agents |
| One-PTB revocation cascade | DAO compliance officers' kill-switch tooling |
| LangGraph framework adapter | Any agent workflow that needs Sui-native identity |

**This is the pitch arithmetic:** Synapse Vault has paying customers today (1% AUM revenue). Synapse Core captures the entire downstream ecosystem of vertical AI agent apps that will be built on Sui in the next 24 months.

---

## Track & Prizes

Synapse Vault is submitted to the **Walrus Specialized Track** (Headline Partner).

| Place | Prize |
|---|---|
| **1st** | **$35,000** |
| 2nd | $15,000 |
| 3rd | $7,500 |
| 4th | $5,000 |

**Award structure:** 50/50 split unless mainnet by August 27. We commit to mainnet by August 20 to capture the full 100% upfront.

---

## How Synapse Vault Works (End-to-End)

### 1. Mint a Vault

A DAO multisig (or any human via zkLogin) mints a Vault by submitting a single PTB:

```
1. zkLogin proves Google identity → RootIdentity
2. Generate ephemeral agent session keypair (Ed25519)
3. Provision MemWal delegate key for the Vault's strategy memory
4. PTB chain:
   - synapse_core::agent::new(...)       ← AgentIdentity
   - synapse_core::agent::fund<USDC>      ← seed treasury
   - synapse_core::agent::fund<SUI>       ← seed treasury
   - synapse_core::agent::attach_messaging  ← Sui Stack Messaging channels
   - synapse_core::agent::share           ← shared object on-chain
```

The Vault is now live, with policy hard-coded on-chain:
- Spend cap per epoch (e.g., 10% of AUM per 24h)
- Contract allowlist (DeepBookV3 SUI/USDC pool, OpenAI proxy)
- Expiry (e.g., 90 days; renewable by the owner)

### 2. Vault Runs (Autonomous Loop)

The Vault's runtime — a LangGraph-powered agent backed by Claude Opus 4.7 — executes continuously:

```
loop (every market interval):
    a. recall(MemWal): "What's our current strategy state? Past rebalance decisions?"
    b. fetch(DeepBookV3): current SUI/USDC orderbook + spread
    c. fetch(oracle): current prices + portfolio drift
    d. reason: should we rebalance? what trades?
    e. if yes:
        i.   generate audit report (markdown)
        ii.  publish report to Walrus via artifacts::publish
        iii. execute swaps via wallet::spend → DeepBookV3::swap
        iv.  log_action via attestation::log_action
        v.   remember(MemWal): "Rebalanced X→Y on date Z because reason W"
```

Every step is gated by Synapse Core's policy enforcement. No off-policy action can execute, even if the LangGraph runtime is compromised.

### 3. Owner Reviews Audit Trail

The DAO logs into the Vault dashboard:

- **Holdings view** — current treasury allocation, live PnL
- **Audit timeline** — every rebalance, every swap, every memory write, ordered by tx digest
- **Decision rationale** — each rebalance has a Walrus-stored markdown report explaining *why* the agent did what it did
- **Compliance export** — one-click PDF for board / auditor / regulator
- **Fee accrual** — 1% AUM streaming continuously into the protocol fee account

### 4. Owner Revokes (when needed)

One PTB cascade:
- Flips `AgentIdentity.revoked = true` → all session-key actions abort
- Emits `AgentRevokedEvent` → indexer triggers MemWal delegate invalidation + Walrus eviction signal
- Treasury can be drained back to owner via `wallet::drain<T>`

Total time from "agent went rogue" to "agent is dead and all funds reclaimed": **one transaction**. No multi-sig wait. No vendor approval. No off-chain coordination.

---

## Why Synapse Vault Wins on Real-World Application (50% of judging)

| Question | Answer |
|---|---|
| **Who pays for this?** | DAOs and tokenized RWA fund managers, in stablecoins, via a 1% AUM fee accrued on-chain. Identical economics to Yearn Vaults and BlackRock funds. |
| **How much?** | At 1% AUM, a single $10M DAO treasury client = $100K ARR. Five clients = $500K ARR. Top-50-DAO penetration alone = $50M+ ARR ceiling. |
| **What's the moat?** | Synapse Core's policy primitives. No centralized AI treasury service (Almanak, etc.) can match cryptographic kill-switch + audit + spending controls — those properties only exist on Sui. |
| **What's the sales cycle?** | 2–6 weeks crypto-native (DAOs governance vote → integration). Vs 18 months for enterprise asset managers. |
| **What's the regulatory story?** | Compliance officers reject custodial AI; they accept cryptographic policy enforcement. Synapse is the only architecture they'll sign off on. |
| **What's the path to mainnet?** | August 20, 2026 — well before the August 27 winners announcement deadline that captures the full prize. |
| **What's the long-term?** | Synapse Vault is the flagship vertical; Synapse Core captures the platform play across every other AI-agent vertical built on Sui in the next 24 months. |

---

## Walrus Track Requirements — Twelve-for-Twelve

Synapse Vault is the canonical Walrus track submission: every requirement is hit by something the Vault product actually does in production.

| # | Requirement | How Synapse Vault Implements It |
|---|---|---|
| 1 | Long-term memory via MemWal | Vault stores rolling strategy memory, past rebalance rationale, market context — recalled at every decision step |
| 2 | Direct Walrus file access | Every rebalance generates a markdown audit report stored directly on Walrus + registered as a Synapse `ArtifactRef` |
| 3 | Integrations/tooling for adoption | LangGraph adapter — any other LangGraph-built agent can plug into Synapse Core |
| 4 | Long-running workflows | Vault runs autonomously across sessions; memory persists; resumes on agent restart |
| 5 | Multi-agent coordination | Multiple Vault strategies (conservative, yield, market-making) share a MemWal namespace and pass artifacts via Sui Stack Messaging |
| 6 | Artifact-driven workflows | Markdown audit reports are real files generated by the agent and consumed by the dashboard |
| 7 | Adapters for existing frameworks | LangGraph implementation lets any LangGraph workflow become a Vault-managed strategy |
| 8 | Workflow orchestration (memory + messaging + execution) | All three integrated in one PTB: spend → swap → memory write → message peer |
| 9 | Cross-tool/cross-agent memory sharing | Strategy agents share namespace; conservative and aggressive strategies see each other's decisions |
| 10 | Inspection/debug dev tool | Dashboard's Audit Timeline + Memory panels — every decision with on-chain digest, recall trace, and live Walrus rationale fetch |
| 11 | Working systems, not just demos | LangGraph adapter + Vault dashboard are real software, runnable, contributable |
| 12 | Seal for privacy | Strategy parameters Seal-encrypted; only the Vault delegate key can decrypt |

---

## Synapse Core — The Substrate Underneath

For developers and the broader Walrus ecosystem, Synapse Core is the open-source primitive everyone else can build on. Already complete and verified.

### Move Package (7 modules, 10/10 tests passing)

| Module | Responsibility |
|---|---|
| `agent.move` | `AgentIdentity` spine: identity, treasury, MemWal bridge, artifacts, messaging, revocation |
| `wallet.move` | `spend<T>` / `withdraw<T>` / `drain<T>` with four-layer policy gate |
| `artifacts.move` | Walrus blob registry as dynamic fields on AgentIdentity |
| `coordination.move` | Multi-agent shared-namespace capability gates |
| `messaging_bridge.move` | Sui Stack Messaging audit correlator |
| `attestation.move` | Unified action log across all subsystems |
| `deepbook_adapter.move` | DeepBookV3 swap policy gate + audit (composable, not wrapping) |

### Client SDK (`@synapse-core/client`)

Full TypeScript surface against real upstream packages (`@mysten/sui` 2.16.2, `@mysten/walrus` 1.1.7, `@mysten/seal` 1.1.3, `@mysten-incubation/memwal` 0.0.3). PTB builders for every Move function. Walrus upload helpers. Seal encryption. Session-key management. zkLogin flow. All workspaces type-check clean in strict mode.

### Design System (`@synapse-core/design-tokens`)

Sui Overflow 2026 theme captured as code: cream + ink palette, vibrant accents, blueprint grid motif, Inter Display typography, sharp flat-shadow buttons. Tailwind preset + CSS custom properties + TypeScript tokens.

---

## Updated Build Plan

| Week | Deliverable |
|---|---|
| **Week 1 (May 13–19)** | ✅ `@synapse-core/memwal-bridge` real implementation · LangGraph adapter · Vault runtime loop · DeepBookV3 swap composition · Walrus artifact reports |
| **Week 2 (May 20–26)** | ✅ Runtime hardening (headless secrets seam · redacting logger · Walrus code-hash allowlist · fail-safe liveness · webhook alerts · CI · self-hosting docs) · funded-vault testnet rehearsal |
| **Week 3 (May 27–Jun 2)** | ✅ Vault Next.js dashboard (mint flow, holdings, audit timeline, revoke) · Indexer with Vault GraphQL views |
| **Week 4 (Jun 3–9)** | ✅ Landing site with pricing calculator (Walrus Sites deployable) · Demo video script and rehearsals |
| **Week 5 (Jun 10–16)** | Demo video recording · Threat model finalization · Final submission package |
| **Buffer (Jun 17–21)** | Bug fixes · Submission |
| **Phase 5 (Jul 8–20, if shortlisted)** | Live Demo Day pitch prep |
| **Phase 6 (Jul 22–Aug 20)** | Security review · Mainnet deployment (captures full 100% prize) |

### Scope Trade-offs

- **Drop**: Claude Agent SDK + Eliza adapters (post-hackathon). Only LangGraph for v1 since that's what Vault uses internally.
- **Drop**: standalone Memory Inspector. The Vault dashboard's Audit Timeline + Memory panel + Runtime Health cover the same use cases for the canonical product.
- **Add**: Vault product UI replaces generic dashboard. Real revenue-model landing page + pricing calculator. Real DeepBookV3 swap loop on testnet. Production-hardened headless runtime (see [`docs/self-hosting.md`](docs/self-hosting.md)).

---

## The Demo (≤5 min)

Single take, no cuts, real testnet transactions:

1. **0:00–0:30** — Problem: $5B in DAO treasuries managed by tired multisig committees. Show real DAO governance forum screenshots asking for AI treasury management.
2. **0:30–1:00** — Sign in with Google (zkLogin). Mint a Vault: $5K USDC + $5K SUI seed, conservative rebalancer strategy, 5% per-epoch spend cap, allowlist = DeepBookV3 SUI/USDC pool.
3. **1:00–2:00** — Vault runs. LangGraph agent reads MemWal memory, fetches DeepBookV3 orderbook, generates rebalance plan, writes Walrus audit report. Watch the report appear in the dashboard live.
4. **2:00–2:45** — Vault executes the rebalance: real PTB on testnet, real DeepBookV3 swap, single transaction. Sui explorer shows all effects atomically. Holdings update in dashboard.
5. **2:45–3:30** — Audit timeline view. Every decision linked to its Walrus artifact. Open one to read the rebalance rationale. Compliance-ready.
6. **3:30–4:00** — Pricing slide: "1% AUM, 0.5% performance fee." Calculator: $10M treasury → $100K ARR per client.
7. **4:00–4:30** — Click "Revoke." One PTB cascade: Vault frozen, MemWal delegates invalidated, Walrus artifacts queued for eviction. Drain residuals back to owner.
8. **4:30–5:00** — "Two layers: Synapse Vault (revenue-generating product) + Synapse Core (open-source substrate). Mainnet August 20."

---

## Run it yourself

The same `VaultRuntime` ships in the browser (demo only) and as a
headless Node container (production). Closing the dashboard tab does
**not** stop ticks once the headless runtime is hosted.

| Want to… | Read |
|---|---|
| Run a vault locally (or via cron) for $0 | [`docs/self-hosting.md`](docs/self-hosting.md) §3–4 |
| Deploy on Fly / Railway / Fargate | [`docs/self-hosting.md`](docs/self-hosting.md) §5–7 |
| Understand the security model | [`docs/threat-model.md`](docs/threat-model.md) |
| Reproduce the AWS Fargate cron stack | [`infrastructure/aws/README.md`](infrastructure/aws/README.md) |

The runtime is hardened for self-hosting: pluggable `SecretsProvider`
(env, Docker secret files, or AWS Secrets Manager), redacting logger
(secrets can never reach stdout), webhook alerts on failure, Walrus
strategy `code_hash` allowlist, transient-outage skip (Pyth/RPC blip
≠ runtime defect), and graceful SIGTERM shutdown.

CI (`.github/workflows/ci.yml`) gates every PR on typecheck, vault
tests, secret-leak scan, gitignore-of-key-paths, and a runtime Docker
build smoke.

---

## Repository Structure

```
synapse-core/                              monorepo root
├── README.md                              this file
├── handbook.txt                           Sui Overflow 2026 handbook reference
├── move/synapse_core/                     ✅ 7 modules, 10/10 tests
├── sdk/packages/
│   ├── client/                            ✅ Sui + Walrus + Seal + zkLogin SDK
│   ├── design-tokens/                     ✅ Overflow theme tokens
│   ├── memwal-bridge/                     ✅ Real MemWal SDK bindings
│   ├── vault/                             ✅ Strategy engine + executor + autonomous runtime
│   ├── adapters/
│   │   └── langgraph/                     ✅ LangGraph adapter
│   └── indexer/                           ✅ GraphQL indexer
├── web/
│   ├── dashboard/                         ✅ Vault product UI
│   └── site/                              ✅ Marketing + pricing calculator (Walrus Sites-ready)
└── docs/superpowers/plans/                ✅ Implementation plan
```

---

## References

- [Sui Overflow 2026](https://overflow.sui.io/) · [Participant Handbook](./handbook.txt)
- [Walrus Docs](https://docs.wal.app/) · [Walrus Sites](https://docs.wal.app/docs/sites)
- [MemWal Docs](https://docs.memwal.ai/) · [MemWal GitHub](https://github.com/MystenLabs/MemWal)
- [Seal Docs](https://seal-docs.wal.app/)
- [Sui Stack Messaging](https://github.com/MystenLabs/sui-stack-messaging)
- [DeepBookV3 Docs](https://docs.sui.io/onchain-finance/deepbookv3/deepbook)
- [Walrus Builder Telegram](https://go.sui.io/ofw-walrus-tg) · [Sui Overflow Telegram](https://go.sui.io/suioverflow2026-tg)

---

*Synapse Vault — built for Sui Overflow 2026 · Walrus Specialized Track · Headline Partner.*
*Synapse Core — the substrate underneath, free and open-source for the entire Sui ecosystem.*
