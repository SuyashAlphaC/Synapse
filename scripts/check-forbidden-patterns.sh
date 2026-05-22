#!/usr/bin/env bash
#
# Forbidden-pattern scan for security-critical TypeScript packages.
#
# Mirrors the gate documented in docs/threat-model.md §5
# ("Pre-publish audit checklist → Off-chain SDK"). Patterns that fire:
#
#   TODO / FIXME      — unresolved work in a security-critical path
#   Math.random(      — non-cryptographic randomness (forbidden in
#                       anything that touches keys, nonces, or audit IDs)
#   @ts-ignore        — typecheck escape hatch (use @ts-expect-error
#                       with a written reason instead)
#   console.log       — bypasses the redacting logger (secret leak risk)
#   `as any`          — typesystem escape hatch
#
# Scope is the runtime + signing + memory layers; the indexer's
# operator-facing startup banner is allowed to keep `console.log`.
# Tests + dist + node_modules + debug-*.{ts,mjs} are excluded.

set -euo pipefail

ROOTS=(
  "sdk/packages/vault/src"
  "sdk/packages/client/src"
  "sdk/packages/memwal-bridge/src"
)

PATTERN='TODO|FIXME|Math\.random\(|@ts-ignore|console\.log|\bas any\b'

HITS=0
for root in "${ROOTS[@]}"; do
  if [[ ! -d "$root" ]]; then
    echo "warn: scan root missing: $root" >&2
    continue
  fi

  output=$(rg -n "$PATTERN" "$root" \
    -g '!*.test.ts' \
    -g '!debug-*.ts' \
    -g '!debug-*.mjs' \
    || true)

  if [[ -n "$output" ]]; then
    echo "❌ forbidden patterns in $root:" >&2
    echo "$output" >&2
    HITS=$((HITS + 1))
  fi
done

if [[ "$HITS" -gt 0 ]]; then
  echo "" >&2
  echo "Fix the matches above, or move the code outside the scanned roots" >&2
  echo "if it is genuinely non-security-critical." >&2
  exit 1
fi

echo "✓ forbidden-pattern scan clean across ${#ROOTS[@]} root(s)"
