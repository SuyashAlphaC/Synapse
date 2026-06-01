# Synapse Vault — Threat Model & Self-Audit

> Last reviewed: 2026-05-14 · Move package: `0x5da36d892956a4659415e245126a3964dd5aa6cf19ec2fdf6332bf828a4c58ed` (Sui testnet) · Code version: post-Phase-3 wrap

This document enumerates the threats Synapse Vault was designed to defend
against, where the trust boundaries actually live, and the residual risk that
remains. It is the artifact a compliance officer reviews before letting an
AI agent touch a real treasury, and the document we hand to OpenZeppelin /
OtterSec for the post-submission audit.

---

## 1. Assets

| # | Asset | Where it lives | Sensitivity |
|---|---|---|---|
| A1 | **Vault treasury funds** | `AgentIdentity.treasury` (Sui `Bag`, shared object) | High — direct economic value |
| A2 | **Owner Sui address** | Human's wallet (Slush, Phantom, Suiet, …) | High — unilateral revocation + drain authority |
| A3 | **Agent session keypair** | Off-chain disk file (`~/.synapse/session.key`) on the runtime host | Medium — bounded by Move VM policy gates |
| A4 | **MemWal delegate key** | Off-chain disk or browser `localStorage:synapse:memwal:<agentId>` | Medium — bounded to MemWal account scope |
| A5 | **MemWal account ID** | `AgentIdentity.memwal_account_id` (bytes on-chain) | Low — public identifier |
| A6 | **Walrus artifact contents** | Walrus blob storage; pointer in `AgentIdentity` dynamic fields | Low–medium — semi-public audit material |
| A7 | **Audit trail integrity** | Sui events emitted by the deployed Move package | High — the compliance proof |
| A8 | **Strategy code** | `@synapse-core/vault/strategies` on the runtime host | Low — deterministic, version-tagged on every action |

---

## 2. Trust boundaries

```
  ┌────────────────────────────────┐
  │ HUMAN OWNER (wallet, browser)  │  ←─── trusts wallet manufacturer + browser
  └───────────────┬────────────────┘
                  │ signs governance PTBs
                  ▼
  ┌────────────────────────────────┐
  │       SUI MOVE VM              │  ←─── trust anchor: validators consensus
  │  synapse_core::* + Bag treasury│
  └─────┬─────────────────────┬────┘
        │ session key gate    │ owner gate
        ▼                     ▼
  ┌──────────────┐   ┌────────────────┐
  │ AGENT RUNTIME│   │ DASHBOARD UI   │  ←─── trusts dapp-kit + RPC fullnode
  │ (Node, host) │   │ (browser)      │
  └─────┬────────┘   └────────────────┘
        │ off-chain HTTP
        ▼
  ┌───────────────────────┐
  │ relayer.memwal.ai     │  ←─── third party (Mysten Labs)
  │ hermes.pyth.network   │  ←─── third party (Pyth Network)
  │ Walrus aggregator     │  ←─── third party / decentralized
  │ DeepBookV3 pool       │  ←─── on-chain, included in Sui consensus
  └───────────────────────┘
```

Synapse's defensible position is that **the Move VM is the only authority
that can move funds**. Everything else — runtimes, MemWal, Pyth, Walrus
aggregators — can be compromised without compromising treasury safety,
because every outflow passes through `wallet::spend`'s four-layer policy
gate.

---

## 3. Threat catalog

For each threat: capability, attack vector, impact, mitigation. Severity is
the residual risk **after** mitigations.

### T1 · Compromised session key
- **Capability:** Attacker exfiltrates `~/.synapse/session.key` (host breach,
  filesystem read, log dump).
- **Vector:** They can now sign Sui transactions as the agent's session
  signer.
- **Impact:** Limited to `wallet::spend(target_pkg, amount, ctx)` calls that
  satisfy on-chain policy:
  - `tx_context::sender(ctx) == session_addr` ✓ (attacker has the key)
  - `!identity.revoked` — defeated by owner revocation
  - `epoch(ctx) < expiry_epoch` — bounded
  - `target_pkg ∈ approved_packages` — bounded by the contract allowlist
  - `spent_this_epoch + amount ≤ spend_per_epoch` — bounded by the cap
