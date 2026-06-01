<p align="center">
  <img src="assets/logo.png" alt="Synapse Vault" width="150" />
</p>

<h1 align="center">Synapse Vault</h1>

<p align="center"><b>Autonomous AI treasury management on Sui — powered by Walrus.</b></p>
<p align="center"><i>Hire an AI portfolio manager. Pay it in basis points. Revoke it in one click.<br>Every decision is remembered, audited, and provable — on Walrus.</i></p>

<p align="center">
  <a href="https://synapse-kappa-sable.vercel.app">Live demo</a> ·
  <a href="https://github.com/SuyashAlphaC/Synapse">Code</a> ·
  Sui Overflow 2026 · Walrus Track
</p>

---

Built for **Sui Overflow 2026 — Walrus Track**.

- **Code:** this repo (Move + TypeScript SDK + Next.js dashboard)
- **Marketing site (Walrus Sites, testnet):** Site object `0x55c33a39757a4487ca8cebdaffd5b7b9f9ba9601456a82ef5f031c689ae0001a`

---

## 1. What it is

It's 2026 and AI agents run everywhere — but the moment you let one **touch money**, every option is broken:

| What you can do today | Why it breaks |
|---|---|
| Give the AI a hot wallet | One bad prompt drains it. No safety net. |
| Human approves every tx | Kills the point of automation. |
| Centralized custodian | Back to trusting one company. |
| Multisig the AI | Slow, fragile, needs coordinated signers. |

**There is no infrastructure layer for giving AI agents *controlled* financial autonomy.** Synapse Vault is that layer.

### The core idea (three sentences)

1. **The smart contract holds the money** — not the AI, not us, not anyone.
2. **The AI only proposes** trades through a Sui transaction; the Move VM **enforces** hard rules — max spend per epoch, allowlisted contracts only, expiry, instantly revocable.
3. **The owner holds one key — the kill switch.** One signature ends the AI's authority forever.

The AI can be the smartest model on earth or a buggy weekend hack. The blockchain rejects any transaction that breaks the rules the owner set at mint.

### Why Walrus

A treasury agent is only trustworthy if you can **see what it did and why, across time**. That requires durable, verifiable, portable memory — not a database one company controls. Synapse uses Walrus as the **verifiable data platform for the agent**:

- **MemWal** — the agent's long-term memory (recall past decisions every tick).
- **Walrus blobs** — every tick's full rationale stored as a tamper-evident audit artifact.
- **Seal** — private artifacts encrypted, decryptable only by the vault's key.
- **Walrus Sites** — the product's front door, served from Walrus itself.

---

## 2. Walrus Track — requirement coverage

Mapped 1:1 to the official problem statement. **LIVE** = exercised on testnet (tx / round-trip cited). **CODE-COMPLETE** = built + typecheck/test-verified; final live run is operator-side (needs a funded wallet or API key).

### Core deliverables

| Track ask | Status | How Synapse does it |
|---|---|---|
| **Long-term, verifiable memory** | **LIVE** | MemWal `recall`/`remember` every tick (`sdk/packages/memwal-bridge`). Strategy counters/EMA/decisions persist across ticks and process restarts. Browse + semantically query a vault's memory in the **MemWal recall panel** (dashboard). |
| **Persistent data/files via Walrus** | **LIVE** | A markdown audit report is uploaded to Walrus **every tick**; an on-chain `ArtifactRef` (`artifacts.move`) links the blob + sha256. Browse and open the raw blob from the **Artifacts panel**. |
| **Integrations/tooling for devs** | **LIVE** | `@synapse-core/adapter-langgraph` — a LangGraph `BaseStore` backed by MemWal/Walrus. Drop it into any LangGraph agent for Walrus-durable memory. 8 unit tests + runnable example + README. |

### Especially-interested-in

| Track ask | Status | How |
|---|---|---|
| **Long-running stateful workflow** | **LIVE** | The trading agent ticks 24/7; the headless runtime resumes on restart with state from MemWal. |
| **Multi-agent coordination** | **LIVE** | Two vaults sharing a MemWal namespace; a reader recalls a peer's memory and attests it on-chain. CLI `synapse-cross-agent-read`. Verified tx `AQQZhQRQZ8vK1Y7zPrxaGT7MS9cRkVAoXLYHvSSEDzRm` (`CrossAgentReadEvent`). |
| **Artifact-driven workflows** | **LIVE** | Agent generates audit reports → stores on Walrus → a peer **reuses** them via cross-agent recall. |

