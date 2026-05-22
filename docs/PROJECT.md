# Synapse Vault — Plain-Language Project Guide

*One document that explains what Synapse Vault is, why it matters, who uses it,
and how the pieces fit together. No prior crypto knowledge required to follow.*

---

## 1. The one-sentence version

**Synapse Vault is a smart contract on the Sui blockchain that lets a human owner
hire an AI strategy to manage a pool of money — with hard spending limits the
contract enforces, full on-chain audit logs, and a one-click "fire the AI"
button.**

Think of it as the contract you'd want between a hedge fund and its risk
department, rebuilt so the risk department is a piece of code that cannot be
bribed, jailbroken, or fall asleep.

---

## 2. The problem we solve

It's 2026. AI agents are everywhere — they write code, send emails, run
customer support. Companies want to give them money to manage too: rebalance a
treasury, run market-making, pay invoices, hunt for yield.

Every single existing option for "let the AI touch money" is broken:

| What you can do today | Why it's broken |
|---|---|
| Give the AI a hot wallet | One bad prompt drains it. No safety net. |
| Make a human approve every transaction | Kills the whole point of automation. |
| Use a centralized custodian (Anthropic-as-a-bank) | Doesn't exist; you're back to trusting one company. |
| Multisig the AI | Slow, fragile, requires coordinating signers. |

**There is no infrastructure layer for giving AI agents controlled financial
autonomy.** Synapse Vault is exactly that infrastructure.

---

## 3. The core idea, in three sentences

1. **The smart contract holds the money** — not the AI, not us, not anyone else.
2. **The AI proposes trades** through a Sui transaction, but the contract
   *enforces* hard rules: max spend per epoch, allowlisted contracts only,
   expiry date, instantly revocable.
3. **The owner stays in control** of one key — the kill switch. One signature
   ends the AI's authority forever.

The AI can be the smartest model on earth or a buggy weekend hack — it does not
matter. The blockchain rejects any transaction that breaks the rules the owner
set at mint time.

---

## 4. The five user personas

| Persona | What they do | Where they live in the product |
|---|---|---|
| **Vault Owner** | A human (or DAO) with money they want managed. Mints a vault, picks a strategy, sets spending limits, can revoke at any time. | `/mint`, `/dashboard` |
| **Strategist** | A coder who writes an AI/quant strategy. Publishes it on-chain, earns a royalty on every vault that hires it. | `/marketplace/publish`, `/strategist` |
| **AI Agent (Session Key)** | The actual program running the strategy. Has its own Sui key that can sign trades — but only trades the policy allows. | Runs as a Node process; the dashboard never sees it directly. |
| **Auditor / Regulator** | A third party who needs to verify what the AI did, when, and why. Reads on-chain events + the Walrus-stored rationale docs. | `/dashboard/[vaultId]` Audit Timeline panel, Sui Explorer, Walrus aggregator |
| **Strategy Buyer** | Wants to acquire a published strategy outright (rare but possible). Receives the StrategistCap via transfer. | `/strategist` → Transfer cap modal |

---

## 5. End-to-end user workflow

### A. Owner mints a vault (one-time, ~3 minutes)

```
1. Visit /mint
2. Connect Sui wallet (or Sign in with Google → zkLogin)
3. Pick a strategy from the marketplace
   ├─ Conservative Rebalancer  (low risk, ~3.66% alpha in backtest)
   ├─ Balanced Yield           (medium risk, ~5.06% alpha)
   └─ Aggressive Momentum      (high risk; underperformed in this window)
4. Set policy:
   ├─ Spend cap per epoch    (e.g., 5% of treasury)
   ├─ Expiry                  (e.g., 90 epochs ≈ 90 days)
   └─ Allowlisted contracts   (preset: DeepBookV3 SUI/USDC pool only)
5. Seed treasury — pull X SUI from your wallet
6. (Optional) Attach MemWal memory for the AI
7. Click "Mint vault on testnet" — sign one transaction
```

The result is a Sui object you own. Until you revoke, the strategy runtime can
sign trades on its behalf.

### B. The AI runs (continuously, automated)

```
Every N minutes (default 10):
1. Agent runtime wakes up
2. Reads current portfolio + Pyth oracle prices
3. Recalls past decisions from MemWal (its long-term memory)
4. Strategy evaluates → either NOOP or REBALANCE plan
5. If REBALANCE:
   a. Construct one transaction that:
      - Calls wallet::spend (checks: revoked? expired? in cap? allowlisted?)
      - Swaps via DeepBookV3
      - Records audit event on-chain
      - Uploads rationale PDF to Walrus
   b. Sign with the agent's session key
   c. Submit
6. If the contract rejects (e.g., over cap) → no money moves, audit log
   records the attempt
```

The owner watches this happen on `/dashboard` in real time: NAV chart updates,
audit timeline scrolls, holdings rebalance.

