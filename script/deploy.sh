#!/usr/bin/env bash
#
# Deploys the two halves of CrossPermit to Ethereum / Base / Optimism Sepolia:
#
#   core    CrossPermit at the SAME address on every chain, via the ERC-2470 singleton factory.
#           Identical init code + identical salt + same factory => identical address. That is a hard
#           requirement, not an optimisation: the CrossPermit EIP-712 domain pins chainId to 1 but
#           still includes `verifyingContract`, so one signature only covers every chain if the
#           address matches everywhere.
#   router  Uniswap's own Universal Router, with its own per-chain parameters, and exactly one thing
#           changed: `permit2` points at our CrossPermit. CrossPermit's transferFrom overloads are
#           selector-identical to Permit2's, so the router's payment path is untouched.
#
# Usage: script/deploy.sh [core|router|all]
# Env (via .env): PRIVATE_KEY, SALT, RPC_ETH_SEPOLIA, RPC_BASE_SEPOLIA, RPC_OP_SEPOLIA
# Optional: DEPLOYER_ACCOUNT + KEYSTORE_PASSWORD_FILE keep the key out of argv for the router step.
#
# Written for the bash 3.2 that ships with macOS: no associative arrays, no GNU-only sed.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

# .env fills in what the environment has not already set, so an explicit override wins.
if [ -f .env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; *=*) ;; *) continue ;; esac
    key=${line%%=*}
    [ -n "${!key:-}" ] || export "$key=${line#*=}"
  done < .env
fi
: "${PRIVATE_KEY:?set PRIVATE_KEY in .env}"
: "${SALT:?set SALT in .env}"
: "${RPC_ETH_SEPOLIA:?}" "${RPC_BASE_SEPOLIA:?}" "${RPC_OP_SEPOLIA:?}"

ERC2470=0xce0042B868300000d44A59004Da54A005ffdcf9f
CANONICAL_PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3
UR_REPO=https://github.com/Uniswap/universal-router.git
UR_COMMIT=${UR_COMMIT:-543e1a19d6e21e31ced2512eec5792b50f13a0ba}
UR_CLONE=$ROOT/.work/universal-router

# name|chainId|rpc — the name is both the deployParameters file name and its contract name.
chains() {
  cat <<EOF
Sepolia|11155111|$RPC_ETH_SEPOLIA
BaseSepolia|84532|$RPC_BASE_SEPOLIA
OPSepolia|11155420|$RPC_OP_SEPOLIA
EOF
}

say() { printf '\n=== %s ===\n' "$*"; }

# 0 = code present, 1 = definitely empty, 2 = could not tell.
# `cast code` prints nothing and exits non-zero on an unreachable or rate-limited RPC, so an empty
# answer must never be read as "deployed" — that is exactly how a skipped deploy reports success.
have_code() { # <address> <rpc>
  local code
  code=$(cast code "$1" --rpc-url "$2" 2>/dev/null) || return 2
  case "$code" in
    0x | "") return 1 ;;
    *) return 0 ;;
  esac
}

# Public RPCs load-balance across nodes, so a read straight after a broadcast can hit a node that has
# not seen the block yet. Poll, and treat "could not tell" as not-yet rather than as success.
wait_for_code() { # <address> <rpc>
  local i
  for i in $(seq 1 30); do
    have_code "$1" "$2" && return 0
    sleep 2
  done
  return 1
}

preflight() {
  say "preflight"
  local name id rpc live bal
  while IFS='|' read -r name id rpc; do
    live=$(cast chain-id --rpc-url "$rpc")
    [ "$live" = "$id" ] || { echo "$name: RPC reports chainId $live, expected $id — check .env"; exit 1; }
    have_code "$ERC2470" "$rpc" || { echo "$name: ERC-2470 factory missing or RPC unreachable"; exit 1; }
    bal=$(cast balance "$(cast wallet address --private-key "$PRIVATE_KEY")" --rpc-url "$rpc")
    [ "$bal" != "0" ] || { echo "$name: deployer has no gas"; exit 1; }
    printf '  %-16s chainId=%-9s factory=ok  balance=%s wei\n' "$name" "$id" "$bal"
  done < <(chains)
}

# Predict the ERC-2470 address: keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:].
predict_core() {
  local init hash
  init=$(jq -r '.bytecode.object' contracts/out/CrossPermit.sol/CrossPermit.json)
  hash=$(cast keccak "$(cast concat-hex 0xff $ERC2470 "$SALT" "$(cast keccak "$init")")")
  cast to-check-sum-address "0x${hash: -40}"
}