### Tooling axis + named references

| Ask / reference | Status | How |
|---|---|---|
| Add memory to existing agent frameworks | **LIVE** | LangGraph adapter (above). |
| Cross-tool / cross-agent memory sharing | **LIVE** | Shared MemWal namespace, read + write, attested on-chain. |
| Inspect / debug agent memory on Walrus | **LIVE** | Dashboard recall panel (semantic query → SEAL-decrypted hits → Walrus blob links) + Artifacts panel + on-chain audit timeline. |
| **Seal** | **LIVE** | `synapse_seal` policy package published at `0x14a1cbc600affc135510237ad779f19f924dfb2a6ee068b9b85f2c59d69bc91a`. Full encrypt → `seal_approve` → decrypt round-trip verified against the live testnet key servers. |
| **Walrus Sites** | **LIVE** | Marketing site published to Walrus Sites — Site object `0x55c33a39…001a` (`web/site/`). |
| **Sui Stack Messaging** | **CODE-COMPLETE** | Real `@mysten/messaging` send (Walrus-stored, Seal-encrypted) + on-chain `messaging_bridge::record_send/record_receive` correlator (`examples/messaging-demo`). Isolated package — the SDK pins sui 1.x, the main repo is on sui 2.x. Typecheck-verified; live channel creation is operator-side. |
| **Functional AI agent (LLM in the loop)** | **LIVE (Walrus-loaded)** | The `llm-advisor` strategy: Claude reasons over the live market **and the vault's recalled MemWal memory** to set the target allocation; the audited rebalancer executes it within on-chain policy. Closes **recall → reason → act → remember**. Published as a Walrus-loaded marketplace strategy and dispatched on testnet (`dispatching to Walrus-loaded marketplace strategy`). Needs an Anthropic API key on the runtime; degrades to a transparent noop without one. |
| Cryptographic revocation cascade | **LIVE** | On-chain revoke + owner-signed MemWal delegate removal. |

---

## 3. The moat (the one page that matters)

**The smart contract is the only thing that can move money.** The AI proposes; the Move VM approves or aborts — atomically, every spend:

```move
public(package) fun assert_can_act(identity: &AgentIdentity, ctx: &TxContext) {
    assert!(!identity.revoked, ERevoked);                           // not killed
    assert!(ctx.sender() == identity.session_addr, ENotAuthorized); // signed by agent key
    assert!(ctx.epoch() < identity.expiry_epoch, EExpired);         // before expiry
}
public(package) fun assert_package_allowed(identity: &AgentIdentity, pkg: address) {
    assert!(identity.approved_packages.contains(&pkg), ENotWhitelisted);
}
public(package) fun record_spend(identity: &mut AgentIdentity, amount: u64) {
    assert!(identity.spent_this_epoch + amount <= identity.spend_per_epoch, EOverBudget);
}
```

A compromised runtime can't bypass these. A jailbroken LLM can't. The protocol authors can't. The chain literally aborts the transaction. Everything else — the marketplace, zkLogin onboarding, the dashboard, the Walrus audit trail — exists to demonstrate this one claim.

---

## 4. Architecture

### Move — `move/synapse_core` (Sui Move 2024)

| Module | Responsibility |
|---|---|
| `agent.move` | `AgentIdentity` spine: identity, treasury, MemWal bridge, messaging channels, artifacts, revocation, the policy gates above. |
| `wallet.move` | `spend<T>` / `withdraw<T>` / `drain<T>` behind the four-layer policy gate. |
| `strategy_registry.move` | The marketplace: `Strategy` shared objects, versioning, royalty rules, lifetime reputation; `StrategistCap` gates governance; `record_tick_performance` + `pay_strategist_royalty`. |
| `artifacts.move` | Walrus blob registry as dynamic fields on the AgentIdentity (`ArtifactRef`: blob id + sha256 + seal flag). |
| `coordination.move` | Multi-agent shared-namespace gates (`record_cross_agent_read`, `record_artifact_share`). |
| `messaging_bridge.move` | Sui Stack Messaging audit correlator (`record_send` / `record_receive`). |
| `attestation.move` | Unified action log across every subsystem. |
| `deepbook_adapter.move` | DeepBookV3 swap policy gate + audit — composable, not wrapping. |