### C. Owner monitors / acts (any time)

| Action | Where | What it does |
|---|---|---|
| See live NAV | `/dashboard` | Real-time chart of vault value |
| See past decisions | `/dashboard/[vaultId]` Audit Timeline | Every rebalance with its on-chain digest + Walrus rationale |
| Rotate session key | Dashboard sidebar | Issue a fresh keypair if you suspect compromise |
| Change spend cap | Dashboard policy panel | Tighten or loosen the per-epoch limit |
| Extend expiry | Dashboard policy panel | Push the auto-shutdown date out |
| **Revoke** | Dashboard "Danger Zone" | One signature kills the AI forever |

### D. Strategist lifecycle (parallel track)

```
1. Visit /marketplace/publish
2. Fill in name, description, risk profile, royalty %
3. Provide code hash + Walrus blob ID for the source bundle
4. Sign one transaction → on-chain Strategy + StrategistCap created
5. As vaults hire your strategy:
   - vault_count increments on-chain
   - on every paid tick, royalty_bps % of profit lands in your wallet
   - reputation (lifetime alpha, drawdowns, etc.) accumulates on the
     Strategy object — public, queryable, immutable history
6. Manage via /strategist:
   - Publish new version  → bumps v1 → v2 with new code commitment
   - Deprecate            → marks inactive, no new adoptions
   - Reactivate           → undoes deprecate
   - Transfer cap         → sell or hand off ownership permanently
```

---

## 6. What's actually built (module map)

### Move (on-chain, Sui Move 2024)

Located at `move/synapse_core/sources/`:

| Module | Job |
|---|---|
| `agent.move` | The "vault" itself. Holds the treasury, enforces every policy gate, emits every event. Central object: `AgentIdentity`. |
| `wallet.move` | Per-coin-type spending. Every spend call routes through here, hits the spend-cap + allowlist + revoked + expired checks before releasing a coin. |
| `strategy_registry.move` | The marketplace. `Strategy` shared objects with versioning, royalty rules, and lifetime reputation. `StrategistCap` is the capability that gates governance. |
| `artifacts.move` | Lets the agent register Walrus blobs (audit reports, etc.) as dynamic fields on its identity. |
| `coordination.move` | Cross-agent memory shares via MemWal namespace matching. |
| `messaging_bridge.move` | Optional Sui Stack Messaging channel attachment for inter-agent comms. |
| `attestation.move` | Generic action-log helper any module can emit through. |
| `deepbook_adapter.move` | The bridge to DeepBookV3 pools. Routes swap PTBs with slippage guards. |

**14 Move tests, all passing.** Deployed to Sui testnet at:
`0x5da36d892956a4659415e245126a3964dd5aa6cf19ec2fdf6332bf828a4c58ed`

### TypeScript SDK (`sdk/packages/`)

| Package | Job |
|---|---|
| `@synapse-core/client` | PTB builders for every Move call. Type definitions. zkLogin helpers. Walrus + Seal wrappers. |
| `@synapse-core/vault` | The actual AI runtime. Strategy interface, three reference strategies, the executor that turns plans into PTBs, the report renderer, the long-running tick loop. |
| `@synapse-core/memwal-bridge` | MemWal SDK wrapper for delegate-key auth and namespaced recall. |
| `@synapse-core/indexer` | GraphQL service that subscribes to Synapse events and exposes a queryable vault timeline. |
| `@synapse-core/design-tokens` | Shared cream/ink palette tokens consumed by the dashboard. |
| `@synapse-core/adapter-langgraph` (+ `claude-sdk`, `eliza`) | Adapters for popular agent frameworks. |

### Dashboard (`web/dashboard/`)

Next.js 16 app, Sui Overflow 2026 theme, all live on-chain reads:

| Route | What it does |
|---|---|
| `/` | Landing page (within the app — separate from the marketing site at `web/site/`) |
| `/marketplace` | Browse all on-chain strategies. **Real 90-day backtest curves embedded on each card.** |
| `/marketplace/publish` | Strategist publish form — signs the real publish PTB |
| `/strategist` | Strategist console — deprecate / version-bump / transfer for every cap you hold |
| `/mint` | 6-step mint wizard with live strategy picker |
| `/dashboard` | Vault list and creation entry point |
| `/dashboard/[vaultId]` | Per-vault hero card, holdings, policy panel, audit timeline, runtime health, in-browser runtime panel, session-key rotation, danger zone |
| `/zklogin/callback` | OAuth landing page for the Google sign-in flow |

### Marketing site (`web/site/`)

Static HTML/CSS/JS for Walrus Sites deployment. Includes the same backtest
JSONs as the dashboard so the landing page can show the real performance
numbers without a backend.

### Scripts (`scripts/`)

