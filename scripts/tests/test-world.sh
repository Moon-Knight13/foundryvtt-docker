#!/usr/bin/env bash
# Deterministic tests for scripts/world.sh — lease logic, the up gate, and the
# handoff transactions — using PATH shims for ssh/rsync/docker/curl and temp
# data dirs. No network, no real Foundry. Usage: bash scripts/tests/test-world.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$(dirname "$HERE")"
WORLD="$SCRIPTS/world.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok()  { echo " ok  : $1"; pass=$((pass+1)); }
bad() { echo " FAIL: $1 -- $2"; fail=$((fail+1)); }

# ── Shims: ssh/rsync/docker/curl record calls and honor MOCK_* knobs ──────────
SHIMS="$TMP/shims"; mkdir -p "$SHIMS"

cat > "$SHIMS/curl" <<'EOF'
#!/usr/bin/env bash
# Foundry-running probe. MOCK_LOCAL_UP / MOCK_REMOTE_UP select the answer.
# world.sh calls curl locally and `ssh peer curl` remotely; the ssh shim sets
# MOCK_REMOTE=1 so this shim knows which knob to read.
if [[ "${MOCK_REMOTE:-0}" == "1" ]]; then
  [[ "${MOCK_REMOTE_UP:-false}" == "true" ]] && exit 0 || exit 7
else
  [[ "${MOCK_LOCAL_UP:-false}" == "true" ]] && exit 0 || exit 7
fi
EOF

cat > "$SHIMS/ssh" <<'EOF'
#!/usr/bin/env bash
# Reachability + remote command exec against a fake peer data dir ($MOCK_PEER_DATA).
# Unreachable when MOCK_PEER_REACHABLE != true.
[[ "${MOCK_PEER_REACHABLE:-true}" == "true" ]] || exit 255
# Drop ssh options (-o KEY[=VAL]) and the user@host target; the remainder is the
# remote command. Run it locally with MOCK_REMOTE=1 so nested curl/rsync shims
# resolve to the "remote" side and paths hit the fake peer.
while [[ "${1:-}" == -* ]]; do
  if [[ "$1" == "-o" ]]; then shift 2; else shift; fi
done
shift  # drop user@host
MOCK_REMOTE=1 bash -c "$*"
EOF

cat > "$SHIMS/docker" <<'EOF'
#!/usr/bin/env bash
# Only `docker compose ...` is used. Record the call; `up -d` just succeeds.
echo "docker $*" >> "${MOCK_DOCKER_LOG:-/dev/null}"
exit 0
EOF

# rsync: use the real binary when present (full fidelity, as in the interactive
# devcontainer). When absent (e.g. a minimal background-job container), install a
# cp/diff-based emulation shim covering exactly the flags world.sh uses:
#   -a --delete [--link-dest=X] [--exclude P ...] [-e ssh] SRC/ DST/   (mirror)
#   -rin --delete --checksum [--exclude P ...] [-e ssh] SRC/ DST/      (dry-run diff)
# It honors --exclude by preserving the receiver's excluded top-level entries
# (matching real rsync without --delete-excluded). host: prefixes are stripped
# because the ssh shim runs "remote" work locally against real temp dirs.
if command -v rsync >/dev/null 2>&1; then
  RSYNC_REAL=1
else
  RSYNC_REAL=0
  cat > "$SHIMS/rsync" <<'EOF'
#!/usr/bin/env bash
set -uo pipefail
dryrun=0; excludes=(); pos=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -e) shift 2; continue ;;               # -e ssh
    --exclude) excludes+=("${2%/}"); shift 2; continue ;;
    --exclude=*) excludes+=("${1#--exclude=}"); excludes[-1]="${excludes[-1]%/}"; shift; continue ;;
    --link-dest=*|--delete|--checksum) shift; continue ;;
    -*) [[ "$1" == *n* ]] && dryrun=1; shift; continue ;;   # -rin carries the dry-run 'n'
    *) pos+=("$1"); shift; continue ;;
  esac
