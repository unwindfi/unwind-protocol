#!/usr/bin/env bash
# Publishes origin/main of the private repo to the public unwindfi/unwind-protocol
# as one new commit on top of its main, so the public repo never carries this
# repo's history, PRs or branches. Paths in EXCLUDE are left out (files with no
# license to redistribute, and anything kept private).
#
#   deploy/publish-public.sh "Commit message for the public repo"
set -euo pipefail
PUBLIC=https://github.com/unwindfi/unwind-protocol.git
EXCLUDE=(.claude/skills/emil-design-eng .claude/skills/apple-design)
MSG=${1:?usage: deploy/publish-public.sh "message"}
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
git fetch -q origin main
git fetch -q "$PUBLIC" main
PARENT=$(git rev-parse FETCH_HEAD)
TMP=$(mktemp -d); trap 'git worktree remove --force "$TMP" 2>/dev/null || true' EXIT
git worktree add -q --detach "$TMP" origin/main
( cd "$TMP"
  git rm -rq --ignore-unmatch "${EXCLUDE[@]}"
  # The skills README lists only what ships.
  if [ -f .claude/skills/README.md ]; then
    grep -v -E '^\| (emil-design-eng|apple-design) ' .claude/skills/README.md > .claude/skills/README.tmp
    sed 's/the better-\* skills, emil-design-eng and apple-design/the better-* skills/' .claude/skills/README.tmp > .claude/skills/README.md
    rm .claude/skills/README.tmp
  fi
  git add -A
  TREE=$(git write-tree)
  if [ "$TREE" = "$(git rev-parse "$PARENT^{tree}")" ]; then echo "public repo already matches origin/main"; exit 0; fi
  C=$(git commit-tree "$TREE" -p "$PARENT" -m "$MSG")
  git push -q "$PUBLIC" "$C:refs/heads/main"
  echo "published $(git rev-parse --short "$C") to unwindfi/unwind-protocol"
)
