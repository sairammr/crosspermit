#!/usr/bin/env bash
#
# Everything that runs without a live chain, in the order a change should break it.
# Live-chain proofs are opt-in:  FORK=1 forge test --match-path 'test/*Fork*'
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n=== %s ===\n' "$*"; }

step "typecheck"
for pkg in packages/sdk packages/multibaas apps/relayer; do
  printf '  %-22s' "$pkg"
  (cd "$pkg" && bunx tsc --noEmit) && echo "ok"
done

step "unit tests"
(cd packages/sdk && bun test)
(cd apps/relayer && bun test)

step "contracts"
(cd contracts && forge build)

step "fixtures"
# Regenerated from this working tree, so a client that drifted from the contract fails a test rather
# than a testnet transaction.
bun run packages/sdk/scripts/gen-fixtures.ts

step "forge"
(cd contracts && forge test)

step "no upstream branding in the product surface"
if grep -rin "permit3" contracts/src packages apps --include="*.sol" --include="*.ts" --include="*.tsx"; then
  echo "FAIL: upstream branding found"
  exit 1
fi
echo "  clean"

printf '\nALL OFFLINE CHECKS PASSED\n'