- **Mitigations:**
  - Move VM enforces the four gates; an unconstrained attacker cannot drain
    the treasury, only siphon up to the per-epoch cap through allowlisted
    contracts.
  - Dashboard's **Rotate session key** flow signs `agent::rotate_session_key`,
    instantly invalidating the leaked key on chain.
  - Indexer surfaces every `SpendEvent`; an unusual pattern triggers
    operational response (revoke).
- **Residual severity:** **Low.** Maximum theft per compromise = one epoch's
  spend cap routed through pre-approved contracts. Attacker cannot drain or
  redirect.

### T2 · Owner key compromise
- **Capability:** Attacker controls the wallet that originally minted the
  vault.
- **Vector:** Phishing, malicious browser extension, social-engineered seed
  phrase recovery.
- **Impact:** Full custody — attacker can `agent::revoke` and then
  `wallet::drain<T>` every coin in the treasury back to themselves. They
  cannot retroactively alter past events (Sui's append-only ledger).
- **Mitigations:**
  - Same wallet-level mitigations as any high-value Sui address: hardware
    wallets, multisig for production deployments, dedicated wallet for vault
    governance.
  - Optional: deploy Synapse Vault behind a multisig (the owner address is
    just a Sui address; a multisig works without code changes).
  - Audit trail is preserved — exfiltration is forensically traceable.
- **Residual severity:** **High** (treasury loss), but identical to any
  self-custody product. Synapse adds no new attack surface here.

### T3 · MemWal relayer compromise
- **Capability:** Mysten Labs' relayer service is breached or rogue.
- **Vector:** Attacker controls the server at `relayer.memwal.ai`.
- **Impact:**
  - Memory privacy: attacker reads in-flight `remember()` calls before they
    are Seal-encrypted (relayer holds the encryption step). Historical
    blobs on Walrus remain Seal-encrypted with the agent's keys.
  - Memory integrity: attacker can return forged `recall()` results,
    influencing strategy decisions.
- **Mitigations:**
  - Move VM still bounds the damage: bad memory cannot bypass spend caps
    or allowlists.
  - Strategy contains internal sanity checks (drift threshold, slippage
    tolerance) that reject obviously gamed inputs.
  - Production deployments should adopt MemWal's TEE attestation roadmap.
- **Residual severity:** **Medium.** Funds remain safe; strategy quality
  degrades.

### T4 · Pyth oracle manipulation
- **Capability:** Attacker influences SUI/USD or USDC/USD on Pyth Network.
- **Vector:** Coordinated price-feed manipulation across Pyth publishers
  (historically very expensive).
- **Impact:** Strategy may decide to rebalance at unfavorable prices.
- **Mitigations:**
  - Strategy uses oracle prices only for **decisioning**, not for
    on-chain settlement (DeepBookV3 enforces actual execution price).
  - `slippageTolerance` enforces `minAmountOut` in every DeepBookV3 swap —
    prevents executing a rebalance based on a momentarily bad oracle quote.
  - Stable-peg fallback (`USDC = $1`) reduces oracle attack surface for the
    dominant case.
- **Residual severity:** **Low.** Worst case is a single rebalance executed
  at marginally unfavorable but still slippage-bounded prices.

### T5 · DeepBookV3 pool exploit
- **Capability:** A bug in DeepBookV3 itself drains the input coin without
  returning the expected output.
- **Vector:** Theoretical — DeepBookV3 is audited and live with hundreds of
  millions in TVL.
- **Impact:** Up to one rebalance's `amountIn` is lost.
- **Mitigations:**
  - `wallet::spend` caps every outflow at the per-epoch budget.
  - Synapse's `deepbook_adapter::record_swap` event makes the loss
    immediately visible to the indexer; an alert triggers revocation.
  - Allowlist (`approved_packages`) can be tightened to a single
    pre-vetted DeepBookV3 release.
- **Residual severity:** **Low.** Out of Synapse's hands but bounded by
  policy.

### T6 · Walrus aggregator integrity
- **Capability:** A specific Walrus aggregator returns tampered blob
  contents.
- **Vector:** Attacker runs a public aggregator and serves modified bytes.
- **Impact:** Compliance officer reviewing an audit report sees fabricated
  rationale.
- **Mitigations:**
  - Every artifact carries an on-chain SHA-256 (`ArtifactRef.sha256`).
    The dashboard verifies the hash after fetching from any aggregator;
    mismatches throw.
  - Compliance officers should fetch from at least two independent
    aggregators when stakes warrant.
- **Residual severity:** **Low.** Detectable by anyone with the on-chain
  hash + a second aggregator.

### T7 · Replay / reorg of session-key transactions
- **Capability:** Attacker rebroadcasts an old PTB after gaining temporary
  network position.
- **Vector:** Sui's design includes replay protection via object versions
  and gas object consumption.
- **Impact:** Negligible — Sui's consensus rejects replays at the validator
  layer.
- **Mitigations:** Out of scope (handled by Sui's transaction format).
- **Residual severity:** **Negligible.**

### T8 · Frontend supply-chain attack
- **Capability:** Attacker compromises one of the dashboard's npm
  dependencies (e.g., `motion`, `@mysten/dapp-kit`, `react-three-fiber`).
- **Vector:** Malicious package update or typosquat.
- **Impact:** Attacker could read clipboard, exfiltrate the session-key
  secret during `Rotate session key`, or rewrite the wallet PTB to point at
  a different package ID.
- **Mitigations:**
  - All upstream versions are pinned in `package.json` (no caret-only
    ranges for high-impact packages should be promoted past the Phase-3
    review).
  - `package-lock.json` is checked in.
  - The mint and revoke flows display the **exact Move call** before
    signing — wallet popups also show the target. A wallet user reviewing
    the popup sees `0x70db…ec16::agent::rotate_session_key` regardless of
    what the frontend is doing.
  - Pre-submission: pin every direct dependency to an exact version, audit
    `package-lock.json` against `npm audit --omit=dev`.
- **Residual severity:** **Medium** until pre-submission audit; **Low**
  thereafter.

### T9 · Capability hot-potato escape
- **Capability:** A future Move module references `AgentIdentity` via
  `&mut` and bypasses the policy gates.
- **Vector:** A patched / re-deployed Synapse package that doesn't enforce
  `assert_can_act` in some new function.
- **Mitigation:**
  - The current package's `AgentIdentity` has `key` but no `store` ability
    — it cannot be wrapped or transferred away from the shared-object slot.
  - All mutators are gated either by `assert_can_act` (session key path)
    or `assert_owner` (governance path).
  - Audit checklist (§5) verifies this before every `sui move publish`.
- **Residual severity:** **Low** at v1; **must re-audit on any package
  upgrade**.

### T10 · Parallel-execution race on shared `AgentIdentity`
- **Capability:** Two concurrent transactions try to mutate `AgentIdentity`
  with overlapping intents.
- **Vector:** Sui's parallel execution scheduler.
- **Impact:** None — Sui linearizes mutations on shared objects via
  consensus.
- **Mitigations:**
  - The Move VM serializes any tx that takes `&mut AgentIdentity`.
  - `spent_this_epoch` counter increments are atomic per epoch.
- **Residual severity:** **Negligible.**

### T11 · Indexer corruption (when deployed)
- **Capability:** A future hosted indexer service serves tampered data.
- **Vector:** Compromised service or rogue operator.
- **Impact:** Compliance dashboard shows incorrect history.
- **Mitigations:**
  - Dashboard never requires the indexer to mutate anything. Reads only.
  - Inspector falls back to direct Sui RPC, which the user can verify
    against any fullnode.
  - Every event is also reproducible from `getTransactionBlock` directly.
- **Residual severity:** **Low.** Always cross-checkable against chain.

### T12 · Browser localStorage leak of MemWal delegate
- **Capability:** Cross-site scripting or extension reads
  `synapse:memwal:<agentId>`.
- **Vector:** XSS in our app (we host nothing user-generated) or malicious
  browser extension.
- **Impact:** Attacker can call MemWal `remember`/`recall` as the agent —
  i.e., forge or read memory.
- **Mitigations:**
  - Next.js + React's default escape policies prevent inline XSS.
  - No user-generated content rendered in the dashboard. No
    `dangerouslySetInnerHTML` outside the audit-report viewer (which only
    runs after Walrus SHA-256 verification).
  - Production deployments should keep the delegate key in an HSM or
    Seal-encrypted Walrus blob, not browser storage. Documented in
    `docs/memwal-setup.md`.
- **Residual severity:** **Medium** for testnet demo; **mitigated by
  policy** for production.

---

## 4. Cross-cutting controls

These hold regardless of which threat fires:

1. **Move VM as the chokepoint.** Every fund-moving call goes through
   `wallet::spend` or `wallet::withdraw`. The four-layer gate (revoked,
   sender, expiry, allowlist) plus the spend cap cannot be bypassed by any
   off-chain compromise.
2. **One-PTB revocation cascade.** `agent::revoke` flips a boolean and
   emits an event the indexer consumes to invalidate the MemWal delegate
   and queue Walrus eviction. There is no asynchronous revocation lag.
3. **No `store` ability on `AgentIdentity`.** The shared object cannot be
   wrapped, transferred, or destroyed by any other module without an
   explicit governance action.
4. **Append-only audit trail.** Every action on a vault produces a Sui
   event. The full timeline is reconstructible by anyone with a Sui
   fullnode connection — no Synapse infrastructure is required for
   forensics.
5. **No `any`, no `@ts-ignore`, no fake values.** Repository-wide policy.
   The forbidden-pattern scan passes on every commit.

---

## 5. Pre-publish audit checklist

Run this before any new `sui client publish` of `synapse_core`. **Required
for any production deployment.**

### Move
- [ ] No new `entry` or `public` function lacks an appropriate
      `assert_can_act` (session-key path) or `assert_owner` (governance
      path) call.
- [ ] No new mutator on `AgentIdentity` accepts `&mut` without going
      through the gates above.
- [ ] `AgentIdentity` still has `key` only — never `store`.
- [ ] No unbounded `vector<T>` field added (use `Table` or capped vector
      with explicit size check).
- [ ] All entry functions use `&TxContext` not `&mut TxContext` unless they
      genuinely need to mutate context.
- [ ] `sui move test` reports 100% pass rate.
- [ ] `sui move build` reports zero warnings.
- [ ] New events documented in `docs/architecture.md` event catalog.

### Off-chain SDK
- [ ] `npm run typecheck --workspaces` passes across every package.
- [ ] Forbidden-pattern grep returns empty:
      `grep -rnE "TODO|FIXME|Math\\.random|@ts-ignore|console\\.log|\\bas any\\b" sdk/packages`
- [ ] `package.json` exact versions pinned for every direct dependency.
- [ ] `package-lock.json` is committed and matches `package.json`.

### Dashboard
- [ ] `npm run build` produces a clean Next.js production bundle.
- [ ] No `dangerouslySetInnerHTML` outside the audit-report viewer.
- [ ] Wallet PTB previews in modals match the exact Move call signature
      before signature is requested.
- [ ] All `'use client'` files have been reviewed for clipboard / secret
      handling.

### Runtime
- [ ] Session keypair is loaded from `SYNAPSE_SESSION_KEY_PATH` only —
      never from an environment variable that might end up in process
      listings or log dumps.
- [ ] `@synapse-core/vault` runtime tests (`npm --workspace
      @synapse-core/vault test`) pass.
- [ ] Pino logger uses `info`/`warn`/`error` levels — never `debug` with
      secrets.
- [ ] `--once` mode exits cleanly with `process.exitCode = 1` on failure.

---

## 6. Outstanding items for the August 20 mainnet deployment

| # | Item | Owner | Required by |
|---|---|---|---|
| 1 | External security review (OpenZeppelin or OtterSec credit) | Submission package post-shortlist | Aug 5 |
| 2 | Pin every direct dependency to exact versions (remove all `^`) | Synapse team | Aug 10 |
| 3 | Document MemWal HSM / Seal-encrypted-Walrus storage path for delegate keys | Synapse team + MemWal team | Aug 10 |
| 4 | Strategy bounded-loss circuit breaker (max NAV drawdown per epoch) | Synapse team | Aug 15 |
| 5 | Indexer rate-limit + auth for the public GraphQL endpoint | Synapse team | Aug 15 |
| 6 | Mainnet dry-run with the first design partner's funded vault | Synapse + design partner | Aug 18 |

---

## 7. Reporting a vulnerability

For testnet (current): file an issue at the public GitHub repo with as
much reproducible detail as you can.

For mainnet (post-August 20): a dedicated bug bounty surface will be
announced. In the interim, contact the team via the address listed in the
mainnet `synapse_core` package's `UpgradeCap` owner field.

---

*This document is reviewed before every package upgrade. Last reviewer:
Synapse team, 2026-05-14.*