Plus `move/synapse_seal` — a standalone Seal access-policy package (`policy::seal_approve`, identity-prefix access).

### TypeScript SDK — `sdk/packages`

| Package | What |
|---|---|
| `client` | Sui PTB builders (agent, wallet, artifacts, zkLogin) + Seal wrapper + Walrus upload. |
| `vault` | The runtime: strategy engine, rebalance executor, audit-report generator, MemWal recall/remember, Walrus publisher, headless `bin/run.ts`, secrets provider, fail-safe tick loop. |
| `memwal-bridge` | Synapse-aware wrapper over MemWal (`recall`/`remember`, namespace-keyed). |
| `indexer` | Event indexer (timeline + artifacts). |
| `adapters/langgraph` | LangGraph `SynapseStore` (Walrus-durable agent memory). |

### Dashboard — `web/dashboard` (Next.js)

Mint wizard (zkLogin or wallet), marketplace with real backtest curves, per-vault dashboard (holdings, NAV, policy, deposit, fund-session-gas, audit timeline, **MemWal recall panel**, **Artifacts panel with Seal decrypt**, in-browser runtime, danger zone with revoke cascade).

### The runtime tick (recall → reason → act → remember)

1. Load on-chain agent state + Pyth prices + DeepBook spreads.
2. **Recall** the strategy's memory from MemWal.
3. **Reason**: the strategy (deterministic, or the LLM advisor calling Claude over recalled memory) emits a decision.
4. **Act**: one PTB — policy-gated DeepBook swap + `record_tick_performance` + royalty payout.
5. Upload the rationale to **Walrus** + register the on-chain `ArtifactRef`.
6. **Remember**: persist the decision outcome to MemWal for the next tick.

---

## 5. Real-world use cases

- **DAO treasury management.** A DAO mints a vault, funds it, hires a conservative rebalancer or the AI advisor, sets a 5%/epoch spend cap, and keeps the revoke key in its multisig. The agent rebalances 24/7; every action is on-chain + on Walrus for the community to audit.
- **Fund / SMA automation.** A quant desk runs many vaults (one per client mandate) off the same headless runtime image, each with its own policy envelope. Walrus gives every client a tamper-evident statement of what ran and why.
- **Strategy marketplace for quants.** A strategist publishes a strategy on-chain, earns a royalty (paid atomically in the rebalance PTB) on every vault that hires it. Reputation (lifetime alpha, vault count) accrues on-chain.
- **Agent memory infrastructure (dev tooling).** Any LangGraph / agent builder drops in `SynapseStore` to get Walrus-durable, verifiable, revocable memory — without the treasury product at all.
- **Auditor / compliance.** A regulator verifies agent behavior from on-chain events + Walrus rationale blobs, with no access to the operator's systems.

---

## 6. Go-to-market

**Two layers, two motions.**

| Layer | What | Motion | Revenue |
|---|---|---|---|
| **Synapse Vault** (product) | Hosted / self-hosted AI treasury manager. | Land DAOs and on-chain funds that already hold idle treasury and want automation without custody risk. | 1% AUM + 0.5% performance fee on realized alpha (both enforced on-chain). |
| **Synapse Core** (open infra) | Move modules + SDK + adapters, open source. | Developer-led growth: anyone builds agents on the policy + Walrus-memory primitives; the LangGraph adapter is the wedge. | Ecosystem + marketplace royalties flowing through the protocol. |

**Sequencing.** (1) Testnet + design-partner DAOs running real funds. (2) Seed an honest marketplace with external strategists. (3) Mainnet cutover (package + DEEP funding + a funded dry-run). (4) Managed hosting ("Synapse runs your agent") for DAOs that don't want to touch infra, alongside the self-host path.

**Why we win.** Competitors put the agent behind a TEE or a trusted operator. Synapse puts the guarantees **on-chain** — the policy envelope is enforced by Move, the memory + audit trail live on Walrus (portable, not ours to censor), and the kill switch is one owner signature. The trust model is verifiable, not promised.

