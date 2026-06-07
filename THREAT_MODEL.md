# Synapse Vault — Threat Model & Self-Audit

> **Sui Overflow 2026 · Walrus Track submission artifact**
>
> Last reviewed: **2026-05-23** · Active Move package: `0xe95241a800a97841e7676437cc83c9761e6d30e42ab8bdd590d49fd40e22a797` (`synapse_core` v6, Sui testnet)

This document enumerates the threats Synapse Vault was designed to defend against, where trust boundaries live, and the residual risk that remains. It is written for **judges evaluating the Walrus Track submission**, compliance reviewers considering AI treasury automation, and the external auditors we engage before mainnet.

Synapse's security story is inseparable from its Walrus story: **off-chain memory and artifacts can lie; on-chain policy and hashes cannot.**

---

## 1. Assets

| # | Asset | Where it lives | Sensitivity |
|---|---|---|---|
| A1 | **Vault treasury funds** | `AgentIdentity.treasury` (Sui `Bag`, shared object) | **Critical** — direct economic value |
| A2 | **Owner Sui address** | Human wallet (Slush, Suiet, zkLogin, …) | **Critical** — revoke + drain authority |
| A3 | **Agent session keypair** | Secrets Manager / disk (`SYNAPSE_SESSION_KEY`) on runtime host | **High** — bounded by Move policy |
| A4 | **MemWal delegate key** | Runtime secret or browser storage at mint | **Medium** — scoped to MemWal account |
| A5 | **MemWal account / namespace** | On-chain bytes + relayer-side account | **Medium** — cross-agent coordination surface |
| A6 | **Walrus audit artifacts** | Walrus blobs; `ArtifactRef` on `AgentIdentity` | **Medium** — compliance proof; hash on-chain |
| A7 | **Walrus strategy bundles** | Walrus blobs referenced by marketplace `Strategy` | **High** — arbitrary code if consent + hash checks fail |
| A8 | **Seal-encrypted payloads** | Walrus + Seal key servers | **Medium** — strategy params, messaging bodies |
| A9 | **On-chain audit trail** | Sui events from `synapse_core` | **Critical** — tamper-evident compliance record |
| A10 | **Enclave signing key** | Nitro/Oyster enclave or dev box | **High** — forges attested decisions if leaked |
| A11 | **Messaging channel + MemberCap** | Sui Stack Messaging objects | **Medium** — impersonation / spam if mis-provisioned |
| A12 | **Cross-agent shared namespace** | MemWal configuration | **Medium** — memory poisoning across vaults |

---

## 2. Trust boundaries

```
  ┌─────────────────────────────────────┐
  │ HUMAN OWNER (wallet / zkLogin)      │  trusts wallet + browser
  └──────────────┬──────────────────────┘
                 │ governance PTBs (revoke, policy, Walrus consent)
                 ▼
  ┌─────────────────────────────────────┐
  │ SUI MOVE VM — synapse_core          │  TRUST ANCHOR: only layer that moves funds
  │ AgentIdentity · wallet · attestation│
  └───────┬─────────────────┬───────────┘
          │ session key     │ read-only RPC
          ▼                 ▼
  ┌───────────────┐   ┌─────────────────┐
  │ HEADLESS      │   │ DASHBOARD       │  trusts RPC + npm supply chain
  │ RUNTIME       │   │ (Next.js)       │
  │ (Fargate/local)│  └─────────────────┘
  └───────┬───────┘
          │ HTTPS / subprocess
          ▼
  ┌───────────────────────────────────────────────────────────┐
  │ Walrus plane (untrusted for safety; trusted for audit)     │
  │  MemWal relayer · Walrus aggregators · Seal key servers    │
  │  Pyth Hermes · DeepBookV3 · Sui Stack Messaging SDK        │
  │  Nautilus enclave HTTP                                     │
  └───────────────────────────────────────────────────────────┘
```

**Defensible claim:** Compromise of any box below the Move VM **cannot drain the treasury beyond on-chain policy** (spend cap, allowlist, expiry, revocation). Compromise **can** degrade strategy quality (bad MemWal recall, bad oracle input) or forge **off-chain** audit views — but on-chain hashes and events expose the discrepancy.

**Walrus-specific claim:** Walrus is the **durability and portability** layer, not the **authorization** layer. Authorization always terminates in `wallet::spend` + optional `assert_attested_if_required`.

---

## 3. Threat catalog

Severity = residual risk **after** mitigations.

### T1 · Compromised session key
- **Vector:** Host breach, log leak, overly broad Secrets Manager IAM.
- **Impact:** Attacker signs as session addr; bounded by per-epoch spend cap + package allowlist + not revoked + not expired.
- **Mitigations:** Move four-layer gate; rotate session key on-chain; indexer alerts on anomalous `SpendEvent`; hosted runtime uses per-vault secrets.
- **Residual:** **Low** — max loss ≈ one epoch cap through approved contracts.

