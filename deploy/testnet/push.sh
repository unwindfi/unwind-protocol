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
# The IDL is build output, so it can be older than the code being shipped. A
# stale one makes the server build instructions with the wrong accounts (an
# Oct 5 IDL shipped on Oct 7 failed every maker quote with "Program ID was
# not as expected"). Every instruction in origin/main's program must be in it.
git show origin/main:programs/unwind/src/lib.rs | python3 -c '
import json, re, sys
want = set(re.findall(r"^    pub fn (\w+)\s*\(", sys.stdin.read(), re.M))
have = {i["name"] for i in json.load(open("target/idl/unwind.json"))["instructions"]}
missing = sorted(want - have)
if missing:
    sys.exit("target/idl/unwind.json is older than origin/main (missing: %s): run anchor build first" % ", ".join(missing))
'
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
# claims, the devnet mirrors and the vault tape. node_modules is reused unless
# the lock changed.
for f in .devnet-state.json .devnet-faucet.json .devnet-copies.json .quote-cache.json .cache .npm; do
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
# A failed tree from an earlier deploy would take this one inside it and
# stop the rollback half way, so it goes first.
rm -rf "$APP.failed"
mv "$APP" "$APP.failed"
mv "$APP.prev" "$APP"
systemctl restart unwind-testnet
exit 1
REMOTE
