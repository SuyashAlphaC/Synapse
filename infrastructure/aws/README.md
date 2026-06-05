# Synapse Vault — AWS deployment

Production hosting for the autonomous strategy runtime. Each vault gets
its own Fargate scheduled task that fires every N minutes, signs ticks
with the agent's session key (pulled at runtime from AWS Secrets
Manager), and emits real `TickRecordedEvent` events visible in the
dashboard's Runtime Health panel.

## Architecture

```
   EventBridge cron rule  (every 10 min)
            │
            ▼
   ECS Fargate scheduled task
            │
            ├─ pulls SYNAPSE_SESSION_KEY from Secrets Manager
            ├─ pulls MEMWAL_DELEGATE_KEY from Secrets Manager (optional)
            ├─ runs sdk/packages/vault/src/runtime/bin/run.ts --once
            │   ├─ reads vault state on chain (Sui RPC)
            │   ├─ fetches Pyth + DeepBookV3 market data
            │   ├─ recalls MemWal memory
            │   ├─ strategy.evaluate()
            │   ├─ if REBALANCE: builds + signs PTB, submits
            │   ├─ records performance, pays royalty
            │   └─ emits TickRecordedEvent on chain
            ▼
   CloudWatch Logs (/synapse/vault/<short-vault>)
```

One stack per vault. Multiple vaults = multiple stacks. State lives on
chain + Secrets Manager, the Fargate task is ephemeral.

## Prerequisites

- AWS account, AWS CLI authenticated (`aws configure`)
- `jq` (for the secrets push script)
- Node.js 22 + npm
- Docker daemon running (CDK builds the runtime image locally during
  `cdk deploy`)
- A funded session key for the vault you're deploying — download the
  `.key` file from the dashboard's Session Key Panel after a rotation

## One-time bootstrap (per AWS account/region)

```bash
cd infrastructure/aws
npm install
npx cdk bootstrap aws://<your-account-id>/<region>
```

Bootstrap creates the CDK toolkit stack (S3 bucket for assets, ECR repo
for images, IAM roles). You only do this once per account+region.

## Deploy a vault

### Recommended: dashboard “Enable hosted runtime”

Works on **Vercel** (serverless) and self-hosted Node. Set in Vercel → Settings → Environment Variables (or `.env.local` locally):

```bash
SYNAPSE_HOSTED_RUNTIME_ENABLED=true
AWS_ACCESS_KEY_ID=…
AWS_SECRET_ACCESS_KEY=…
SYNAPSE_HOSTED_RUNTIME_AWS_REGION=us-east-1
# Required on Vercel — one shared image for all vaults (no Docker on serverless):
SYNAPSE_HOSTED_RUNTIME_ECR_IMAGE=954257023818.dkr.ecr.us-east-1.amazonaws.com/cdk-hnb659fds-container-assets-954257023818-us-east-1:9f1945bb5441a2f4079cc18d225d2daec98804f47bf9e8537719ce96a5f295ad
```

The enable API upserts Secrets Manager secrets and starts a **CloudFormation** stack (Fargate + EventBridge) via the AWS SDK — no `cdk deploy` on the dashboard host. Typical provisioning time **2–4 minutes**.

**IAM permissions** for the deployer user: `cloudformation:*` (scoped to `SynapseVaultRuntime-*`), `ecs:*`, `events:*`, `logs:*`, `ec2:DescribeVpcs`, `ec2:DescribeSubnets`, `iam:PassRole`, `secretsmanager:*` on `synapse/vault/*`.

Optional overrides if your account has no default VPC:

```bash
SYNAPSE_HOSTED_RUNTIME_VPC_ID=vpc-…
SYNAPSE_HOSTED_RUNTIME_SUBNET_IDS=subnet-a,subnet-b,…
```

On `/dashboard/<vaultId>`, open **Hosted runtime**, upload the session `.key`, check consent, and click **Enable hosted runtime**.

### Manual operator path (CLI)

1. **Rotate the session key** in the dashboard. Save the downloaded
   `synapse-session-<hash>.key` file somewhere local — say
   `~/keys/vault-80c12701.key`.

2. **(Optional) save the MemWal delegate hex** in a file, one line, no
   whitespace.

