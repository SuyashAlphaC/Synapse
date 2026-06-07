#!/usr/bin/env bash
#
# Build + push runtime image, then roll selected SynapseVaultRuntime-* stacks
# to the new tag and ensure Nautilus enclave env vars are set (attested demo path).
#
# Usage:
#   ./infrastructure/aws/scripts/redeploy-runtime-with-enclave.sh
#   ./infrastructure/aws/scripts/redeploy-runtime-with-enclave.sh 347dd8d7 befc3142
#
# Override enclave endpoint:
#   ENCLAVE_URL=http://54.166.136.55:3000 \
#   ENCLAVE_OBJECT_ID=0x2e170c4465913426e8a1a934fac1cc93b863dd28205778bf2d3cff11deeaf4be \
#   ./infrastructure/aws/scripts/redeploy-runtime-with-enclave.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

STACK_SUFFIXES=("$@")
if [[ ${#STACK_SUFFIXES[@]} -eq 0 ]]; then
  STACK_SUFFIXES=(347dd8d7 befc3142)
fi

ENCLAVE_URL="${ENCLAVE_URL:-http://54.166.136.55:3000}"
ENCLAVE_OBJECT_ID="${ENCLAVE_OBJECT_ID:-0x2e170c4465913426e8a1a934fac1cc93b863dd28205778bf2d3cff11deeaf4be}"

ok()   { printf '\033[32m✓\033[0m %s\n' "$*" >&2; }
info() { printf '\033[36m→\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; }

IMAGE="$("$HERE/push-runtime-image.sh" --no-update-stacks)"
ok "Built and pushed ${IMAGE}"

for SUFFIX in "${STACK_SUFFIXES[@]}"; do
  STACK="SynapseVaultRuntime-${SUFFIX}"
  info "Updating ${STACK} — new image + enclave env"
  TEMPLATE_FILE="$(mktemp)"
  UPDATED_FILE="$(mktemp)"
  aws cloudformation get-template \
    --stack-name "$STACK" \
    --query TemplateBody \
    --output json > "$TEMPLATE_FILE"

  jq --arg img "$IMAGE" --arg url "$ENCLAVE_URL" --arg obj "$ENCLAVE_OBJECT_ID" '
    walk(
      if type == "object" and has("Image") and (.Image | type == "string") and (.Image | test("dkr\\.ecr"))
      then .Image = $img
      else .
      end
    )
    | walk(
      if type == "object" and has("Environment") and (.Environment | type == "array")
      then
        .Environment = (
          [.Environment[] | select(.Name != "SYNAPSE_ENCLAVE_URL" and .Name != "SYNAPSE_ENCLAVE_OBJECT_ID")]
          + [
              { Name: "SYNAPSE_ENCLAVE_URL", Value: $url },
              { Name: "SYNAPSE_ENCLAVE_OBJECT_ID", Value: $obj }
            ]
        )
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
info "Enclave: ${ENCLAVE_URL} (${ENCLAVE_OBJECT_ID})"
info "Vaults should keep requires_attestation=true. Redeploy enclave with trade-guards if small legs abort."
