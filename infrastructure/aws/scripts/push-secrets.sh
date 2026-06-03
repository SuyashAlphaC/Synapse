#!/usr/bin/env bash
#
# Push the session keypair (and optional MemWal delegate key) into AWS
# Secrets Manager. The CDK stack imports them by name, so the same
# secret can be shared across cdk deploy invocations or reused after
# stack destroys.
#
# Usage:
#   ./push-secrets.sh <vault-id> <session-key-file> [memwal-delegate-key-file]
#
# Where:
#   vault-id                 = the AgentIdentity object id (0x…)
#   session-key-file         = the .key file downloaded from the dashboard
#                              (JSON with {"address":"…","secretBase64":"…"})
#   memwal-delegate-key-file = (optional) a text file with the MemWal
#                              delegate hex (064dae…)
#
# Requires: AWS CLI authenticated, jq.

set -euo pipefail

VAULT_ID="${1:-}"
SESSION_FILE="${2:-}"
MEMWAL_FILE="${3:-}"
ANTHROPIC_FILE="${4:-}"   # optional: text file with the Anthropic API key (one line)

if [[ -z "$VAULT_ID" || -z "$SESSION_FILE" ]]; then
  echo "usage: $0 <vault-id> <session-key-file> [memwal-delegate-key-file] [anthropic-key-file]" >&2
  exit 1
fi

SHORT="${VAULT_ID:2:8}"
SESSION_NAME="synapse/vault/$SHORT/session-key"
MEMWAL_NAME="synapse/vault/$SHORT/memwal-delegate"
ANTHROPIC_NAME="synapse/vault/$SHORT/anthropic-key"

# Reduce the .key JSON to the secretBase64 the runtime expects.
SECRET_PLAIN="$(jq -r '.secretBase64' "$SESSION_FILE")"
if [[ -z "$SECRET_PLAIN" || "$SECRET_PLAIN" == "null" ]]; then
  echo "ERROR: $SESSION_FILE missing .secretBase64" >&2
  exit 2
fi

echo "→ pushing session key to Secrets Manager ($SESSION_NAME)"
if aws secretsmanager describe-secret --secret-id "$SESSION_NAME" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value \
    --secret-id "$SESSION_NAME" \
    --secret-string "$SECRET_PLAIN" >/dev/null
else
  aws secretsmanager create-secret \
    --name "$SESSION_NAME" \
    --description "Synapse Vault session key for $VAULT_ID" \
    --secret-string "$SECRET_PLAIN" >/dev/null
fi
echo "  ✓ session secret ready"

if [[ -n "$MEMWAL_FILE" ]]; then
  if [[ ! -f "$MEMWAL_FILE" ]]; then
    echo "ERROR: $MEMWAL_FILE not found" >&2
    exit 3
  fi
  MEMWAL_PLAIN="$(tr -d '[:space:]' < "$MEMWAL_FILE")"
  echo "→ pushing MemWal delegate to Secrets Manager ($MEMWAL_NAME)"
  if aws secretsmanager describe-secret --secret-id "$MEMWAL_NAME" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value \
      --secret-id "$MEMWAL_NAME" \
      --secret-string "$MEMWAL_PLAIN" >/dev/null
  else
    aws secretsmanager create-secret \
      --name "$MEMWAL_NAME" \
      --description "Synapse Vault MemWal delegate key for $VAULT_ID" \
      --secret-string "$MEMWAL_PLAIN" >/dev/null
  fi
  echo "  ✓ memwal secret ready"
fi

if [[ -n "$ANTHROPIC_FILE" ]]; then
  if [[ ! -f "$ANTHROPIC_FILE" ]]; then
    echo "ERROR: $ANTHROPIC_FILE not found" >&2
    exit 4
  fi
  ANTHROPIC_PLAIN="$(tr -d '[:space:]' < "$ANTHROPIC_FILE")"
  echo "→ pushing Anthropic key to Secrets Manager ($ANTHROPIC_NAME)"
  if aws secretsmanager describe-secret --secret-id "$ANTHROPIC_NAME" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value \
      --secret-id "$ANTHROPIC_NAME" \
      --secret-string "$ANTHROPIC_PLAIN" >/dev/null
  else
    aws secretsmanager create-secret \
      --name "$ANTHROPIC_NAME" \
      --description "Synapse Vault Anthropic API key for $VAULT_ID" \
      --secret-string "$ANTHROPIC_PLAIN" >/dev/null
  fi
  echo "  ✓ anthropic secret ready"
fi

echo
echo "Next: cd infrastructure/aws && cdk deploy \\"
echo "  -c agentId=$VAULT_ID \\"
echo "  -c packageId=<your synapse_core package id> \\"
echo "  -c sessionSecretName=$SESSION_NAME \\"
if [[ -n "$MEMWAL_FILE" ]]; then
  echo "  -c memwalSecretName=$MEMWAL_NAME \\"
fi
if [[ -n "$ANTHROPIC_FILE" ]]; then
  echo "  -c anthropicSecretName=$ANTHROPIC_NAME \\"
fi
echo "  # attested vault: add -c enclaveUrl=… -c enclaveObjectId=…"
echo "  -c tickIntervalMinutes=10"
