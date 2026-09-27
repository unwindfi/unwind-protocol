#!/bin/bash
# Boots a persistent local validator with the perps program, the mock Pyth
# receiver, and the test fixtures preloaded. `anchor test` starts its own
# throwaway validator; this one sticks around so the dashboard has something to
# talk to.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

PROGRAM_ID="E8pRnTEfPFCcCPw9SQyrygMpLKRavo9oBYrf8qWQufmw"
# The real Pyth Solana Receiver's address. `mock_pyth` is deployed here so the
# price accounts it writes are owned by the pubkey `oracle.rs` insists on, and
# so the server can post a live price every tick instead of walking a ladder of
# frozen fixtures. Localnet only.
MOCK_PYTH_ID="J1FKStdEnsAK69gV4G5nVTm6eZTquo5kwQdLCHctE2k4"

# Fixed-price fixtures, for the integration tests.
ACCOUNT_ARGS=()
while read -r pubkey file; do
  ACCOUNT_ARGS+=(--account "$pubkey" "$file")
done < <(python3 -c "
import json
m = json.load(open('tests/fixtures/manifest.json'))
for n, p in m['accounts'].items():
    print(p, f'tests/fixtures/{n}.json')
")

# A real Raydium concentrated pool, cloned from mainnet, so a market priced off
# an AMM can be listed and observed here. Only the account is needed -- the
# reader checks its owner and discriminator and parses the bytes, and never
# calls the program -- so this is a fixture rather than a deployment. Its price
# is frozen at whatever mainnet said when it was dumped, which is fine: an
# observation of a constant is still an observation.
ACCOUNT_ARGS+=(--account 3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv \
  tests/fixtures/raydium-sol-usdc.json)
# Its history ring, dumped at the same moment, so a listing on it can open
# from the pool's own fifteen-minute average instead of waiting to watch.
ACCOUNT_ARGS+=(--account 3Y695CuQ8AP4anbwAqiEBeQF9KxqHFr8piEwvw3UePnQ \
  tests/fixtures/raydium-sol-usdc-observation.json)

# Port 8000 (the default gossip port) is commonly taken by another dev server,
# and the validator panics rather than falling back, so pin the ports here.
exec solana-test-validator \
  --reset \
  --rpc-port 8899 \
  --gossip-port 8100 \
  --dynamic-port-range 8110-8140 \
  \
  --ledger .localnet-ledger \
  --bpf-program "$PROGRAM_ID" target/deploy/unwind.so \
  --bpf-program "$MOCK_PYTH_ID" target/deploy/mock_pyth.so \
  "${ACCOUNT_ARGS[@]}"