### T2 · Owner key compromise
- **Vector:** Phishing, seed leak, malicious extension.
- **Impact:** Full custody — revoke agent, drain treasury. Past events remain on-chain.
- **Mitigations:** Hardware wallet / multisig as owner; no Synapse-specific extra surface.
- **Residual:** **High** (same as any self-custody), **not introduced by Walrus**.

### T3 · MemWal relayer compromise
- **Vector:** Rogue or breached `relayer.memwal.ai`.
- **Impact:** Read in-flight plaintext before Seal; return forged `recall()` influencing rebalance decisions.
- **Mitigations:** Move caps economic damage; strategy sanity checks (bands, slippage, min-notional); cross-check recalls against on-chain tick history; MemWal TEE roadmap for production.
- **Residual:** **Medium** — funds safe; strategy quality at risk.

### T4 · Cross-agent / shared-namespace memory poisoning
- **Vector:** Malicious peer vault writes deceptive MemWal entries in a shared namespace.
- **Impact:** Reader vault overweights peer signal; suboptimal or mistimed rebalance (still slippage-bounded).
- **Mitigations:** `record_cross_agent_read` logs peer id + blob id on-chain; reader strategies should treat peer facts as **hints** not commands; owner controls namespace membership via delegate keys; optional attestation path ignores unverified peers.
- **Residual:** **Medium** — coordination benefit trades off against trust in namespace peers.

### T5 · Walrus-loaded malicious strategy bundle
- **Vector:** Attacker publishes attractive strategy on marketplace; owner enables Walrus execution consent.
- **Impact:** Runtime executes attacker JS inside tick loop — could exfiltrate secrets **on the runtime host**, craft malicious PTB *proposals* (still gated by Move).
- **Mitigations:** Owner must explicitly `set_walrus_consent`; loader verifies bundle SHA-256 against on-chain `Strategy` metadata; allowlist limits callable Move packages regardless of strategy output; attestation mode binds decision to registered code hash; browser runtime excludes server-only SDKs (LLM).
- **Residual:** **Medium** on runtime host (secret exfiltration); **Low** on treasury (Move rejects bad spends).

### T6 · Walrus aggregator serving tampered artifact bytes
- **Vector:** Malicious public aggregator returns wrong markdown for a blob id.
- **Impact:** Compliance UI shows false rationale.
- **Mitigations:** On-chain `ArtifactRef.sha256`; dashboard verifies after fetch; second independent aggregator cross-check.
- **Residual:** **Low** — detectable with on-chain hash.

### T7 · Seal policy / key-server misuse
- **Vector:** Wrong policy package id; expired session key; attacker obtains Seal session without vault identity proof.
- **Impact:** Decrypt failure (availability) or unauthorized decrypt of messaging/strategy blobs if policy misconfigured.
- **Mitigations:** Dedicated `synapse_seal` policy; `seal_approve` checks vault identity prefix; dashboard uses same package id as runtime; encrypt path tested in CI.
- **Residual:** **Low** with correct deployment; **Medium** if operator pins wrong policy id.

### T8 · Pyth oracle manipulation
- **Vector:** Expensive coordinated feed manipulation.
- **Impact:** Mis-sized rebalance decision (execution still at DeepBook + slippage floor).
- **Mitigations:** Oracle used for sizing only; `minAmountOut` on swaps; stable-peg fallback for USDC.
- **Residual:** **Low**.

### T9 · DeepBookV3 pool exploit
- **Vector:** Bug in DeepBook itself.
- **Impact:** Loss of one rebalance's input coin.
- **Mitigations:** Per-epoch cap; immediate visibility via `SwapEvent`; allowlist single DeepBook package version.
- **Residual:** **Low** — bounded, out of Synapse control.

### T10 · Nautilus / enclave impersonation
- **Vector:** Attacker registers rogue enclave or steals dev signing key.
- **Impact:** Forged `DecisionAttested` allowing trades on attestation-gated vaults.
- **Mitigations:** On-chain enclave registration tied to PCR measurement (production); dev enclave clearly labeled in docs; owner opts in per vault; decision payload binds vault id + epoch + inputs hash + code hash.
- **Residual:** **Low** on mainnet with hardware attestation; **Medium** on testnet dev box (documented).

### T11 · Sui Stack Messaging impersonation / spam
- **Vector:** Session key not added to channel (`MemberCap` missing); attacker floods inbox on public channel.
- **Impact:** Missing emit (`record_send` never called); reader consumes junk signals as memory facts.
- **Mitigations:** `provision-messaging-channel.ts` adds session keys; runtime treats signals as untrusted hints; rebalance-only emit reduces noise; on-chain correlator links digest to channel id.
- **Residual:** **Low** economic impact; **Medium** operational (misconfiguration).

### T12 · Frontend supply-chain attack
- **Vector:** Compromised npm dependency in dashboard.
- **Impact:** Exfiltrate keys during rotate; redirect PTB to malicious package id.
- **Mitigations:** Lockfile checked in; wallet shows raw Move call; pre-mainnet dependency pin + audit.
- **Residual:** **Medium** until external audit; **Low** after.