| Script | What it does |
|---|---|
| `seed-strategies.ts` | Publishes the three default strategies to a fresh package deployment. |
| `republish-strategies.ts` | Uploads each strategy's source bundle to Walrus, calls `publish_new_version` with the real `code_hash` + blob ID. |
| `backtest-strategies.ts` | Pulls 90 days of SUI/USD from CoinGecko, replays each strategy through its real `evaluate()` function, writes JSON to `web/dashboard/public/backtests/`. |

---

## 7. How the moat works (the single most important page)

**The smart contract is the only thing that can move money.** The AI just
proposes — the contract approves or denies. Every approval gate is checked in
the Move VM, atomically, every spend:

```move
public(package) fun assert_can_act(identity: &AgentIdentity, ctx: &TxContext) {
    assert!(!identity.revoked, ERevoked);                          // not killed
    assert!(ctx.sender() == identity.session_addr, ENotAuthorized);// signed by agent key
    assert!(ctx.epoch() < identity.expiry_epoch, EExpired);        // before expiry
}
public(package) fun assert_package_allowed(identity: &AgentIdentity, pkg: address) {
    assert!(identity.approved_packages.contains(&pkg), ENotWhitelisted);
}
public(package) fun record_spend(identity: &mut AgentIdentity, amount: u64) {
    assert!(identity.spent_this_epoch + amount <= identity.spend_per_epoch,
            EOverBudget);
}
```

A compromised AI runtime cannot bypass these. A jailbroken LLM cannot bypass
these. We — the protocol authors — cannot bypass these. The blockchain
literally aborts the transaction.

**That's the whole pitch.** Everything else (the marketplace, the
zkLogin onboarding, the dashboard polish, the audit reports) is in service of
demonstrating this one claim.

---

## 8. The 90-second live demo flow

1. **(15s) Open `/marketplace`** — three real backtest equity curves render. Conservative +7.43%, Balanced +8.84%, Aggressive -2.70% in 90 days of SUI/USD.
2. **(20s) Mint a vault** — Google sign-in via zkLogin, pick Balanced strategy, 5% spend cap per epoch, 0.1 SUI funding, sign once.
3. **(15s) Hit Run Tick** — agent reads Pyth + memory, picks rebalance, lands a real transaction on testnet. NAV chart updates, audit timeline appends.
4. **(15s) Try to exceed the cap** — call wallet::spend with over-budget amount via the CLI. Transaction reverts with abort code 5 (EOverBudget). Show the error on Sui Explorer.
5. **(15s) Revoke** — back to dashboard, click "Revoke vault", sign once. Run Tick again → reverts with abort code 3 (ERevoked).
6. **(10s) Show the strategist side** — `/strategist` console, deprecate one of your owned strategies in one transaction. Marketplace card flips to "Deprecated."

That's the entire pitch. *Acts on my behalf → cannot exceed limits → can be
killed → strategists earn on their work.*

---

## 9. What's verifiable end-to-end

Anyone can confirm every claim above without trusting us:

| Claim | How to verify |
|---|---|
| Package is live on testnet | `sui client object 0x7b3f59e4…aa67c` |
| Strategies are real shared objects | `sui client object 0x46996c0f…d3ec` (Conservative), etc. |
| Code is committed to Walrus | `curl https://aggregator.walrus-testnet.walrus.space/v1/blobs/-bQnLAEmESM3z88M7zKU_7i7AV50p6phlbDizCIzeiU` returns the actual TypeScript source |
| `code_hash` matches the blob | `sha256(blob_bytes)` equals the on-chain `code_hash` field |
| Backtest is reproducible | `npx tsx scripts/backtest-strategies.ts` re-derives the numbers from CoinGecko + the strategies' real `evaluate()` |
| Revocation actually stops the AI | Run a vault, revoke, attempt a tick — Move VM aborts |

---

## 10. What is *not* yet real (honest)

| Thing | Status |
|---|---|
| Mainnet deployment | Target Aug 20, 2026 — testnet today |
| External security audit | Booked-but-not-done. Plan: OtterSec or OpenZeppelin pre-mainnet |
| Real third-party strategists | Synapse Labs published all 3 today. Need at least one external publisher pre-demo for the marketplace to look organic |
| LLM-powered reasoning | Current strategies are deterministic (rebalancer, vol-gated, momentum). The "AI" framing covers any future LangGraph-based strategy a strategist publishes |
| Insurance / slashing pool | Future work — would let owners pay extra to be covered against smart-contract risk |
| Cross-chain support | Future work — Wormhole bridge for USDC sourced from other chains |

---

## 11. The two-sentence pitch

> *Synapse Vault is the smart-contract layer that lets you hire an AI to manage
> your treasury without trusting it. Strategists earn royalties on every vault
> they're hired by; owners revoke in one transaction; the Move VM is the only
> arbiter of what either side can do.*

---

*Last updated: May 16, 2026 · matches commit `2d7935a` and downstream.*
