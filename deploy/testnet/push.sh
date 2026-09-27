#!/usr/bin/env bash
# Ships origin/main to the testnet server and restarts it.
#
#   deploy/testnet/push.sh [user@host]
#
# The box cannot pull from GitHub, so the code goes over SSH: the committed
# tree of origin/main (never the working tree, so an uncommitted edit on this
# machine cannot ship), plus the program IDLs, which are build output and not
# in git. Keys and the state file on the box are left alone.
#
# It restarts only after the install succeeds, and puts the previous tree back
# if the server does not come up answering /api/markets.
set -euo pipefail

HOST=${1:-root@187.127.105.40}
APP=/opt/unwind
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

git fetch --quiet origin main
REV=$(git rev-parse --short origin/main)
for f in target/idl/unwind.json target/idl/mock_pyth.json; do
  [ -f "$f" ] || { echo "missing $f: run anchor build first" >&2; exit 1; }
done
echo "shipping $REV to $HOST"

# Staged beside the live tree, then swapped in, so a failed copy or install
# never leaves the running service with half a tree.
ssh "$HOST" "rm -rf $APP.next && mkdir -p $APP.next"
git archive origin/main | ssh "$HOST" "tar -x -C $APP.next"
tar -cf - target/idl/unwind.json target/idl/mock_pyth.json | ssh "$HOST" "tar -x -C $APP.next"

ssh "$HOST" bash -s -- "$APP" "$REV" <<'REMOTE'
set -euo pipefail
APP=$1; REV=$2
# Files the box owns, not the repo: the state (with its keys), the faucet's
# claims and the vault tape. node_modules is reused unless the lock changed.
for f in .devnet-state.json .devnet-faucet.json .quote-cache.json .cache .npm; do
  if [ -e "$APP/$f" ]; then cp -a "$APP/$f" "$APP.next/"; fi
done
# Hard links, not a move: the running server still has this tree open.
if cmp -s "$APP/package-lock.json" "$APP.next/package-lock.json" && [ -d "$APP/node_modules" ]; then
  cp -al "$APP/node_modules" "$APP.next/node_modules"
fi
chown -R unwind:unwind "$APP.next"
if [ ! -d "$APP.next/node_modules" ]; then
  (cd "$APP.next" && sudo -u unwind -H npm install --no-audit --no-fund --loglevel=error)
fi

rm -rf "$APP.prev"
mv "$APP" "$APP.prev"
mv "$APP.next" "$APP"
systemctl restart unwind-testnet

# The server waits for its first prices before it listens.
for _ in $(seq 1 45); do
  if curl -fs -o /dev/null -m 5 localhost:3000/api/markets; then
    echo "$REV is up"
    exit 0
  fi
  sleep 2
done

echo "$REV did not come up; restoring the previous tree" >&2
journalctl -u unwind-testnet --no-pager -n 20 -o cat >&2
mv "$APP" "$APP.failed"
mv "$APP.prev" "$APP"
systemctl restart unwind-testnet
exit 1
REMOTE
