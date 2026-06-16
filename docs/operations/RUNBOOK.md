# Synapse Vault — Operations Runbook

**Audience:** vault owners, operators, and judges verifying the hosted autonomous runtime.  
**Network:** Sui **testnet** (this submission). Mainnet cutover is documented separately in [README.md](../../README.md) §11.

This runbook describes how to **detect**, **diagnose**, and **restore** autonomous ticks when the dashboard shows a stalled runtime or when CloudWatch logs report failures. It reflects what is **implemented today** — not a future production wishlist.

---

## What “healthy” looks like

| Signal | Healthy |
|--------|---------|
| **Dashboard → Runtime health** | `Agent online · ticking on schedule` (last tick ≤ ~15 min at 10-min cadence) |
| **Audit timeline** | Badge `on-chain`; new rows after each tick (SWAP, ARTIFACT, LOG, or noop) |
| **CloudWatch** | `runtime once completed` with optional `txDigest` |
| **On-chain** | Recent `TickRecordedEvent` for the vault (see [Suiscan](https://suiscan.xyz/testnet)) |

**Demo vaults (testnet):**

| Vault | AgentIdentity |
|-------|----------------|
| Primary | `0x347dd8d77d137042bdae4bc847e4dda798529bd0bf934115ca0395b6afec65e8` |
| Secondary | `0xbefc3142c5138e07655485a984c031e18494f71279486b0dd01e949309268cf4` |

Log group (short id = bytes 2–10 of agent id): `/synapse/vault/347dd8d7`, `/synapse/vault/befc3142`.

---

## Architecture (one paragraph)

EventBridge runs an ECS Fargate task every **N minutes** (default **10**). The container executes `run.ts --once`: reads vault state on-chain, recalls MemWal, evaluates the strategy, and may submit a PTB signed by the **session key** (gas wallet). Treasury funds live inside `AgentIdentity`; the session pays **gas** only. When session SUI is low, the runtime may call `pull_operational_funds<SUI>` to top up from treasury within an owner-set **operational budget** per epoch.

---

## Dashboard warnings (read these first)

| Banner | Meaning |
|--------|---------|
| **`expired`** | `current_epoch >= expiry_epoch` — Move blocks all spends; runtime exits without submitting txs. **Fix:** Policy → Expiry → Extend. |
| **`runtime gas`** | Session SUI below runtime floor and/or operational budget exhausted for this epoch. **Fix:** Fund session + Policy → Operational budget (below). |
| **`revoked`** | Owner revoked the vault — intentional kill switch. |
| **Runtime health `stalled` / `offline`** | No recent `TickRecordedEvent` — use this runbook + CloudWatch. |

Inspector ([`/inspector`](https://synapse-kappa-sable.vercel.app/inspector)) shows the same gas/expiry warnings read-only (no wallet).

---

## Decision tree

```
Ticks not landing?
├─ Dashboard shows EXPIRED? → §3.1 Extend expiry
├─ Dashboard shows REVOKED? → intentional; no autonomous ticks
├─ Dashboard shows RUNTIME GAS?
│   ├─ Session balance very low? → §3.2 Fund session
│   └─ Op budget exhausted? → §3.3 Raise operational cap / wait epoch
├─ CloudWatch: "vault inactive" → §3.1
├─ CloudWatch: "session gas too low" / failureKind session-gas → §3.2
├─ CloudWatch: failureKind budget-or-treasury → §3.3
├─ CloudWatch: "vault runtime tick failed" (other) → §3.4 Strategy / DeepBook / attestation
└─ No logs at all? → §4 AWS / EventBridge
```

---

## Playbooks

### 3.1 Vault expired

**Symptoms:** Log `vault inactive` with `expiryEpoch` ≤ current epoch. Dashboard **expired** banner. No new on-chain events.

**Fix (owner wallet):**

1. Open [dashboard for your vault](https://synapse-kappa-sable.vercel.app/dashboard).
2. **Policy bounds** → **Expiry** → **Extend**.
3. Set new expiry **strictly greater** than current Sui epoch (e.g. current + 30).
4. Wait up to one tick interval (~10 min) or check logs.

Move rule: spends require `ctx.epoch() < expiry_epoch`.

---

### 3.2 Session gas depleted (most common)

**Symptoms:**

- CloudWatch: `session gas too low to pay for pull_operational_funds`, `failureKind: session-gas`, or `Balance of gas object … is lower than the needed amount`.
- Dashboard **runtime gas** banner; session balance often **&lt; 0.01 SUI**.
- Auto-refuel **cannot** run until the session has ~**0.004+ SUI** to pay for the `pull_operational_funds` PTB itself (chicken-and-egg).

**Why it happens:** Mint seeds ~**0.02 SUI** on the session; Walrus uploads, messaging, attestation, and repeated ticks drain it. Testnet demo vaults use a **0.2 SUI/epoch** operational cap that can also max out (see §3.3).

**Fix A — Dashboard (recommended):**

1. Connect **owner** wallet on the vault dashboard.
2. Scroll to **Fund session gas**.
3. Send **≥ 0.1 SUI** to the session address (UI shows live balance).
4. Confirm in logs within ~10 min: `runtime once completed` and ideally `txDigest`.

**Fix B — CLI:**

```bash
# Replace with your vault's session_addr from dashboard or chain
SESSION=0x0dc01d9b8949ef305a3eb7e3ad2d20b99e5fb0904cf285c7e752fee50ef8b7f9
sui client transfer-sui --to "$SESSION" --amount 100000000   # 0.1 SUI in MIST
```

**Verify:**

```bash
aws logs tail /synapse/vault/347dd8d7 --since 30m --format short
```

**Runtime floors (approximate):**

| Vault type | Target session balance |
|------------|------------------------|
| Walrus + artifacts | ~**0.03 SUI** operating minimum |
| Lightweight / no Walrus upload | ~**0.015 SUI** |

---

### 3.3 Operational budget exhausted

**Symptoms:** Log `pull_operational_funds rejected — operational cap exhausted` or `failureKind: budget-or-treasury`. Dashboard **runtime gas** banner showing `X / Y SUI` pulled this epoch with X = Y.

**On-chain:** `operationalCapPerEpoch` and `spentThisEpoch` on the `OperationalBudget` dynamic field. Counter resets when a pull happens in a **new** epoch.

**Fix (owner wallet):**

1. **Policy bounds** → **Operational budget** → **Update** — raise cap (e.g. **0.5 SUI/epoch** for demo vaults with Walrus + messaging).
2. Ensure **treasury holds SUI** (Holdings panel / **Deposit** if empty).
3. If cap is fine but epoch just rolled over, wait for next tick — or fund session directly (§3.2) to bypass pull for one cycle.

**Note:** Strategy **spend cap** (`spend_per_epoch` on swaps) is separate from **operational budget** (gas pulls). A large swap can hit spend cap (`EOverBudget`) even when gas is fine — raise spend cap in Policy if needed.

---

### 3.4 Tick failed — strategy, DeepBook, attestation

**Symptoms:** `vault runtime tick failed` without `session-gas` / `budget-or-treasury`.

| Log hint | Action |
|----------|--------|
| `ENotAttested` / enclave errors | Confirm enclave URL + object on hosted runtime; see [enclave/README.md](../../enclave/README.md) |
| DeepBook / swap abort | Often illiquidity or size; may noop — check `deepbook_adapter` events |
| `EOverBudget` on spend | Raise **spend cap** in Policy |
| MemWal / Pyth / RPC timeout | Usually transient; next tick may succeed (`TickSkippedError` in logs) |

---

### 3.5 Audit timeline empty but logs show success

1. Confirm timeline badge says **`on-chain`** (not `demo`).
2. Use vault-specific URL: `/dashboard/0x<agentId>`.
3. Click **`tx … ↗`** on a timeline row to open Suiscan.

---

## AWS operations

### View logs

```bash
# Primary demo vault
aws logs tail /synapse/vault/347dd8d7 --follow --format short

# Last hour only
aws logs tail /synapse/vault/347dd8d7 --since 1h
```

### Check schedule

```bash
aws events list-rules --name-prefix SynapseVaultRuntime-347dd8d7
# State should be ENABLED, rate(10 minutes)
```

### Pause / resume autonomy

```bash
# Pause (disable rule — name from list-rules output)
aws events disable-rule --name SynapseVaultRuntime-347dd8d7-TickSchedule-XXXX

# Resume
aws events enable-rule --name SynapseVaultRuntime-347dd8d7-TickSchedule-XXXX
```

### Rotate session key

1. Dashboard → **Session key** → rotate (owner).
2. Update Secrets Manager: `infrastructure/aws/scripts/push-secrets.sh` with new `.key`.
3. No stack redeploy required — next task picks up the secret.

Full deploy guide: [infrastructure/aws/README.md](../../infrastructure/aws/README.md).

---

## Alerting (what exists vs planned)

### Implemented today

| Mechanism | Purpose |
|-----------|---------|
| Dashboard banners | Expired, runtime gas, revoked |
| Runtime health panel | Stalled/offline from `TickRecordedEvent` age |
| **`SYNAPSE_ALERT_WEBHOOK_URL`** | Optional webhook on runtime start, crash, and max consecutive failures ([`sdk/packages/vault/src/runtime/alerts.ts`](../../sdk/packages/vault/src/runtime/alerts.ts)) |

Set on the Fargate task definition (not yet wired by default in dashboard-provisioned stacks):

```bash
SYNAPSE_ALERT_WEBHOOK_URL=https://hooks.slack.com/services/...
```

### Not implemented (honest gap — mainnet roadmap)

- CloudWatch **alarms** on tick success / failure (metric filters on log group)
- SNS / PagerDuty integration
- Automated **gas keeper** (owner Lambda topping session without manual Fund session)
- Adaptive refuel when session is below pull PTB gas (runtime still attempts noop and may count as failure)

Unattended production should add the above; testnet demos rely on **dashboard + this runbook + optional webhook**.

---

## Pre-flight checklist (before demo / judging window)

- [ ] `expiry_epoch` **>** current epoch (extend if within ~5 epochs)
- [ ] Session balance **≥ 0.1 SUI** (Fund session)
- [ ] Operational cap **≥ 0.5 SUI/epoch** for Walrus vaults (or fund session only)
- [ ] Treasury holds SUI + strategy coins
- [ ] EventBridge rule **ENABLED**
- [ ] Hosted runtime shows **live** + enclave ✓ if attestation required
- [ ] `aws logs tail` shows `runtime once completed` in last 20 min

---

## Escalation

1. CloudWatch log snippet + vault `agentId`
2. Suiscan link to last successful tick tx
3. Screenshot of dashboard banners (expired / runtime gas / policy)

**Security:** Never commit session keys, owner keys, or Anthropic API keys. Secrets live in AWS Secrets Manager (`synapse/vault/*`).

---

## Related docs

| Doc | Topic |
|-----|--------|
| [README.md](../../README.md) | Architecture, Walrus track matrix, honest status |
| [SUBMISSION.md](../../SUBMISSION.md) | Judge quickstart, proof txs |
| [infrastructure/aws/README.md](../../infrastructure/aws/README.md) | CDK deploy, costs, stack ops |
| [THREAT_MODEL.md](../../THREAT_MODEL.md) | Security boundaries |
| [enclave/README.md](../../enclave/README.md) | Nautilus attestation |

---

*Synapse Labs · testnet operations · Sui Overflow 2026*
