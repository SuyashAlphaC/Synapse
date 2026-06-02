# Synapse decision enclave image. Built reproducibly (pinned base digest) so the
# PCR measurement is deterministic — that hash is what gets registered on-chain
# via synapse_core::enclave. Bump the digest only deliberately; any change here
# changes the PCRs and requires a re-registration (enclave::update_pcrs).
FROM node:22-alpine@sha256:9f3ae04faa4d2188825803bf890792f33cc39033c9241fc6bb201149470436ca

WORKDIR /app

# Install deps from the lockfile only — reproducible, no network resolution drift.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# The signing key is mounted by the Oyster runtime at /app/signing-key.
ENV SIGNING_KEY_PATH=/app/signing-key
EXPOSE 3000

CMD ["node", "src/index.js"]
