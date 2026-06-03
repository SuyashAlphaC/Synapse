<p align="center">
  <img src="assets/logo.png" alt="Synapse Vault" width="150" />
</p>

<h1 align="center">Synapse Vault</h1>

<p align="center"><b>Autonomous AI treasury management on Sui — powered by Walrus.</b></p>
<p align="center"><i>Hire an AI portfolio manager. Pay it in basis points. Revoke it in one click.<br>Every decision is remembered on Walrus, signed by an attested enclave, and verified on-chain before the trade.</i></p>

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

> **One product, one SDK.** **Synapse Vault** is the product you use — mint a vault, hire an agent, watch the leash. **Synapse Core** is the open Move + TypeScript layer underneath it that anyone can build on. When this README says "we win," it means the *assembly* — not that we invented the primitives (Move policy gates, Walrus memory, Seal, kill switches are all Sui-native building blocks; our edge is wiring them into one enforced envelope).

### The core idea (three sentences)

1. **The smart contract holds the money** — not the AI, not us, not anyone.
2. **The AI only proposes** trades through a Sui transaction; the Move VM **enforces** hard rules — max spend per epoch, allowlisted contracts only, expiry, instantly revocable.
3. **The owner holds one key — the kill switch.** One signature ends the AI's authority forever.

The AI can be the smartest model on earth or a buggy weekend hack. The blockchain rejects any transaction that breaks the rules the owner set at mint.

### Why Walrus