---

## 7. On-chain deployments (testnet)

| Thing | ID |
|---|---|
| `synapse_core` (latest, v3) | `0xd849b7b281cdc030daf4e2269a36e85e285edd44849b481eb6da49aed1978f01` |
| `synapse_core` history (v2, v1) | `0x5da36d892956a4659415e245126a3964dd5aa6cf19ec2fdf6332bf828a4c58ed`, `0x7b3f59e42edbf2189df644e63162d0b9a2c2984755bab9d3e9557c4ddd4aa67c` |
| `synapse_seal` (Seal policy) | `0x14a1cbc600affc135510237ad779f19f924dfb2a6ee068b9b85f2c59d69bc91a` |
| Walrus Site (marketing) | `0x55c33a39757a4487ca8cebdaffd5b7b9f9ba9601456a82ef5f031c689ae0001a` |

---

## 8. Run it

```bash
# install (workspace)
npm install

# dashboard (local dev)
cd web/dashboard && npm run dev          # http://localhost:3001

# headless runtime — one tick (server-side; the autonomous loop drops --once)
node sdk/packages/vault/dist/runtime/bin/run.js --once
#   env: SYNAPSE_PACKAGE_ID, SYNAPSE_PACKAGE_HISTORY, SYNAPSE_AGENT_ID,
#        SYNAPSE_SESSION_KEY_PATH (the vault .key), SYNAPSE_WALRUS_NETWORK=testnet
#   for the AI advisor strategy: ANTHROPIC_API_KEY

# headless runtime — Docker (secrets mounted as files)
docker compose up --build

# Move tests
cd move/synapse_core && sui move test
cd move/synapse_seal && sui move test

# SDK tests
npm --workspace @synapse-core/vault test             # 67 tests
npm --workspace @synapse-core/adapter-langgraph test # 8 tests
```

---

## 9. Verification

```
move:                      synapse_core + synapse_seal — sui move test clean
sdk/packages/vault:        67 tests (secrets, logger redaction, alerts,
                           walrus-loader allowlist, runtime fail-safe, llm-advisor)
adapters/langgraph:        8 tests (put/get/recall/tombstone/search/filter)
dashboard:                 strict typecheck + production build (11/11 prerender)
CI:                        GitHub Actions — typecheck + tests + secret-leak scan + Docker build
```

Live-verified on testnet: full mint → tick → DeepBook swap → Walrus artifact → MemWal recall; Seal encrypt/decrypt round-trip; cross-agent read (`CrossAgentReadEvent`); Walrus-loaded LLM strategy dispatched.

---

## 10. Honest status

| Item | Note |
|---|---|
| Mainnet | Testnet only. Mainnet is a deliberate cutover (publish gas + real DEEP funding + a funded dry-run). |
| Sui Stack Messaging | Built + typecheck-verified; live channel creation needs a funded owner wallet (operator-side). |
| DEEP fee path | Testnet pools accept a zero-DEEP swap; mainnet needs the treasury to hold DEEP. Documented in `deepbook.ts`. |
| Third-party audit | Not done. The threat model, the Walrus-strategy allowlist, and CI cover the intent; a professional audit precedes mainnet. |
| AI advisor | Server-side only — the browser in-tab runtime excludes `@anthropic-ai/sdk` and degrades to a noop. |

---

## 11. Security

See **[THREAT_MODEL.md](./THREAT_MODEL.md)** — session-key compromise, Walrus-loaded code injection, MemWal namespace poisoning, oracle manipulation, key custody, and the mitigations built into the architecture.

---

## 12. Repo layout

```
move/synapse_core        8 Move modules — the policy engine + marketplace
move/synapse_seal        Seal access-policy package
sdk/packages/*           client · vault (runtime) · memwal-bridge · indexer · adapters/langgraph
web/dashboard            Next.js app (mint, marketplace, per-vault dashboard)
web/site                 marketing site (Walrus Sites)
examples/messaging-demo  Sui Stack Messaging integration (isolated, sui 1.x)
infrastructure/aws       CDK + secret-push scripts for hosted deployment
scripts                  backtests, dev utilities, CI checks
```
