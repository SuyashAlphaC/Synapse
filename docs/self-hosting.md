# Synapse Vault — Self-Hosting Runbook

> Run a Synapse vault's autonomous runtime on your own machine, a tiny
> VPS, Fly.io, Railway, or AWS Fargate. The same `VaultRuntime` ships
> in every deployment shape — only the secret source and the supervisor
> differ.

This document is the operational counterpart to `docs/runtime-setup.md`.
It assumes you already have:

- A funded vault on Sui (mint + first session-key rotation done in the
  dashboard).
- The downloaded `.key` file from the dashboard's Session Key Panel.
- Optional MemWal delegate hex (skip the MemWal sections if you don't).

---

## 1. Pick a deployment shape

| Shape | Free? | Survives reboot? | Notes |
|---|---|---|---|
| `tsx` from your terminal | ✓ | No (terminal closes) | Smoke test only |
| `cron` + `node ./dist/runtime/bin/run.js --once` | ✓ | ✓ | $0 if you have a machine; closest analog to Fargate |
| Docker Compose on a home box / VPS | ✓ on your box | ✓ | Native Docker secrets — recommended for self-hosters |
| Fly.io worker (machine) | Free tier OK for tiny vaults | ✓ | Long-lived loop, secrets as files |
| Railway worker | Paid (~$5/mo) | ✓ | Set vars in the Railway UI |
| AWS Fargate + Secrets Manager | ~$2.50/vault/mo | ✓ | Cron model already wired in `infrastructure/aws/` |

For Sui Overflow demos and small DAOs, **Docker Compose on your own
box** is the sweet spot — zero cost, real secret mounts, identical to
the production image.

---

## 2. Configuration model

The runtime reads:

| Variable | Required | Source |
|---|---|---|
| `SYNAPSE_PACKAGE_ID` | yes | shared across all vaults |
| `SYNAPSE_AGENT_ID` | yes | per vault |
| `SYNAPSE_PACKAGE_HISTORY` | only if vault was minted under an older package | shared |
| `SYNAPSE_FULLNODE_URL` | recommended | shared (mainnet vs testnet) |
| `SYNAPSE_WALRUS_NETWORK` | recommended | shared |
| `SYNAPSE_TICK_INTERVAL_MS` | optional, default 600000 | per vault |
| `SYNAPSE_MAX_FAILURES` | optional, default 5 | per vault |
| `SYNAPSE_ALERT_WEBHOOK_URL` | optional | per vault or shared |
| `SYNAPSE_ALLOWED_STRATEGY_HASHES` | recommended for prod | shared |
| **Session key** | yes | per vault — secret |
| **MemWal delegate** | optional | per vault — secret |

The two secrets can come from **three** places, picked at runtime:

1. **Env vars** (`SYNAPSE_SESSION_KEY`, `MEMWAL_DELEGATE_KEY`) — fine
   for AWS Fargate + Secrets Manager (the existing setup), bad for a
   `.env` file you keep on disk.
2. **A file path** (`SYNAPSE_SESSION_KEY_PATH=/path/to/.key`) — fine
   for cron + manually managed files.
3. **`--secrets-dir <dir>`** — `FileSecretsProvider` reads
   `<dir>/session-key` and `<dir>/memwal-delegate`. This is the
   Docker / Fly / Railway convention.

`bootstrapConfig()` picks them in that precedence and logs which
source supplied each (`sessionKeySource: "provider"` etc.) so you
always know.

See `.env.example` for the full annotated template.

---

## 3. Docker Compose (recommended)

This is what `docker-compose.yml` in the repo root provides — native
Docker secrets, no key bytes in the env file or image.

```bash
# 1. Populate secrets
cp ~/Downloads/synapse-session-XXXXXXXX.key ./secrets/session-key
# optional memory recall:
echo "<64-char hex>" > ./secrets/memwal-delegate
chmod 600 ./secrets/*

# 2. Fill the non-secret env
cp .env.example .env
# Edit SYNAPSE_PACKAGE_ID, SYNAPSE_AGENT_ID, SYNAPSE_WALRUS_NETWORK

# 3. Build + run
docker compose up --build -d
docker compose logs -f runtime
```

The expected first log line:

```json
{"level":30,"agentId":"0x…","sessionKeySource":"provider",
 "memwalDelegateSource":"provider","mode":"continuous",
 "msg":"runtime starting"}
```

Single-tick (Fargate-style, exit 0/1):

```bash
docker compose run --rm runtime --once --secrets-dir /run/secrets
```

Multi-vault: copy `docker-compose.yml` per vault, change the service
name + secret file paths.

---

## 4. Bare-machine cron (cheapest)

Install Node 22, build the runtime once, then schedule `--once`:

```bash
git clone <repo> && cd Synapse
npm ci
npm --workspace @synapse-core/client run build
npm --workspace @synapse-core/memwal-bridge run build
npm --workspace @synapse-core/vault run build

# Drop the .key file somewhere chmod 600 + outside the repo
install -m 600 ~/Downloads/synapse-session-*.key ~/.synapse/session-key

# Build the env once
cat > ~/.synapse/env <<EOF
export SYNAPSE_PACKAGE_ID=0x5da36d892956a4659415e245126a3964dd5aa6cf19ec2fdf6332bf828a4c58ed
export SYNAPSE_AGENT_ID=0x<your-vault>
export SYNAPSE_SESSION_KEY_PATH=$HOME/.synapse/session-key
export SYNAPSE_WALRUS_NETWORK=testnet
# optional:
# export SYNAPSE_ALERT_WEBHOOK_URL=https://discord.com/api/webhooks/...
EOF
chmod 600 ~/.synapse/env
```

Crontab:

```cron
*/10 * * * * . $HOME/.synapse/env && cd /path/to/Synapse && \
  node sdk/packages/vault/dist/runtime/bin/run.js --once \
  >> /var/log/synapse-runtime.log 2>&1
```

This is functionally identical to the AWS Fargate cron path — same
binary, same env, no cloud bill.

---

## 5. Fly.io worker

Fly Machines can run without exposing ports — ideal for a worker.

```toml
# fly.toml — sdk/packages/vault/fly.toml
app = "synapse-vault-<short>"
primary_region = "iad"
kill_signal = "SIGTERM"
kill_timeout = 30

[build]
  dockerfile = "Dockerfile"
  # Build context must be the repo root.

[env]
  NODE_ENV = "production"
  SYNAPSE_WALRUS_NETWORK = "testnet"
  SYNAPSE_TICK_INTERVAL_MS = "600000"

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = 1024
```

```bash
# From repo root (Dockerfile copies the monorepo)
fly launch --copy-config --config sdk/packages/vault/fly.toml --no-deploy

fly secrets set \
  SYNAPSE_PACKAGE_ID=0x... \
  SYNAPSE_AGENT_ID=0x... \
  SYNAPSE_SESSION_KEY="$(jq -r .secretBase64 ~/keys/your-vault.key)"

fly deploy --config sdk/packages/vault/fly.toml
```

Fly env-injects secrets the same way Fargate does (`SYNAPSE_SESSION_KEY`
ends up in `process.env`); the `EnvSecretsProvider` is what reads them.

---

## 6. Railway worker

1. New Project → Deploy from GitHub repo.
2. Dockerfile path: `sdk/packages/vault/Dockerfile`; build context: repo root.
3. Service type: Worker (no public HTTP port).
4. Variables (Railway "Variables" tab):

   - `SYNAPSE_PACKAGE_ID`, `SYNAPSE_AGENT_ID`
   - `SYNAPSE_SESSION_KEY` (paste the `secretBase64`)
   - `SYNAPSE_WALRUS_NETWORK=testnet`
   - optional `MEMWAL_DELEGATE_KEY`, `SYNAPSE_ALERT_WEBHOOK_URL`

5. Restart policy: Always.

---

## 7. AWS Fargate

Already documented end-to-end in `infrastructure/aws/README.md`:
EventBridge cron → Fargate task → `--once` → exit. Use that for
production unless you have a reason to leave AWS.

---

## 8. Rotation runbook

**Session key:**

1. Dashboard → Session Key Panel → Rotate. Download the new `.key`.
2. Replace the secret:
   - Docker Compose: overwrite `./secrets/session-key` → `docker compose restart runtime`.
   - Fly: `fly secrets set SYNAPSE_SESSION_KEY="$(jq -r .secretBase64 new.key)"` — Fly restarts the machine.
   - Railway: paste new value into the variable → service redeploys.
   - Fargate: re-run `infrastructure/aws/scripts/push-secrets.sh` — the next scheduled task picks it up, no CDK redeploy.

The on-chain `agent::rotate_session_key` call invalidates the old key
**immediately** at the Move VM level. The container restart only
updates what the runtime *signs with*; the chain itself rejects the
old key starting with the rotation tx.

**MemWal delegate:** same flow, file `memwal-delegate` or env
`MEMWAL_DELEGATE_KEY`.

**Package upgrade (`SYNAPSE_PACKAGE_ID` changes):** update the env
template and redeploy every vault. Add the previous package ID to
`SYNAPSE_PACKAGE_HISTORY` so existing vault objects still resolve.

---

## 9. Operator alerting

Set one variable:

```bash
SYNAPSE_ALERT_WEBHOOK_URL=https://discord.com/api/webhooks/<id>/<token>
```

The runtime fires on:

| Event | When |
|---|---|
| `runtime_started` | On boot of the continuous loop |
| `runtime_failed` | Top-level crash (bad config, etc.) |
| `runtime_max_failures` | `SYNAPSE_MAX_FAILURES` consecutive failures — `process.exitCode = 1` |

Webhook failures **never** affect the tick path. The body works as-is
for Discord (`content`) and Slack (`text`); any other JSON sink gets
the structured `event` + `agentId` + `detail`.

No-tick-for-N-minutes alerts are best done *externally* — e.g. a
free Cron-Job.org / GitHub Actions workflow that pings your indexer
for `last_tick_at` and alerts if stale. The runtime can't reliably
alert on its own death.

---

## 10. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Set SYNAPSE_SESSION_KEY (inline secret) or SYNAPSE_SESSION_KEY_PATH (file path)` | No secret in env / file / `--secrets-dir`. Check `sessionKeySource` log line. |
| `String must be lowercase or uppercase` from `Ed25519Keypair.fromSecretKey` | The secret file isn't a valid `suiprivkey…` / base64 / JSON `.key`. Re-download from the dashboard. |
| `Strategy 0x…: code_hash … is not in the operator allowlist` | `SYNAPSE_ALLOWED_STRATEGY_HASHES` is set and this strategy's bundle hash isn't in it. Add the hash to the env, or remove the allowlist for that vault. |
| `vault inactive` + no tick | Vault was revoked or hit `expiry_epoch`. Mint or extend in the dashboard. |
| `auto-refuel: pull_operational_funds failed` | Operational budget cap is unset / exhausted, or treasury has no SUI. Fund + set cap in the dashboard. |
| `tick skipped (rpc/agent-state/market)` | Transient upstream outage. Next tick retries; counter is not advanced. |
| `walrus upload failed; proceeding with rebalance + on-chain audit only` | Session has no WAL (run `walrus get-wal`) or testnet storage-node consensus blip. Rebalance still lands on-chain. |
| Runtime exits with code 1 + `runtime_max_failures` alert | Same error N times in a row — investigate the underlying error in the logs. |

---

## 11. Production hardening checklist

Before letting real money flow:

- [ ] **Headless** — runtime runs on a server, not a browser tab.
- [ ] **Secrets** — session key + delegate live in `secrets/`, Fly secrets, Railway variables, or AWS Secrets Manager. **Never** in a `.env` file committed or shared.
- [ ] **Redacting logger** — verify a sample log line: `sessionKeySource` should print, `sessionKey` should never appear.
- [ ] **Forbidden-pattern scan** — CI green (`./scripts/check-forbidden-patterns.sh`).
- [ ] **Walrus allowlist** — `SYNAPSE_ALLOWED_STRATEGY_HASHES` set to your audited list (or per-vault consent flag off).
- [ ] **Alerting** — `SYNAPSE_ALERT_WEBHOOK_URL` configured; test by stopping the container.
- [ ] **Tick skip vs fail** — confirm with `tickSkipped` log lines that an oracle outage does not exit the process.
- [ ] **Rotation rehearsal** — rotate session key once, confirm next tick uses the new key without redeploy.
- [ ] **Mainnet config** — `SYNAPSE_PACKAGE_ID`, `SYNAPSE_FULLNODE_URL`, `SYNAPSE_WALRUS_NETWORK` all point at mainnet.
- [ ] **DEEP funding** — vault holds DEEP (or `pay_with_deep = false` is intentional).
- [ ] **Owner key** — hardware wallet or multisig, not a browser hot wallet.

Everything above is enforceable with the code in this repo at
no marginal cost.
