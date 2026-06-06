#!/usr/bin/env bash
#
# Build the vault runtime Docker image, push to the account's CDK ECR repo,
# and roll all SynapseVaultRuntime-* CloudFormation stacks to the new tag.
#
# Usage:
#   ./infrastructure/aws/scripts/push-runtime-image.sh
#   ./infrastructure/aws/scripts/push-runtime-image.sh --no-update-stacks
#
# Prerequisites: AWS CLI authenticated, Docker daemon running, git.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
UPDATE_STACKS=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-update-stacks) UPDATE_STACKS=0; shift ;;
    -h|--help)
      echo "Usage: $0 [--no-update-stacks]"
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
info() { printf '\033[36m→\033[0m %s\n' "$*"; }
err()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

command -v aws >/dev/null  || die "aws CLI not found"
command -v docker >/dev/null || die "docker not found"
command -v jq >/dev/null   || die "jq not found"
docker info >/dev/null 2>&1 || die "docker daemon not running"

REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
ECR_REPO="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/cdk-hnb659fds-container-assets-${ACCOUNT}-${REGION}"

GIT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo manual)"
TAG="synapse-runtime-${GIT_SHA}"
IMAGE="${ECR_REPO}:${TAG}"
LATEST="${ECR_REPO}:synapse-runtime-latest"

info "Building runtime image (linux/amd64) — tag ${TAG}"
docker build \
  --platform linux/amd64 \
  -f "$REPO_ROOT/sdk/packages/vault/Dockerfile" \
  -t "$IMAGE" \
  "$REPO_ROOT"

info "Logging in to ECR (${ECR_REPO})"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"

info "Pushing ${IMAGE}"
docker push "$IMAGE"
docker tag "$IMAGE" "$LATEST"
docker push "$LATEST"
ok "Image pushed: ${IMAGE}"
ok "Also tagged:  ${LATEST}"

if [[ "$UPDATE_STACKS" -eq 0 ]]; then
  echo "$IMAGE"
  exit 0
fi

STACKS="$(aws cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE \
  --query "StackSummaries[?starts_with(StackName, 'SynapseVaultRuntime-')].StackName" \
  --output text)"

if [[ -z "$STACKS" ]]; then
  info "No SynapseVaultRuntime-* stacks found — image push only"
  echo "$IMAGE"
  exit 0
fi

for STACK in $STACKS; do
  info "Updating stack ${STACK} → ${TAG}"
  TEMPLATE_FILE="$(mktemp)"
  aws cloudformation get-template \
    --stack-name "$STACK" \
    --query TemplateBody \
    --output json > "$TEMPLATE_FILE"

  UPDATED_FILE="$(mktemp)"
  jq --arg img "$IMAGE" '
    walk(
      if type == "object" and has("Image") and (.Image | type == "string") and (.Image | test("dkr\\.ecr"))
      then .Image = $img
      else .
      end
    )
  ' "$TEMPLATE_FILE" > "$UPDATED_FILE"

  if ! OUTPUT="$(aws cloudformation update-stack \
    --stack-name "$STACK" \
    --template-body "file://${UPDATED_FILE}" \
    --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM 2>&1)"; then
    if echo "$OUTPUT" | grep -q "No updates are to be performed"; then
      info "Stack ${STACK} already on ${TAG} (no changes)"
    else
      err "Stack ${STACK} update failed: ${OUTPUT}"
    fi
  else
    ok "Stack ${STACK} update started"
  fi

  rm -f "$TEMPLATE_FILE" "$UPDATED_FILE"
done

echo
ok "Done. New image: ${IMAGE}"
echo "Set SYNAPSE_HOSTED_RUNTIME_ECR_IMAGE=${IMAGE} for future dashboard enables."
