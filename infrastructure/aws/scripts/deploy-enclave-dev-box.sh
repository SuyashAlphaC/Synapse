#!/usr/bin/env bash
#
# Deploy enclave/src (including trade-guards) to the shared testnet dev box
# and restart synapse-enclave.service. Preserves the existing signing-key.
#
# Prerequisites: AWS CLI, SSH key at ~/synapse-enclave-key.pem, SG allows your IP on :22.
#
# Usage:
#   ./infrastructure/aws/scripts/deploy-enclave-dev-box.sh
#
# Override:
#   ENCLAVE_HOST=54.166.136.55 ENCLAVE_SSH_KEY=~/synapse-enclave-key.pem ./...
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"

ENCLAVE_HOST="${ENCLAVE_HOST:-54.166.136.55}"
ENCLAVE_USER="${ENCLAVE_USER:-ubuntu}"
SSH_KEY="${ENCLAVE_SSH_KEY:-$HOME/synapse-enclave-key.pem}"
REMOTE_DIR="${ENCLAVE_REMOTE_DIR:-/home/ubuntu/Synapse/enclave}"

ok()   { printf '\033[32m✓\033[0m %s\n' "$*" >&2; }
info() { printf '\033[36m→\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

[[ -f "$SSH_KEY" ]] || die "SSH key not found: ${SSH_KEY}"
command -v scp >/dev/null || die "scp not found"
command -v ssh >/dev/null || die "ssh not found"

TARGET="${ENCLAVE_USER}@${ENCLAVE_HOST}"
SSH_OPTS=(-o StrictHostKeyChecking=no -i "$SSH_KEY")

info "Ensuring SSH access (add your IP to sg-02e2d9b74257eaa72 if connect fails)"
MY_IP="$(curl -s https://checkip.amazonaws.com | tr -d '\n')"
aws ec2 authorize-security-group-ingress \
  --group-id sg-02e2d9b74257eaa72 \
  --protocol tcp --port 22 --cidr "${MY_IP}/32" 2>/dev/null \
  || true

info "Copying enclave src → ${TARGET}:${REMOTE_DIR}/src"
scp "${SSH_OPTS[@]}" \
  "$REPO_ROOT/enclave/src/index.js" \
  "$REPO_ROOT/enclave/src/trade-guards.js" \
  "$REPO_ROOT/enclave/src/runner.js" \
  "$REPO_ROOT/enclave/src/payload.js" \
  "${TARGET}:${REMOTE_DIR}/src/"

info "Restarting synapse-enclave.service"
ssh "${SSH_OPTS[@]}" "$TARGET" bash -s <<'REMOTE'
set -euo pipefail
grep -q trade-guards /home/ubuntu/Synapse/enclave/src/index.js
sudo systemctl restart synapse-enclave.service
sleep 2
systemctl is-active synapse-enclave.service
curl -sf localhost:3000/health >/dev/null
curl -sf localhost:3000/public-key >/dev/null
REMOTE

ok "Enclave dev box redeployed at http://${ENCLAVE_HOST}:3000"
info "Signing key unchanged — no on-chain enclave re-registration needed."
