#!/usr/bin/env bash
# world-loopback.sh — SAFE end-to-end test of scripts/world.sh on ONE machine.
#
# Simulates "main PC" and "laptop" as two throwaway scratch data dirs and uses
# localhost as the peer, so the REAL ssh + rsync + lease transaction run — but
# against junk data under a mktemp dir. Your real FOUNDRY_DATA_PATH is never
# read, written, or referenced. Nothing here can touch a live world.
#
# Requires: rsync, and key-based `ssh localhost` (BatchMode). If ssh-to-self is
# not set up, this prints how to enable it and exits without doing anything.
#
# Usage:  bash scripts/tests/world-loopback.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
WORLD="$REPO/scripts/world.sh"

fail() { echo "LOOPBACK FAIL: $*" >&2; exit 1; }

# ── Preflight — bail loudly rather than half-run ─────────────────────────────
command -v rsync >/dev/null 2>&1 || fail "rsync not installed."
[[ -f "$WORLD" ]] || fail "scripts/world.sh not found."
if ! ssh -o BatchMode=yes -o ConnectTimeout=5 localhost true 2>/dev/null; then
  cat >&2 <<'EOF'
LOOPBACK SKIPPED: key-based `ssh localhost` does not work yet.
Enable it once (safe, local only):
    ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ''   # if you have no key
    ssh-copy-id localhost                              # authorize it to yourself
    ssh -o BatchMode=yes localhost true && echo OK     # verify
Then re-run this script.
EOF
  exit 2
fi

# ── Scratch "two machines" — nowhere near real data ──────────────────────────
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
MAIN="$ROOT/mainpc"          # stands in for the main PC's FOUNDRY_DATA_PATH
LAP="$ROOT/laptop"           # stands in for the laptop's FOUNDRY_DATA_PATH
VER="99.999"                 # fake version, identical both sides
HOST="$(hostname)"

seed() { # dir holder
  local d="$1" holder="$2"
  mkdir -p "$d/Data/worlds/demo" "$d/Data/modules/demo-mod" \
           "$d/Data/Backups" "$d/Data/container_cache" "$d/Data/Logs"
  echo "$VER" > "$d/Data/.foundry-world-version"
  echo "log"  > "$d/Data/Logs/x.log"
  [[ -n "$holder" ]] && printf '{"holder":"%s","since":"2026-01-01T00:00:00Z"}\n' "$holder" > "$d/.foundry-lease"
}
seed "$MAIN" "MAINPC"        # main holds the world
seed "$LAP"  ""              # laptop frozen (no lease yet)
echo "ORIGINAL-ON-MAIN" > "$MAIN/Data/worlds/demo/data.db"
# a local-only backup on the laptop that MUST survive handoffs (excluded dir)
echo "LAPTOP-LOCAL-BACKUP" > "$LAP/Data/Backups/keepme.bak"

# run world.sh as a given machine against a given data dir
as() { # self datadir -- args...
  local self="$1" data="$2"; shift 2; shift  # drop --
  ( cd "$REPO" && env WORLD_SELF="$self" FOUNDRY_DATA_PATH="$data" \
      WORLD_PEER_SSH=localhost WORLD_PEER_DATA_PATH="$MAIN" \
      FOUNDRY_VERSION="$VER" bash scripts/world.sh "$@" )
}
as_peer_main() { as "$@"; }  # readability

echo "== 1. gate: laptop must refuse to start (main holds the world) =="
if as LAPTOP "$LAP" -- up >/dev/null 2>&1; then
  fail "laptop 'up' should have refused — it did not."
fi
echo "   ok: laptop refused to start Foundry."

echo "== 2. checkout: pull world main -> laptop, take the lease =="
as LAPTOP "$LAP" -- checkout || fail "checkout failed."
grep -q "ORIGINAL-ON-MAIN" "$LAP/Data/worlds/demo/data.db" || fail "world did not arrive on laptop."
grep -q "LAPTOP-LOCAL-BACKUP" "$LAP/Data/Backups/keepme.bak" || fail "laptop's excluded Backups/ was clobbered."
grep -q '"holder":"LAPTOP"' "$LAP/.foundry-lease" || fail "laptop did not take the lease."
grep -q '"holder":"LAPTOP"' "$MAIN/.foundry-lease" || fail "main was not frozen."
echo "   ok: world on laptop, local Backups preserved, lease = LAPTOP both sides."

echo "== 3. edit on the laptop =="
echo "EDITED-ON-LAPTOP" > "$LAP/Data/worlds/demo/data.db"

echo "== 4. checkin: push laptop -> main, release the lease =="
as LAPTOP "$LAP" -- checkin || fail "checkin failed."
grep -q "EDITED-ON-LAPTOP" "$MAIN/Data/worlds/demo/data.db" || fail "laptop edit did not reach main."
grep -q "\"holder\":\"$HOST\"" "$MAIN/.foundry-lease" || fail "lease did not return to the main-PC host."
echo "   ok: laptop edit landed on main, lease returned to $HOST."

echo "== 5. snapshots exist on both sides (rollback points) =="
ls -d "$MAIN"/Data.snap-* >/dev/null 2>&1 || fail "no snapshot on main."
ls -d "$LAP"/Data.snap-*  >/dev/null 2>&1 || fail "no snapshot on laptop."
echo "   ok: Data.snap-* present on both."

echo
echo "LOOPBACK PASS — full checkout/checkin round trip over real ssh+rsync,"
echo "scratch dirs only. Your real FOUNDRY_DATA_PATH was never touched."
