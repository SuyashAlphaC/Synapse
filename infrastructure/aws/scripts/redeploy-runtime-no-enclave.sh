#!/usr/bin/env bash
#
# Build + push runtime image, then roll selected SynapseVaultRuntime-* stacks
# to the new tag and strip Nautilus enclave env vars (Option A demo path).
#
# Usage:
#   ./infrastructure/aws/scripts/redeploy-runtime-no-enclave.sh
#   ./infrastructure/aws/scripts/redeploy-runtime-no-enclave.sh 347dd8d7 befc3142
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"

STACK_SUFFIXES=("$@")
if [[ ${#STACK_SUFFIXES[@]} -eq 0 ]]; then
  STACK_SUFFIXES=(347dd8d7 befc3142)
fi

ok()   { printf '\033[32m✓\033[0m %s\n' "$*" >&2; }
info() { printf '\033[36m→\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; }

IMAGE="$("$HERE/push-runtime-image.sh" --no-update-stacks)"
ok "Built and pushed ${IMAGE}"

for SUFFIX in "${STACK_SUFFIXES[@]}"; do
  STACK="SynapseVaultRuntime-${SUFFIX}"
  info "Updating ${STACK} — new image, no enclave env"
  TEMPLATE_FILE="$(mktemp)"
  UPDATED_FILE="$(mktemp)"
  aws cloudformation get-template \
    --stack-name "$STACK" \
    --query TemplateBody \
    --output json > "$TEMPLATE_FILE"

  jq --arg img "$IMAGE" '
    walk(
      if type == "object" and has("Image") and (.Image | type == "string") and (.Image | test("dkr\\.ecr"))
      then .Image = $img
      else .
      end
    )
    | walk(
      if type == "object" and has("Environment") and (.Environment | type == "array")
      then .Environment = [.Environment[] | select(.Name != "SYNAPSE_ENCLAVE_URL" and .Name != "SYNAPSE_ENCLAVE_OBJECT_ID")]
      else .
      end
    )
  ' "$TEMPLATE_FILE" > "$UPDATED_FILE"

  if ! OUTPUT="$(aws cloudformation update-stack \
    --stack-name "$STACK" \
    --template-body "file://${UPDATED_FILE}" \
    --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM 2>&1)"; then
    if echo "$OUTPUT" | grep -q "No updates are to be performed"; then
      info "${STACK} already up to date"
    else
      err "${STACK} update failed: ${OUTPUT}"
      exit 1
    fi
  else
    ok "${STACK} update started"
  fi
  rm -f "$TEMPLATE_FILE" "$UPDATED_FILE"
done

echo
ok "Redeploy complete. Image: ${IMAGE}"
info "Disable Nautilus attestation on each vault in Policy panel before the next tick."
