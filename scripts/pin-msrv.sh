#!/bin/bash
# The Solana SBF toolchain ships Cargo 1.84, which cannot parse manifests that
# require edition 2024. Newer releases of several transitive dependencies do.
# This walks the build failures and pins each offender down to its newest
# release that Cargo 1.84 can still read.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

pick_version() {
  # Highest version of $1 below $2 whose declared rust-version is < 1.85.
  local name="$1" below="$2"
  local prefix
  case ${#name} in
    1) prefix="1/$name" ;;
    2) prefix="2/$name" ;;
    3) prefix="3/${name:0:1}/$name" ;;
    *) prefix="${name:0:2}/${name:2:2}/$name" ;;
  esac
  curl -s -A "claude-code" "https://index.crates.io/$prefix" | python3 -c "
import json,sys
from functools import cmp_to_key
below='''$below'''
def parse(v): return [int(x) for x in v.split('+')[0].split('-')[0].split('.')]
best=None
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    d=json.loads(line)
    if d.get('yanked'): continue
    v=d['vers']
    if '-' in v: continue
    rv=d.get('rust_version') or '0'
    try:
        rvp=[int(x) for x in rv.split('.')[:2]]
    except ValueError:
        continue
    if rvp >= [1,85]: continue
    try:
        if parse(v) >= parse(below): continue
    except ValueError:
        continue
    if best is None or parse(v) > parse(best): best=v
print(best or '')
"
}

for i in $(seq 1 25); do
  out=$(anchor build 2>&1)
  name=""; ver=""
  if echo "$out" | grep -q "feature \`edition2024\` is required"; then
    # Cargo 1.84 cannot even parse the manifest.
    pkg=$(echo "$out" | grep -o "registry/src/[^/]*/[a-zA-Z0-9_.-]*/Cargo.toml" | head -1 | awk -F/ '{print $(NF-1)}')
    name="${pkg%-*}"; ver="${pkg##*-}"
  elif echo "$out" | grep -q "is not supported by the following package"; then
    # Manifest parses, but declares an MSRV above the toolchain's.
    spec=$(echo "$out" | grep -oE "^  [a-zA-Z0-9_-]+@[0-9][0-9A-Za-z.+-]* requires rustc" | head -1 | awk '{print $1}')
    name="${spec%@*}"; ver="${spec#*@}"
  else
    echo "$out" | grep -v "unexpected \`cfg\`" | tail -20
    exit 0
  fi
  [ -z "$name" ] && { echo "$out" | tail -20; exit 1; }
  target=$(pick_version "$name" "$ver")
  if [ -z "$target" ]; then
    echo "!! no pre-edition2024 release found for $name (blocking at $ver)"
    exit 1
  fi
  echo ">> pinning $name $ver -> $target"
  cargo update -p "$name@$ver" --precise "$target" 2>&1 | grep -E "Downgrading|error" | head -3
done
echo "!! gave up after 25 pins"
exit 1