A treasury agent is only trustworthy if you can **see what it did and why, across time**. That requires durable, tamper-evident, portable memory — not a database one company controls. Synapse uses Walrus as the **tamper-evident data platform for the agent**:

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
| **Sui Stack Messaging** | **LIVE** | Real `@mysten/messaging` send (Walrus-stored, Seal-encrypted) + on-chain `messaging_bridge::record_send/record_receive` correlator. Wired **into the runtime tick** (`runtime/messaging.ts`): a vault consumes peers' signals from its inbox channel as memory facts and emits one on each rebalance. Live channel + message verified on testnet (`examples/messaging-demo`, isolated for the sui-1.x pin). |
| **Functional AI agent (LLM in the loop)** | **LIVE (Walrus-loaded)** | The `llm-advisor` strategy: Claude reasons over the live market **and the vault's recalled MemWal memory** to set the target allocation; the audited rebalancer executes it within on-chain policy. Closes **recall → reason → act → remember**. Walrus-published marketplace strategy, dispatched on testnet. **Tick-gated** (only calls the model on material drift/staleness) and reads a per-vault key from the secrets seam. |
| **Verifiable AI execution (Nautilus / TEE)** | **LIVE (dev enclave)** | The decision runs in an attested enclave (`enclave/`) that signs it; `synapse_core::decision_attestation` verifies the secp256k1 signature on-chain against the registered enclave **before the swap**. Opt-in per vault (`requires_attestation`) → the Move VM **refuses any unattested trade**. Proven on testnet: tx `7TLfyS6azzktKpbwBWBMV12hyV6hicNQZKip8weaAkPe` (`DecisionAttested`). Real-TEE deploy (Marlin Oyster / AWS Nitro) documented; the live proof used a registered dev box. |
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
// Opt-in: trades only execute after a TEE-attested decision this epoch.
public(package) fun assert_attested_if_required(identity: &AgentIdentity, ctx: &TxContext) {
    // aborts ENotAttested unless decision_attestation::attest_decision stamped this epoch
}
```

A compromised runtime can't bypass these. A jailbroken LLM can't. The protocol authors can't. The chain literally aborts the transaction. With `requires_attestation` enabled, even the vault's own runtime can't trade unless an **attested enclave** signed the exact decision — verified on-chain before the swap. Everything else — the marketplace, zkLogin onboarding, the dashboard, the Walrus audit trail — exists to demonstrate this one claim.

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
| `enclave.move` | Nautilus verifier: register an AWS Nitro enclave (`sui::nitro_attestation`), verify its secp256k1 signatures (`ecdsa_k1`) over a BCS intent message. |
| `decision_attestation.move` | The attested-execution gate: an enclave-signed `DecisionPayload` (vault, epoch, target weight, inputs hash) is verified + stamped on-chain; `agent::requires_attestation` makes `wallet::spend` abort without it. |

Plus `move/synapse_seal` — a standalone Seal access-policy package (`policy::seal_approve`, identity-prefix access).

### TypeScript SDK — `sdk/packages`

| Package | What |
|---|---|
| `client` | Sui PTB builders (agent, wallet, artifacts, zkLogin) + Seal wrapper + Walrus upload. |
| `vault` | The runtime: strategy engine, rebalance executor, audit-report generator, MemWal recall/remember, Walrus publisher, headless `bin/run.ts`, secrets provider, cross-agent messaging (`messaging.ts`), attested-execution client (`enclave-client.ts`), fail-safe tick loop. |
| `memwal-bridge` | Synapse-aware wrapper over MemWal (`recall`/`remember`, namespace-keyed). |
| `indexer` | Event indexer (timeline + artifacts). |
| `adapters/langgraph` | LangGraph `SynapseStore` (Walrus-durable agent memory). |

Plus `enclave/` — the **Nautilus decision enclave** (Node): runs the advisor inside an attested AWS Nitro enclave (Marlin Oyster, or a local dev box), signs each `DecisionPayload` with a secp256k1 key bound to the enclave's PCR measurement. The key never leaves the enclave.

### Dashboard — `web/dashboard` (Next.js)

Mint wizard (zkLogin or wallet), marketplace with real backtest curves, per-vault dashboard (holdings, NAV, policy, deposit, fund-session-gas, audit timeline, **MemWal recall panel**, **Artifacts panel with Seal decrypt**, in-browser runtime, danger zone with revoke cascade).

### The runtime tick (recall → reason → act → remember)

1. Load on-chain agent state + Pyth prices + DeepBook spreads.
2. **Recall** the strategy's memory from MemWal; **consume** any new cross-agent signals from the inbox channel as memory facts.
3. **Reason**: the strategy emits a decision — deterministic, the LLM advisor over recalled memory, or (attested vaults) the **enclave** which signs the target weight.
4. **Act**: one PTB — `[attest_decision verify]` → policy-gated DeepBook swap → `record_tick_performance` → capped royalty payout → `log_action` + `ArtifactRef`.
5. Upload the rationale to **Walrus**; **emit** a cross-agent signal on rebalance.
6. **Remember**: persist the decision outcome to MemWal for the next tick.

---

## 5. Real-world use cases

- **DAO treasury management.** A DAO mints a vault, funds it, hires a conservative rebalancer or the AI advisor, sets a 5%/epoch spend cap, and keeps the revoke key in its multisig. The agent rebalances 24/7; every action is on-chain + on Walrus for the community to audit.
- **Fund / SMA automation.** A quant desk runs many vaults (one per client mandate) off the same headless runtime image, each with its own policy envelope. Walrus gives every client a tamper-evident statement of what ran and why.
- **Strategy marketplace for quants.** A strategist publishes a strategy on-chain, earns a royalty (paid atomically in the rebalance PTB) on every vault that hires it. Reputation (lifetime alpha, vault count) accrues on-chain.
- **Agent memory infrastructure (dev tooling).** Any LangGraph / agent builder drops in `SynapseStore` to get Walrus-durable, tamper-evident, revocable memory — without the treasury product at all.
- **Auditor / compliance.** A regulator verifies agent behavior from on-chain events + Walrus rationale blobs, with no access to the operator's systems.

---

## 6. Go-to-market

**Two layers, two motions.**

| Layer | What | Motion | Revenue |
|---|---|---|---|
| **Synapse Vault** (product) | Hosted / self-hosted AI treasury manager. | Land DAOs and on-chain funds that already hold idle treasury and want automation without custody risk. | 1% AUM + 0.5% performance fee on realized alpha (both enforced on-chain). |
| **Synapse Core** (open infra) | Move modules + SDK + adapters, open source. | Developer-led growth: anyone builds agents on the policy + Walrus-memory primitives; the LangGraph adapter is the wedge. | Ecosystem + marketplace royalties flowing through the protocol. |

**Sequencing.** (1) Testnet + design-partner DAOs running real funds. (2) Seed an honest marketplace with external strategists. (3) Mainnet cutover (package + DEEP funding + a funded dry-run). (4) Managed hosting ("Synapse runs your agent") for DAOs that don't want to touch infra, alongside the self-host path.

**Where the edge is.** The individual primitives are commodity — on-chain spend caps, allowlists, revocation, and durable memory exist across the market (Crossmint, Safe, Lit, Turnkey, MemWal). The edge is the **Sui-native assembly**: one enforced envelope where the Move VM is the *only* thing that can move money, the audit trail is bound to each trade on-chain and stored on Walrus (portable, not ours to censor), and the kill switch is one owner signature. We don't replace a TEE with on-chain policy — we combine both: **enclave attestation (Nautilus) is live on testnet** (a dev-enclave signature verified on-chain, `DecisionAttested` tx `7TLfyS6a…`), so the decision is provably produced by the registered agent code, not just bound after the fact. On-chain enforcement + attested execution together are what make "verifiable" literally true; the remaining step is a genuine-TEE deploy (see [Honest status](#10-honest-status)).

---

## 7. On-chain deployments (testnet)

| Thing | ID |
|---|---|
| `synapse_core` (latest, **v5** — enclave attestation + royalty cap) | `0x0240a49e849d2349a9ee403e6e08d897ce97c82dd0a1a9d9ebdb9ea4357de086` |
| `synapse_core` history (v4, v3, v2, v1) | `0x85215709…1534`, `0xd849b7b2…78f01`, `0x5da36d89…58ed`, `0x7b3f59e4…a67c` |
| Registered enclave (`Enclave<DecisionEnclave>`) | `0x361b7a26380d5312247ff0afca78086c996ecc159bd30ca3b0a5ee4bf949ab9f` |
| Live attestation proof (`DecisionAttested`) | tx `7TLfyS6azzktKpbwBWBMV12hyV6hicNQZKip8weaAkPe` |
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
npm --workspace @synapse-core/vault test             # 88 tests
npm --workspace @synapse-core/adapter-langgraph test # 8 tests
```

