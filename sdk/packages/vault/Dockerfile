# Synapse Vault runtime — production container image.
#
# Builds the autonomous tick loop (sdk/packages/vault/src/runtime/bin/run.ts)
# into a slim Node 22 image that can run as:
#   - A long-lived process (default): VaultRuntime.start() loops every
#     SYNAPSE_TICK_INTERVAL_MS milliseconds forever.
#   - A one-shot batch (`--once`): single tick + exit, intended for
#     ECS Fargate scheduled tasks or AWS Lambda.
#
# Secrets resolution (`--secrets-dir`):
#   The runtime reads the session key + MemWal delegate from files
#   under a directory — the convention every container host uses
#   (Docker `/run/secrets`, Fly mounted secrets, Railway file vars).
#   AWS Fargate users keep their existing env-injection from Secrets
#   Manager — `SYNAPSE_SESSION_KEY` wins over the file when both exist.
#
# Required env at runtime:
#   SYNAPSE_PACKAGE_ID            (public)
#   SYNAPSE_AGENT_ID              (public)
#   SYNAPSE_SESSION_KEY           (secret — env path) OR mounted file
#                                 at /run/secrets/session-key when run
#                                 with `--secrets-dir /run/secrets`
#   MEMWAL_DELEGATE_KEY           (secret, optional, same options)
#   SYNAPSE_FULLNODE_URL          (optional, defaults to testnet)
#   SYNAPSE_WALRUS_NETWORK        (optional, testnet|mainnet)
#   SYNAPSE_TICK_INTERVAL_MS      (optional, default 600000)
#   SYNAPSE_ALERT_WEBHOOK_URL     (optional, Discord/Slack/JSON sink)

# ---------- Builder ----------
FROM node:22-alpine AS builder
WORKDIR /repo

# Workspace deps live across multiple package.json files. Copy the
# manifest skeleton first so npm install caches even when only source
# files change.
COPY package.json package-lock.json tsconfig.base.json ./
COPY sdk/packages/client/package.json ./sdk/packages/client/
COPY sdk/packages/memwal-bridge/package.json ./sdk/packages/memwal-bridge/
COPY sdk/packages/vault/package.json ./sdk/packages/vault/
COPY sdk/packages/design-tokens/package.json ./sdk/packages/design-tokens/
COPY sdk/packages/indexer/package.json ./sdk/packages/indexer/
COPY sdk/packages/adapters/langgraph/package.json ./sdk/packages/adapters/langgraph/
COPY sdk/packages/adapters/claude-sdk/package.json ./sdk/packages/adapters/claude-sdk/
COPY sdk/packages/adapters/eliza/package.json ./sdk/packages/adapters/eliza/

RUN npm ci --ignore-scripts

# Source.
COPY sdk/packages/client ./sdk/packages/client
COPY sdk/packages/memwal-bridge ./sdk/packages/memwal-bridge
COPY sdk/packages/vault ./sdk/packages/vault

# Compile vault + its workspace deps to JS.
RUN npm --workspace @synapse-core/client run build \
  && npm --workspace @synapse-core/memwal-bridge run build --if-present \
  && npm --workspace @synapse-core/vault run build

# ---------- Runtime image ----------
FROM node:22-alpine AS runtime
WORKDIR /app

# Run as non-root for least privilege.
RUN addgroup -S synapse && adduser -S -G synapse synapse \
  && mkdir -p /run/secrets && chown synapse:synapse /run/secrets

COPY --from=builder /repo/node_modules /app/node_modules
COPY --from=builder /repo/sdk /app/sdk
COPY --from=builder /repo/package.json /app/package.json
COPY --from=builder /repo/tsconfig.base.json /app/tsconfig.base.json

USER synapse

ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps

# Run the compiled JS (faster cold start than tsx, no transpiler in prod).
ENTRYPOINT ["node", "sdk/packages/vault/dist/runtime/bin/run.js"]