3. **Push secrets** to AWS Secrets Manager:

   ```bash
   ./scripts/push-secrets.sh \
     <your-vault-id> \
     ~/keys/<your-vault>.key \
     ~/keys/<your-vault>.memwal      # optional
   ```

   Substitute `<your-vault-id>` with your AgentIdentity object ID (find
   it in the dashboard's banner under `/dashboard`). The script prints
   the names of the secrets it created/updated.

4. **Deploy the stack**:

   ```bash
   npx cdk deploy \
     -c agentId=<your-vault-id> \
     -c packageId=0x0240a49e849d2349a9ee403e6e08d897ce97c82dd0a1a9d9ebdb9ea4357de086 \
     -c sessionSecretName=synapse/vault/<short>/session-key \
     -c memwalSecretName=synapse/vault/<short>/memwal-delegate \
     -c tickIntervalMinutes=10
   ```

   The package ID above is the current **v5** (enclave attestation + royalty
   cap). Confirm the active value in `web/dashboard/lib/synapse-config.ts`.

   **Attested AI vault (the full product flow).** For a vault hiring the
   `llm-advisor` with `requires_attestation` on, also push the Anthropic key and
   pass the enclave config so the Fargate task calls the enclave + attests on
   every tick:

   ```bash
   # push the Anthropic key too (4th arg)
   ./scripts/push-secrets.sh <vault-id> ~/keys/<vault>.key ~/keys/<vault>.memwal ~/keys/anthropic.txt

   npx cdk deploy \
     -c agentId=<your-vault-id> \
     -c packageId=0x0240a49e…de086 \
     -c packageHistory=0x0240a49e…086,0x85215709…1534,0xd849b7b2…f01,0x5da36d89…8ed,0x7b3f59e4…a67c \
     -c sessionSecretName=synapse/vault/<short>/session-key \
     -c memwalSecretName=synapse/vault/<short>/memwal-delegate \
     -c anthropicSecretName=synapse/vault/<short>/anthropic-key \
     -c enclaveUrl=https://<your-oyster-or-nitro-enclave> \
     -c enclaveObjectId=0x361b7a26380d5312247ff0afca78086c996ecc159bd30ca3b0a5ee4bf949ab9f \
     -c tickIntervalMinutes=10
   ```

   The enclave must be reachable from Fargate (the Oyster/Nitro enclave has a
   public URL). The Anthropic key lives only in Secrets Manager + the enclave,
   never in the task definition.

   First deploy takes ~5 minutes (Docker build + ECR push + Fargate
   provisioning). Subsequent deploys are faster.

5. **Verify autonomy**: open the dashboard's Runtime Health panel. The
   status should flip from `Agent offline` to `Agent online · ticking on
   schedule` within ~12 minutes.

## Operations

| Task | Command |
|---|---|
| View runtime logs | `aws logs tail /synapse/vault/<short-vault> --follow` |
| Trigger a manual tick | `aws events put-events --entries '[{"Source":"local","DetailType":"manual"}]'` plus a target — or just delete + recreate the rule |
| Pause autonomy | Disable the EventBridge rule via console or `aws events disable-rule --name <rule>` |
| Rotate the session key | Rotate in dashboard → re-run `push-secrets.sh` with the new `.key` file — CDK stack picks up the new value on the next tick (no redeploy) |
| Session WAL for artifacts | Runtime auto-swaps SUI→WAL before each upload (adaptive refuel). Ensure treasury operational budget allows `pull_operational_funds` when session SUI is low |
| Destroy a stack | `npx cdk destroy SynapseVaultRuntime-<suffix>` |

## Cost estimate

Per vault, per month, at the default 10-minute tick interval:

- ECS Fargate: ~4,320 ticks × ~30s × 0.5 vCPU × 1 GB RAM ≈ **~$1.50/mo**
- CloudWatch Logs: ~30MB/mo ≈ **~$0.05/mo**
- Secrets Manager: 2 secrets × $0.40 ≈ **~$0.80/mo**
- EventBridge: free tier
- Data transfer: negligible (read-only outbound RPC calls)

Total: **~$2.50/mo per vault** at 10-minute cadence. Scales linearly —
60-minute cadence costs about $0.50/mo.

## Multi-vault deployments

Each `cdk deploy` invocation targets ONE vault, scoped by stack name
suffix (defaults to the vault ID prefix). To run two vaults:

```bash
# vault A
npx cdk deploy -c agentId=0xAAA… -c packageId=… -c sessionSecretName=… -c stackSuffix=alpha

# vault B
npx cdk deploy -c agentId=0xBBB… -c packageId=… -c sessionSecretName=… -c stackSuffix=beta
```

Both stacks live in the same AWS account and share the underlying ECR
repository — only the task definition, secrets, and EventBridge rule
differ.

## Troubleshooting

**`Agent stalled · 23m since last tick`** in the dashboard

Check the Fargate task logs:

```bash
aws logs tail /synapse/vault/<short-vault> --since 1h
```

Common causes:
- Session key out of gas — fund the session address with ~0.02 SUI
- Vault revoked — strategy aborts at `assert_can_act`; revocation is
  intentional behavior
- DeepBookV3 pool unhealthy / no liquidity for the trade size — swap
  reverts; tick records noop + emits the error in CloudWatch

**`Agent offline · no ticks`** in the dashboard

Confirm the EventBridge rule is enabled and the Fargate task definition
references the correct secret ARNs. If the Docker build failed during
`cdk deploy`, fix the build error (most often a workspace dep missing
in `Dockerfile`'s copy block) and re-deploy.

**Image build failures during `cdk deploy`**

CDK builds the Docker image locally before pushing to ECR. If
`docker build` fails, run it directly to debug:

```bash
docker build -f sdk/packages/vault/Dockerfile -t synapse-runtime-debug .
```

**`ENAMETOOLONG` / nested `cdk.out/asset.../cdk.out/...` paths**

A prior failed deploy left `infrastructure/aws/cdk.out` inside the Docker
asset staging tree. CDK then copies `cdk.out` into itself recursively. Fix:

```bash
rm -rf infrastructure/aws/cdk.out
npx cdk deploy …   # re-run; vault-runtime-stack excludes cdk.out going forward
```

## Why ECS Fargate and not Lambda

We considered Lambda + EventBridge cron — cheaper at the per-invoke
level — but:

- Our runtime depends on `@mysten/walrus` which ships a WASM blob too
  large to fit comfortably in Lambda's deployment bundle limits
- The full tick (Pyth fetch + DeepBook fetch + strategy eval + PTB
  sign + submit + waitForTransaction) sits around 20–40 seconds; well
  within Lambda's 15-minute cap but uncomfortably tight on cold starts
- Fargate gives us first-class Docker semantics and easy local
  reproduction (same image runs on a developer laptop)

For production tightening, a future iteration could split the runtime
into a control-plane Lambda (scheduling, secrets fetch) plus a
data-plane container (the tick itself), but the per-vault economics
don't justify it yet.