### T13 · Indexer / dashboard data tampering
- **Vector:** Hosted indexer serves false timeline.
- **Impact:** Operator misjudges vault state.
- **Mitigations:** Dashboard falls back to RPC; events reproducible from `getTransactionBlock`; Walrus hashes verifiable independently.
- **Residual:** **Low**.

### T14 · Parallel execution race on `AgentIdentity`
- **Vector:** Concurrent PTBs mutating same shared object.
- **Impact:** None — Sui serializes `&mut AgentIdentity`.
- **Residual:** **Negligible**.

### T15 · Capability / upgrade escape (future package bug)
- **Vector:** New Move entry skips `assert_can_act` / `assert_owner`.
- **Mitigations:** `AgentIdentity` has `key` not `store`; checklist §5 before every publish; external audit.
- **Residual:** **Low** at v6; **re-audit on every upgrade**.

---

## 4. Walrus Track — security properties we optimize for

These are the properties judges should associate with our Walrus integration:

| Property | Mechanism | Holds if Walrus/ MemWal compromised? |
|---|---|---|
| **Treasury safety** | Move policy gates on every `spend` | **Yes** |
| **Audit integrity** | SHA-256 on-chain + Walrus blob | **Detectable** (hash mismatch) |
| **Memory durability** | MemWal → Walrus persistence | **Availability** risk only |
| **Cross-agent transparency** | `CrossAgentReadEvent` + peer blob id | **Yes** (chain log honest) |
| **Private strategy params** | Seal + `synapse_seal` policy | **Yes** if policy correct |
| **Verifiable decision** | Nautilus signature + `requires_attestation` | **Yes** if enclave registration honest |

---

## 5. Cross-cutting controls

1. **Move VM chokepoint** — Every outflow through `wallet::spend` / `withdraw` with revoked, sender, expiry, allowlist, and cap checks.
2. **Attestation gate (opt-in)** — `requires_attestation` aborts spend without verified enclave decision in the same PTB.
3. **Walrus consent (opt-in)** — Dynamic field `accepts_walrus_execution`; runtime refuses hash-unverified bundles without owner consent.
4. **One-PTB revocation** — `agent::revoke` immediately blocks session path; cascade invalidates MemWal delegate.
5. **Append-only forensics** — Swap, spend, artifact, coordination, messaging, and attestation events on-chain; Walrus holds human-readable rationale.
6. **No `store` on `AgentIdentity`** — Cannot wrap or exfiltrate the shared object without governance.
7. **Secret hygiene** — Session keys via secrets provider; logger redaction tests; forbidden-pattern CI scan.

---

## 6. Pre-publish audit checklist

Run before any new `sui client publish` of `synapse_core`.

### Move
- [ ] Every new mutator uses `assert_can_act` or `assert_owner`.
- [ ] `AgentIdentity` retains `key` only — never `store`.
- [ ] Royalty charges remain inside per-epoch spend cap.
- [ ] Attestation and Walrus consent gates unchanged or re-reviewed.
- [ ] `sui move test` — 100% pass, zero warnings.

### Runtime / Walrus
- [ ] Walrus loader rejects bundles whose hash ≠ on-chain strategy metadata.
- [ ] MemWal namespace config documented per vault; cross-agent peers explicitly listed.
- [ ] Messaging: session MemberCaps verified before production emit.
- [ ] `npm --workspace @synapse-core/vault test` passes.

### Dashboard
- [ ] Production build clean; artifact viewer verifies SHA-256 before render.
- [ ] Wallet modals show exact Move target before sign.

---

## 7. Outstanding items (pre-mainnet)

| # | Item | Target |
|---|---|---|
| 1 | External security review (OpenZeppelin / OtterSec) | Post-shortlist |
| 2 | Pin all direct npm deps to exact versions | Pre-mainnet |
| 3 | Production Nautilus deploy (Oyster/Nitro) replacing dev box | Pre-mainnet |
| 4 | MemWal delegate in HSM / Seal-encrypted Walrus blob (not browser) | Production hosting |
| 5 | Strategy drawdown circuit breaker (max NAV loss per epoch) | v7 roadmap |
| 6 | Dashboard one-click "add session to messaging channel" | UX hardening |
| 7 | Mainnet dry-run with funded design-partner vault | Cutover week |

---

## 8. Reporting a vulnerability

**Testnet:** GitHub issue with reproducible steps.

**Mainnet (future):** Bug bounty via address in `UpgradeCap` owner metadata.

---

## 9. Related documents

| Document | Purpose |
|---|---|
| [README.md](./README.md) | Walrus Track feature map + architecture |
| [AUDIT.md](./AUDIT.md) | Internal multi-agent audit + remediation log |
| [enclave/README.md](./enclave/README.md) | Nautilus deployment + threat notes for TEE path |

---

*Reviewed before every package upgrade. Last reviewer: Synapse team, 2026-05-23.*