deploy_core() {
  say "crosspermit core"
  (cd contracts && forge build >/dev/null)
  local expected name id rpc rc
  expected=$(predict_core)
  echo "  predicted address: $expected"
  mkdir -p deployments

  while IFS='|' read -r name id rpc; do
    have_code "$expected" "$rpc" && rc=0 || rc=$?
    case $rc in
      0) echo "  $name: already deployed, skipping" ;;
      2) echo "  $name: cannot read chain state, refusing to guess"; exit 1 ;;
      *)
        (cd contracts && PRIVATE_KEY="$PRIVATE_KEY" SALT="$SALT" \
          forge script script/DeployCrossPermit.s.sol:DeployCrossPermit --rpc-url "$rpc" --broadcast) \
          > "$ROOT/deployments/crosspermit-$name.log"
        echo "  $name: deployed"
        ;;
    esac
    wait_for_code "$expected" "$rpc" || { echo "  $name: no code at $expected"; exit 1; }
  done < <(chains)

  echo "$expected" > deployments/crosspermit.address
  cat > deployments/crosspermit.json <<EOF
{
  "contract": "CrossPermit",
  "address": "$expected",
  "salt": "$SALT",
  "factory": "$ERC2470",
  "compiler": { "solc": "0.8.27", "optimizer": true, "runs": 1000000 },
  "chains": {
    "ethereum-sepolia": 11155111,
    "base-sepolia": 84532,
    "optimism-sepolia": 11155420
  }
}
EOF
  echo "  CrossPermit live at $expected on all three chains"
}

# Keep the key out of argv when a keystore is configured; otherwise say plainly that it is not.
wallet_args() {
  if [ -n "${DEPLOYER_ACCOUNT:-}" ] && [ -n "${KEYSTORE_PASSWORD_FILE:-}" ]; then
    printf -- '--account\n%s\n--password-file\n%s\n' "$DEPLOYER_ACCOUNT" "$KEYSTORE_PASSWORD_FILE"
  else
    echo "  note: passing the key on the command line (visible to 'ps'). Set DEPLOYER_ACCOUNT" >&2
    echo "        and KEYSTORE_PASSWORD_FILE to use a keystore instead." >&2
    printf -- '--private-key\n%s\n' "$PRIVATE_KEY"
  fi
}

deploy_router() {
  say "crosspermit router"
  local core
  core=$(cat deployments/crosspermit.address 2>/dev/null) || true
  [ -n "${core:-}" ] || { echo "run 'script/deploy.sh core' first"; exit 1; }

  mkdir -p .work
  [ -d "$UR_CLONE" ] || git clone -q "$UR_REPO" "$UR_CLONE"
  (
    cd "$UR_CLONE"
    git checkout -q "$UR_COMMIT"
    git submodule update --init --recursive -q
    # The repo resolves @uniswap/v2-core and v3-core through node_modules, so submodules alone are
    # not enough to compile it.
    [ -d node_modules ] || yarn install --frozen-lockfile --silent
  )

  # Never leave the clone holding a patched permit2 address, whatever happens below.
  trap 'git -C "$UR_CLONE" checkout -q -- script/deployParameters/ 2>/dev/null || true' EXIT

  local wallet name id rpc f n addr
  wallet=$(wallet_args)

  while IFS='|' read -r name id rpc; do
    f="script/deployParameters/Deploy$name.s.sol"
    [ -f "$UR_CLONE/$f" ] || { echo "missing $f"; exit 1; }

    # Skip a chain that already has a recorded router pointing at THIS core. Without this, a re-run
    # of `deploy.sh all` quietly deploys a second router per chain and rewrites the record to it,
    # which strands every allowance already granted to the first one.
    rec="$ROOT/deployments/router-$name.json"
    if [ -f "$rec" ] && [ "$(jq -r .crossPermit "$rec")" = "$core" ]; then
      existing=$(jq -r .universalRouter "$rec")
      if have_code "$existing" "$rpc"; then
        echo "  $name: router already at $existing, skipping"
        continue
      fi
    fi
    git -C "$UR_CLONE" checkout -q -- "$f"
    # Count literals, not lines: two on one line would pass a line count and leave one unpatched.
    n=$(grep -o "$CANONICAL_PERMIT2" "$UR_CLONE/$f" | wc -l | tr -d ' ')
    [ "$n" = "1" ] || { echo "expected exactly one permit2 literal in $f, found $n"; exit 1; }
    # solc rejects non-EIP-55 address literals, so $core must stay checksummed.
    perl -pi -e "s/\Q$CANONICAL_PERMIT2\E/$core/g" "$UR_CLONE/$f"

    # shellcheck disable=SC2086
    (cd "$UR_CLONE" && forge script "$f:Deploy$name" --rpc-url "$rpc" $wallet --broadcast) \
      > "$ROOT/deployments/router-$name.log"
    addr=$(awk '/Universal Router Deployed:/ { print $NF; exit }' "$ROOT/deployments/router-$name.log")
    [ -n "${addr:-}" ] || { echo "could not parse the router address for $name"; exit 1; }
    printf '{"chain":"%s","chainId":%s,"universalRouter":"%s","crossPermit":"%s","urCommit":"%s"}\n' \
      "$name" "$id" "$addr" "$core" "$UR_COMMIT" > "$ROOT/deployments/router-$name.json"
    echo "  $name: router at $addr"
    git -C "$UR_CLONE" checkout -q -- "$f"
  done < <(chains)

  echo
  echo "  PERMIT2 is an internal immutable with no getter: it cannot be read back on-chain."
  echo "  Confirm $core in each router's constructor args on the explorer."
}

case "${1:-all}" in
  core)   preflight; deploy_core ;;
  router) deploy_router ;;
  all)    preflight; deploy_core; deploy_router ;;
  *)      echo "usage: $0 [core|router|all]" >&2; exit 1 ;;
esac