```bash
# the Nautilus decision enclave (local dev box)
cd enclave && npm install
head -c 32 /dev/urandom > signing-key
ANTHROPIC_API_KEY=sk-ant-... PORT=3009 node src/index.js ./signing-key
```

---

## 9. Verification

```
move:                      synapse_core (25 tests) + synapse_seal — incl. the
                           Node↔Move secp256k1/BCS attestation contract +
                           royalty-drain guard; sui move test clean
sdk/packages/vault:        88 tests (secrets, logger redaction, alerts, walrus-
                           loader allowlist, runtime fail-safe, llm-advisor +
                           tick-gating, messaging consume/emit, enclave-client)
adapters/langgraph:        8 tests (put/get/recall/tombstone/search/filter)
dashboard:                 strict typecheck + production build
CI:                        GitHub Actions — Move tests + SDK typecheck/test +
                           dashboard build + secret-leak scan + Docker build
```

Live-verified on testnet: full mint → tick → DeepBook swap → Walrus artifact → MemWal recall; Seal encrypt/decrypt round-trip; cross-agent read (`CrossAgentReadEvent`); Walrus-loaded LLM strategy dispatched; **Nautilus attestation** — a dev-enclave signature verified on-chain + `DecisionAttested` emitted (tx `7TLfyS6a…`).

---

## 10. Honest status

| Item | Note |
|---|---|
| **What "verifiable" means** | Two layers. (1) **Tamper-evident audit** — each tick's rationale + inputs + exact trade is hashed and logged on-chain in the same PTB as the swap, then stored on Walrus. (2) **Attested execution (Nautilus)** — the decision is produced + signed inside an attested enclave and the Move VM verifies that signature before the swap. Together: the trade is provably produced by the registered agent code, bound to its inputs, and unaltered. |
| **Attested execution (Nautilus)** | **LIVE on testnet with a dev enclave** — `register_dev_enclave` + on-chain `attest_decision` verified a real enclave signature and emitted `DecisionAttested` (tx `7TLfyS6a…`); `requires_attestation` makes the spend gate enforce it. **Remaining:** a genuine-TEE deploy (Marlin Oyster `--deployment sui`, or own AWS Nitro) — the dev box proves the full pipeline but isn't hardware-attested. Steps in `enclave/README.md`. |
| Mainnet | Testnet only. Mainnet is a deliberate cutover (publish gas + real DEEP funding + a funded dry-run). |
| DEEP fee path | Testnet pools accept a zero-DEEP swap; mainnet needs the treasury to hold DEEP. The runtime fails fast on mainnet rather than building a testnet-pinned tx (`deepbookPackageForRuntime`). |
| Third-party audit | Not done. An internal multi-agent audit (`AUDIT.md`) ran and its findings are fixed — incl. the critical **royalty-drain** (now charged against the per-epoch cap) and the indexer/session-key/zkLogin fixes. A professional external audit still precedes mainnet. |
| AI advisor | Server-side only — the browser in-tab runtime excludes `@anthropic-ai/sdk` and degrades to a noop. |

---

## 11. Security

See **[THREAT_MODEL.md](./THREAT_MODEL.md)** — session-key compromise, Walrus-loaded code injection, MemWal namespace poisoning, oracle manipulation, key custody, and the mitigations built into the architecture.

---

## 12. Repo layout

```
move/synapse_core        10 Move modules — policy engine + marketplace + Nautilus attestation
move/synapse_seal        Seal access-policy package
sdk/packages/*           client · vault (runtime) · memwal-bridge · indexer · adapters/langgraph
enclave/                 Nautilus decision enclave (Node) — attested, signs decisions
web/dashboard            Next.js app (mint, marketplace, per-vault dashboard)
web/site                 marketing site (Walrus Sites)
examples/messaging-demo  Sui Stack Messaging integration (isolated, sui 1.x)
infrastructure/aws       CDK + secret-push scripts for hosted deployment
scripts                  backtests, dev utilities, CI checks
AUDIT.md                 internal multi-agent security audit + remediation
```