done
src="${pos[0]}"; dst="${pos[1]}"
strip() { local p="$1"; if [[ "$p" == *:* && "$p" != /* ]]; then printf '%s' "${p#*:}"; else printf '%s' "$p"; fi; }
src="$(strip "$src")"; dst="$(strip "$dst")"
excluded() { local n="$1" e; for e in "${excludes[@]:-}"; do [[ "$n" == "$e" ]] && return 0; done; return 1; }

if [[ "$dryrun" == 1 ]]; then
  dex=(); for e in "${excludes[@]:-}"; do [[ -n "$e" ]] && dex+=(--exclude="$e"); done
  diff -rq "${dex[@]}" "$src" "$dst" 2>/dev/null || true
  exit 0
fi

mkdir -p "$dst"
# --delete: drop receiver entries not in source (excluded entries are protected).
while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  excluded "$name" && continue
  [[ -e "$src/$name" ]] || rm -rf "$dst/$name"
done < <(cd "$dst" 2>/dev/null && find . -mindepth 1 -maxdepth 1 -printf '%f\n')
# copy source entries (skip excluded so receiver keeps its own)
while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  excluded "$name" && continue
  rm -rf "$dst/$name"
  cp -a "$src/$name" "$dst/"
done < <(cd "$src" && find . -mindepth 1 -maxdepth 1 -printf '%f\n')
EOF
fi

chmod +x "$SHIMS"/*

# make_data DIR HOLDER VERSION — build a fake Foundry data dir with a world.
make_data() {
  local d="$1" holder="$2" ver="$3"
  mkdir -p "$d/Data/worlds/troubled-waters" "$d/Data/modules/foundry-mcp-bridge" \
           "$d/Data/Backups" "$d/Data/container_cache" "$d/Data/Logs"
  echo "world-state-$RANDOM" > "$d/Data/worlds/troubled-waters/data.db"
  echo "backup-junk"  > "$d/Data/Backups/old.bak"
  echo "cache-junk"   > "$d/Data/container_cache/foundry.zip"
  echo "log-junk"     > "$d/Data/Logs/debug.log"
  [[ -n "$ver" ]] && echo "$ver" > "$d/Data/.foundry-world-version"
  if [[ -n "$holder" ]]; then
    printf '{"holder":"%s","since":"2026-07-17T00:00:00Z"}\n' "$holder" > "$d/.foundry-lease"
  fi
}

# run_world SELFNAME DATADIR [ENV=VAL ...] -- <subcommand args>
run_world() {
  local self="$1" data="$2"; shift 2
  local -a envs=()
  while [[ "${1:-}" != "--" ]]; do envs+=("$1"); shift; done
  shift  # drop --
  ( cd "$SCRIPTS/.." || exit 99
    env PATH="$SHIMS:$PATH" WORLD_SELF="$self" FOUNDRY_DATA_PATH="$data" \
        MOCK_DOCKER_LOG="$TMP/docker.log" "${envs[@]}" \
        bash scripts/world.sh "$@"
  ) > "$TMP/out" 2>&1
  echo $?
}

# ── Case 1.1: status reports the holder ──────────────────────────────────────
D="$TMP/main"; make_data "$D" "MAIN-PC" "14.363"
rc=$(run_world "MAIN-PC" "$D" -- status)
if [[ "$rc" == "0" ]] && grep -q "MAIN-PC" "$TMP/out" && grep -qi "this machine" "$TMP/out"; then
  ok "status: holder shown, recognizes self"
else bad "status self" "rc=$rc; $(cat "$TMP/out")"; fi

# ── Case 1.2: init writes a lease naming this machine ────────────────────────
D="$TMP/fresh"; mkdir -p "$D/Data"
rc=$(run_world "MAIN-PC" "$D" -- init)
if [[ "$rc" == "0" ]] && grep -q '"holder":"MAIN-PC"' "$D/.foundry-lease"; then
  ok "init: default holder = self"
else bad "init" "rc=$rc; lease=$(cat "$D/.foundry-lease" 2>&1)"; fi

# ── Case 2.1: local Foundry-running probe honors MOCK_LOCAL_UP ────────────────
D="$TMP/probe"; make_data "$D" "MAIN-PC" "14.363"
rc=$(run_world "MAIN-PC" "$D" MOCK_LOCAL_UP=true -- status)
grep -qi "running" "$TMP/out" && ok "status: reports Foundry running when up" \
  || bad "local up probe" "$(cat "$TMP/out")"

rc=$(run_world "MAIN-PC" "$D" MOCK_LOCAL_UP=false -- status)
grep -qi "stopped" "$TMP/out" && ok "status: reports stopped when down" \
  || bad "local down probe" "$(cat "$TMP/out")"

# ── Case 2.2: peer config falls back to BACKUP_REMOTE_* ──────────────────────
D="$TMP/peercfg"; make_data "$D" "LAPTOP" "14.363"
rc=$(run_world "MAIN-PC" "$D" BACKUP_REMOTE_HOST=user@laptop MOCK_PEER_REACHABLE=true \
      MOCK_PEER_DATA="$D" -- status --peer)
if grep -q "user@laptop" "$TMP/out" && grep -qi "reachable" "$TMP/out"; then
  ok "status --peer: resolves peer from BACKUP_REMOTE_HOST, reachable"
else bad "peer cfg" "rc=$rc; $(cat "$TMP/out")"; fi

# ── Case 3.1: up refuses on the non-holder, prints what to do ─────────────────
: > "$TMP/docker.log"
D="$TMP/gate"; make_data "$D" "MAIN-PC" "14.363"
rc=$(run_world "LAPTOP" "$D" -- up)
if [[ "$rc" != "0" ]] && grep -q "MAIN-PC" "$TMP/out" \
   && grep -q "checkout" "$TMP/out" && ! grep -q "docker compose up" "$TMP/docker.log"; then
  ok "up: non-holder refused, no compose, tells user to checkout"
else bad "up refuse" "rc=$rc; out=$(cat "$TMP/out"); log=$(cat "$TMP/docker.log" 2>/dev/null)"; fi

# ── Case 3.2: up starts compose on the holder and stamps the version ─────────
: > "$TMP/docker.log"
D="$TMP/gate2"; make_data "$D" "MAIN-PC" ""
rc=$(run_world "MAIN-PC" "$D" FOUNDRY_VERSION=14.363 -- up)
if [[ "$rc" == "0" ]] && grep -q "compose up -d" "$TMP/docker.log" \
   && [[ "$(cat "$D/Data/.foundry-world-version")" == "14.363" ]]; then
  ok "up: holder starts compose and stamps version"
else bad "up start" "rc=$rc; log=$(cat "$TMP/docker.log"); stamp=$(cat "$D/Data/.foundry-world-version" 2>&1)"; fi

# ── Case 4.1: version_lt ordering ────────────────────────────────────────────
( cd "$SCRIPTS/.." && WORLD_SELF=x bash -c '
    source scripts/world.sh
    version_lt 14.362 14.363 && echo LT
    version_lt 14.363 14.363 || echo NOTLT_EQ
    version_lt 14.400 14.363 || echo NOTLT_GT
  ' ) > "$TMP/out" 2>&1
if grep -q LT "$TMP/out" && grep -q NOTLT_EQ "$TMP/out" && grep -q NOTLT_GT "$TMP/out"; then
  ok "version_lt: strict-older true; equal/newer false"
else bad "version_lt" "$(cat "$TMP/out")"; fi

# ── Case 4.2: snapshot_dir hardlinks Data and prunes to 3 ────────────────────
D="$TMP/snap"; make_data "$D" "MAIN-PC" "14.363"
( cd "$SCRIPTS/.." && WORLD_SELF=x FOUNDRY_DATA_PATH="$D" PATH="$SHIMS:$PATH" bash -c '
    source scripts/world.sh
    for i in 1 2 3 4; do snapshot_dir "'"$D"'" >/dev/null; done
  ' )
count=$(find "$D" -maxdepth 1 -name "Data.snap-*" -type d | wc -l)
snap=$(find "$D" -maxdepth 1 -name "Data.snap-*" -type d | head -n1)
if [[ "$count" -le 3 ]] && [[ -f "$snap/worlds/troubled-waters/data.db" ]]; then
  ok "snapshot_dir: copies world, prunes to <=3"
else bad "snapshot" "count=$count snap=$snap"; fi

# helper: build a local+peer pair; peer holds the world at version $3
make_pair() { # localdir peerdir version peerholder
  make_data "$1" ""       "$3"          # local: no lease yet
  make_data "$2" "$4"     "$3"          # peer: holder=$4
}

# ── Case 5.1: checkout refuses when peer unreachable ─────────────────────────
L="$TMP/l1"; P="$TMP/p1"; make_pair "$L" "$P" "14.363" "MAIN-PC"
rc=$(run_world "LAPTOP" "$L" WORLD_PEER_SSH=u@main WORLD_PEER_DATA_PATH="$P" \
      MOCK_PEER_REACHABLE=false -- checkout)
[[ "$rc" != "0" ]] && grep -qi "unreachable\|on the LAN" "$TMP/out" \
  && ok "checkout: refuses when peer unreachable" \
  || bad "checkout unreachable" "rc=$rc; $(cat "$TMP/out")"

# ── Case 5.2: checkout refuses when source (peer) Foundry is running ─────────
L="$TMP/l2"; P="$TMP/p2"; make_pair "$L" "$P" "14.363" "MAIN-PC"
rc=$(run_world "LAPTOP" "$L" WORLD_PEER_SSH=u@main WORLD_PEER_DATA_PATH="$P" \
      MOCK_PEER_REACHABLE=true MOCK_REMOTE_UP=true -- checkout)
[[ "$rc" != "0" ]] && grep -qi "stop foundry" "$TMP/out" \
  && ok "checkout: refuses when source Foundry running" \
  || bad "checkout source-running" "rc=$rc; $(cat "$TMP/out")"

# ── Case 5.3: checkout refuses on version drift (receiver older) ─────────────
L="$TMP/l3"; P="$TMP/p3"; make_pair "$L" "$P" "14.400" "MAIN-PC"   # world stamped 14.400
rc=$(run_world "LAPTOP" "$L" WORLD_PEER_SSH=u@main WORLD_PEER_DATA_PATH="$P" \
      FOUNDRY_VERSION=14.363 MOCK_PEER_REACHABLE=true MOCK_REMOTE_UP=false -- checkout)
[[ "$rc" != "0" ]] && grep -qi "version" "$TMP/out" \
  && ok "checkout: refuses when receiver Foundry older than world" \
  || bad "checkout version drift" "rc=$rc; $(cat "$TMP/out")"

# ── Case 5.4: full checkout round trip — world moves, excluded dirs preserved, lease flips ─
L="$TMP/l4"; P="$TMP/p4"; make_pair "$L" "$P" "14.363" "MAIN-PC"
echo "PEER-ONLY-WORLD" > "$P/Data/worlds/troubled-waters/data.db"
# distinct local markers in excluded dirs — must survive (proves exclusion: the
# peer's copies must NOT overwrite them, and --delete must NOT remove them)
echo "LOCAL-BACKUP" > "$L/Data/Backups/old.bak"
echo "LOCAL-CACHE"  > "$L/Data/container_cache/foundry.zip"
rc=$(run_world "LAPTOP" "$L" WORLD_PEER_SSH=u@main WORLD_PEER_DATA_PATH="$P" \
      FOUNDRY_VERSION=14.363 MOCK_PEER_REACHABLE=true MOCK_REMOTE_UP=false -- checkout)
if [[ "$rc" == "0" ]] \
   && grep -q "PEER-ONLY-WORLD" "$L/Data/worlds/troubled-waters/data.db" \
   && grep -q "LOCAL-BACKUP" "$L/Data/Backups/old.bak" \
   && grep -q "LOCAL-CACHE" "$L/Data/container_cache/foundry.zip" \
   && grep -q '"holder":"LAPTOP"' "$L/.foundry-lease" \
   && grep -q '"holder":"LAPTOP"' "$P/.foundry-lease"; then
  ok "checkout: world moved, Backups/cache preserved (excluded), lease flipped to LAPTOP both sides"
else bad "checkout round trip" "rc=$rc; local_lease=$(cat "$L/.foundry-lease" 2>&1); peer_lease=$(cat "$P/.foundry-lease" 2>&1); out=$(cat "$TMP/out")"; fi

# ── Case 5.5: checkin pushes laptop -> peer(main), lease returns to peer ──────
L="$TMP/l5"; P="$TMP/p5"
make_data "$L" "LAPTOP" "14.363"; make_data "$P" "LAPTOP" "14.363"
echo "LAPTOP-EDITS" > "$L/Data/worlds/troubled-waters/data.db"
rc=$(run_world "LAPTOP" "$L" WORLD_PEER_SSH=u@main WORLD_PEER_DATA_PATH="$P" \
      FOUNDRY_VERSION=14.363 MOCK_PEER_REACHABLE=true MOCK_LOCAL_UP=false MOCK_REMOTE_UP=false -- checkin)
if [[ "$rc" == "0" ]] \
   && grep -q "LAPTOP-EDITS" "$P/Data/worlds/troubled-waters/data.db" \
   && grep -q '"holder":"'"$(hostname)"'"' "$P/.foundry-lease"; then
  ok "checkin: laptop edits pushed to peer, lease returned to peer host"
else bad "checkin" "rc=$rc; peer_db=$(cat "$P/Data/worlds/troubled-waters/data.db" 2>&1); peer_lease=$(cat "$P/.foundry-lease" 2>&1); out=$(cat "$TMP/out")"; fi

# ── Case 6.1: transfer failure leaves lease with the source, no partial win ──
L="$TMP/l6"; P="$TMP/p6"; make_data "$L" "" "14.363"; make_data "$P" "MAIN-PC" "14.363"
rc=$(run_world "LAPTOP" "$L" WORLD_PEER_SSH=u@main WORLD_PEER_DATA_PATH="$P" \
      FOUNDRY_VERSION=14.363 MOCK_PEER_REACHABLE=true MOCK_REMOTE_UP=false MOCK_RSYNC_FAIL=1 \
      -- checkout)
# Lease must NOT have flipped to LAPTOP on either side.
if [[ "$rc" != "0" ]] \
   && ! grep -q '"holder":"LAPTOP"' "$L/.foundry-lease" 2>/dev/null \
   && grep -q '"holder":"MAIN-PC"' "$P/.foundry-lease"; then
  ok "crash-safety: transfer failure keeps lease with source (MAIN-PC)"
else bad "crash safety" "rc=$rc; local=$(cat "$L/.foundry-lease" 2>&1); peer=$(cat "$P/.foundry-lease" 2>&1)"; fi

echo; echo "world.sh tests: $pass passed, $fail failed"
echo "(rsync: $([[ "$RSYNC_REAL" == 1 ]] && echo real || echo emulated-shim))"
[[ "$fail" -eq 0 ]]
