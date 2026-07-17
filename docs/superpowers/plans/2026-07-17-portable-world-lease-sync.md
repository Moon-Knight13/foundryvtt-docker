# Portable World: Lease + Handoff Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `scripts/world.sh` so one FoundryVTT world can travel between a main PC and a laptop over the LAN with no data loss, enforced by a hard lease (one holder at a time) plus a snapshot-guarded, version-checked handoff.

**Architecture:** Both machines run identical code. A lease file `<data>/.foundry-lease` names the single machine allowed to start Foundry; `world.sh up` refuses on the non-holder. Handoff (`checkout`/`checkin`/`reclaim`) stops the source, snapshots both sides (cheap hardlinked snapshots), mirrors `Data/` with `rsync --delete` over SSH, verifies equality, then flips the lease **last** so any crash leaves the old holder authoritative. A version stamp travelling inside `Data/` blocks handoff to an older Foundry binary (the one true corruption vector).

**Tech Stack:** Bash (`set -euo pipefail`, sourceable for unit tests), `rsync` over SSH (key auth), `docker compose`, `scripts/lib/env-file.sh` for `.env` reads. Tests are pure bash with PATH shims for `ssh`/`rsync`/`docker`/`curl` (same harness style as `scripts/tests/test-day0.sh`) — no network, no real Foundry.

## Global Constraints

- **Shell:** `bash`, `set -euo pipefail`, `IFS=$'\n\t'`. Script must be **sourceable** — real entrypoint guarded by `if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then main "$@"; fi` so tests can source and call functions directly.
- **`.env` reads:** only via `get_env_value` from `scripts/lib/env-file.sh` (reads one variable, never dumps the file — required by CLAUDE.md security rules). Never read/print `.env`, `license.json`, `cookiejar.json` contents beyond the specific vars named here.
- **Data path:** `FOUNDRY_DATA_PATH` from `.env`, default `~/.local/share/FoundryVTT`; expand a leading `~` with `${VAR/#\~/$HOME}` (values in `.env` are not shell-expanded).
- **The world data lives under `<FOUNDRY_DATA_PATH>/Data/`.** That `Data/` subdir is what travels.
- **Transfer excludes (never travel):** `Backups/`, `container_cache/`, `Logs/` (paths relative to `Data/`).
- **Transfer semantics:** mirror not union — `rsync --archive --delete`.
- **Lease flips LAST.** Data is copied and verified before ownership moves. The machine *gaining* access has its local lease written last, so a crash mid-handoff leaves it frozen (safe) — never a lost world.
- **Snapshot both sides before any overwrite.** Snapshots are hardlinked (`rsync --link-dest`) so they cost almost no disk.
- **Version guard:** refuse handoff when the receiving machine's `FOUNDRY_VERSION` is older than the version stamp recorded inside the world being received.
- **Default lease holder:** the main PC.
- **Test runner:** `bash scripts/tests/test-world.sh`, exit 0 = all pass, 1 = any fail; pass/fail counters printed, mirroring `scripts/tests/test-day0.sh`.
- **Commits:** if the offline sandbox blocks pre-commit hooks on network install, commit with `--no-verify` and say so; otherwise commit normally.

## File Structure

- **Create `scripts/world.sh`** — the single front door. Subcommands: `init`, `status`, `up`, `checkout`, `checkin`, `reclaim`. Sourceable; all logic in small functions.
- **Create `scripts/tests/test-world.sh`** — pure-bash tests with PATH shims for `ssh`/`rsync`/`docker`/`curl` and temp fake data dirs.
- **Modify `.env.example`** — add `WORLD_PEER_SSH`, `WORLD_PEER_DATA_PATH` (the "other machine"), documented; note fallback to existing `BACKUP_REMOTE_*`.
- **Create `docs/WORLD_SYNC.md`** — operator usage: setup, the three commands, the one-editor-at-a-time rule, recovery from snapshot.
- **Modify `CLAUDE.md`** — append a short "Portable world sync" pointer in the project appendix (append-only, per repo rule).

### Config vars (all from `.env`, read with `get_env_value`)

- `FOUNDRY_DATA_PATH` — existing; data dir root.
- `FOUNDRY_VERSION` — existing; this machine's Foundry build (the version guard's local side).
- `FOUNDRY_PORT` — existing; default `30000`; used to probe "is Foundry running".
- `WORLD_PEER_SSH` — **new**; `user@host` of the other machine (on the laptop this is the main PC; on the main PC this is the laptop). Falls back to `BACKUP_REMOTE_HOST` if unset.
- `WORLD_PEER_DATA_PATH` — **new**; `FOUNDRY_DATA_PATH` on the peer. Falls back to `BACKUP_REMOTE_PATH`, then `~/.local/share/FoundryVTT`.

### Key files created at runtime (not in git)

- `<data>/.foundry-lease` — JSON `{"holder":"<hostname>","since":"<ISO8601>"}`. Per machine.
- `<data>/.foundry-world-version` — plain text, the `FOUNDRY_VERSION` that last started Foundry against this `Data/`. Travels inside `Data/`.
- `<data>/Data.snap-<YYYYMMDD-HHMMSS>/` — hardlinked snapshots (kept: last 3).

### Deviations from the spec (intentional, noted for the reviewer)

1. **Lease schema drops `world_checksum`.** Post-transfer verification is done *live* with `rsync --checksum` dry-run (source vs target), which is strictly stronger than a stored hash and needs nothing persisted. Lease carries only `holder` + `since`.
2. **Version guard uses a stamp inside `Data/`**, not a peer `.env` read. The stamp records "what Foundry version last wrote this world" and travels with it, so the receiver compares its own `FOUNDRY_VERSION` to the incoming stamp — no dependency on the peer's repo path.
3. **New `WORLD_PEER_*` vars** instead of overloading `BACKUP_REMOTE_*` (which specifically means "one-way restore source"). `BACKUP_REMOTE_*` is honored as a fallback so existing setups keep working.

---

## Task 1: Script skeleton, helpers, `init`, `status`

**Files:**
- Create: `scripts/world.sh`
- Test: `scripts/tests/test-world.sh`

**Interfaces:**
- Consumes: `scripts/lib/env-file.sh` → `get_env_value VAR`.
- Produces:
  - `data_root()` → echoes expanded `FOUNDRY_DATA_PATH`.
  - `lease_file()` → echoes `<data_root>/.foundry-lease`.
  - `read_holder()` → echoes lease holder (empty string if no/invalid lease).
  - `write_lease HOLDER` → writes lease JSON `{holder,since}` to `lease_file`.
  - `i_am()` → echoes this machine's identity (`WORLD_SELF` override, else `hostname`).
  - `i_hold()` → returns 0 if `read_holder == i_am`, else 1.
  - `cmd_init [HOLDER]` → writes lease (default holder `i_am`).
  - `cmd_status` → prints holder, whether it's this machine, and Foundry-running state.
  - `main "$@"` → dispatches subcommands; runs only when executed, not sourced.

- [ ] **Step 1: Write the failing test harness + first cases**

Create `scripts/tests/test-world.sh`:

```bash
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
shift  # drop user@host (first arg)
# Remaining args are the remote command; run it locally with MOCK_REMOTE=1 so
# nested curl/rsync shims resolve to the "remote" side and paths hit the fake peer.
MOCK_REMOTE=1 bash -c "$*"
EOF

cat > "$SHIMS/docker" <<'EOF'
#!/usr/bin/env bash
# Only `docker compose ...` is used. Record the call; `up -d` just succeeds.
echo "docker $*" >> "${MOCK_DOCKER_LOG:-/dev/null}"
exit 0
EOF

# rsync shim: real rsync is fine for local temp dirs, but tests must run offline
# and deterministically. Use the real rsync when present (it is, in this repo's
# devcontainer) for actual file moves; fall back to a cp-based emulation only if
# absent. Detected once here.
if command -v rsync >/dev/null 2>&1; then RSYNC_REAL=1; else RSYNC_REAL=0; fi

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

echo; echo "world.sh tests: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bash scripts/tests/test-world.sh`
Expected: FAIL — `scripts/world.sh` does not exist yet (`bash: scripts/world.sh: No such file or directory`), both cases report FAIL.

- [ ] **Step 3: Write the skeleton `scripts/world.sh`**

```bash
#!/usr/bin/env bash
# world.sh — portable FoundryVTT world: hard lease + handoff sync between a main
# PC and a laptop over the LAN. Exactly one machine "holds" the world at a time;
# the non-holder refuses to start Foundry. Handoff snapshots both sides, mirrors
# Data/ with rsync --delete, verifies, then flips the lease last. See
# docs/WORLD_SYNC.md and docs/superpowers/specs/2026-07-17-portable-world-lease-sync-design.md
#
# Subcommands:
#   init [HOLDER]   Write the lease (default holder = this machine). Run on the main PC first.
#   status          Who holds the world, is it this machine, is Foundry running.
#   up              Start Foundry — only if this machine holds the lease. Never syncs.
#   checkout        (laptop, on LAN) Pull world from the peer, take the lease.
#   checkin         (laptop, on LAN) Push world to the peer, release the lease.
#   reclaim         (main PC) Pull world back from the laptop peer, take the lease.
set -euo pipefail
IFS=$'\n\t'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/lib/env-file.sh disable=SC1091
source "$REPO_ROOT/scripts/lib/env-file.sh"

die() { echo "world.sh: $*" >&2; exit 1; }

# ── Identity & paths ─────────────────────────────────────────────────────────
i_am() { echo "${WORLD_SELF:-$(hostname)}"; }

data_root() {
  local d; d="$(cd "$REPO_ROOT" && get_env_value FOUNDRY_DATA_PATH)"
  d="${d:-$HOME/.local/share/FoundryVTT}"
  echo "${d/#\~/$HOME}"
}

lease_file() { echo "$(data_root)/.foundry-lease"; }

read_holder() {
  local f; f="$(lease_file)"
  [[ -f "$f" ]] || { echo ""; return 0; }
  # holder value from {"holder":"X",...}; empty if unparseable.
  sed -n 's/.*"holder"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -n1
}

write_lease() {
  local holder="$1" f; f="$(lease_file)"
  mkdir -p "$(dirname "$f")"
  local now; now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"holder":"%s","since":"%s"}\n' "$holder" "$now" > "$f"
}

i_hold() { [[ "$(read_holder)" == "$(i_am)" ]]; }

# ── Subcommands (skeleton; filled in later tasks) ────────────────────────────
cmd_init() {
  local holder="${1:-$(i_am)}"
  write_lease "$holder"
  echo "Lease initialized: holder = $holder"
}

cmd_status() {
  local holder; holder="$(read_holder)"
  local self; self="$(i_am)"
  if [[ -z "$holder" ]]; then
    echo "World lease: (none). Run: ./scripts/world.sh init   (on the main PC)"
  else
    echo "World lease held by: $holder"
    if [[ "$holder" == "$self" ]]; then
      echo "  -> this machine ($self) holds the world."
    else
      echo "  -> this machine ($self) is frozen; $holder holds the world."
    fi
  fi
}

main() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    init)     cmd_init "$@" ;;
    status)   cmd_status "$@" ;;
    up)       cmd_up "$@" ;;
    checkout) cmd_checkout "$@" ;;
    checkin)  cmd_checkin "$@" ;;
    reclaim)  cmd_reclaim "$@" ;;
    ""|-h|--help)
      sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      ;;
    *) die "unknown subcommand: $sub (try --help)" ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
```

Note: `cmd_up`/`cmd_checkout`/`cmd_checkin`/`cmd_reclaim` are referenced by `main` but defined in later tasks. Add temporary stubs so the file parses and Task 1 tests run:

```bash
# Temporary stubs — replaced in Tasks 3–6.
cmd_up()       { die "not implemented yet"; }
cmd_checkout() { die "not implemented yet"; }
cmd_checkin()  { die "not implemented yet"; }
cmd_reclaim()  { die "not implemented yet"; }
```

Place the stubs **above** `main`.

- [ ] **Step 4: Run the tests, verify they pass**

Run: `bash scripts/tests/test-world.sh`
Expected: PASS — "world.sh tests: 2 passed, 0 failed".

- [ ] **Step 5: Commit**

```bash
chmod +x scripts/world.sh scripts/tests/test-world.sh
git add scripts/world.sh scripts/tests/test-world.sh
git commit -m "feat(world): lease skeleton with init/status subcommands"
```

---

## Task 2: Foundry-running probe + peer config resolution

**Files:**
- Modify: `scripts/world.sh`
- Test: `scripts/tests/test-world.sh`

**Interfaces:**
- Consumes: `get_env_value`, `i_am`, `data_root`.
- Produces:
  - `foundry_port()` → echoes `FOUNDRY_PORT` or `30000`.
  - `foundry_running_local()` → 0 if a Foundry answers on `localhost:<port>`, else 1 (probe: `curl -sf -o /dev/null http://localhost:<port>`).
  - `peer_ssh()` → echoes `WORLD_PEER_SSH` (fallback `BACKUP_REMOTE_HOST`); dies if empty.
  - `peer_data()` → echoes `WORLD_PEER_DATA_PATH` (fallback `BACKUP_REMOTE_PATH`, then `~/.local/share/FoundryVTT`), `~` expanded.
  - `peer_reachable()` → 0 if `ssh -o BatchMode=yes <peer> true` succeeds.
  - `foundry_running_remote()` → 0 if Foundry answers on the peer's port (via `ssh <peer> curl ...`).

- [ ] **Step 1: Write failing tests**

Append to `scripts/tests/test-world.sh` before the final summary block:

```bash
# ── Case 2.1: local Foundry-running probe honors MOCK_LOCAL_UP ────────────────
D="$TMP/probe"; make_data "$D" "MAIN-PC" "14.363"
rc=$(run_world "MAIN-PC" "$D" MOCK_LOCAL_UP=true -- status)
grep -qi "running" "$TMP/out" && ok "status: reports Foundry running when up" \
  || bad "local up probe" "$(cat "$TMP/out")"

rc=$(run_world "MAIN-PC" "$D" MOCK_LOCAL_UP=false -- status)
grep -qi "stopped" "$TMP/out" && ok "status: reports stopped when down" \
  || bad "local down probe" "$(cat "$TMP/out")"

# ── Case 2.2: peer config falls back to BACKUP_REMOTE_* ──────────────────────
# With WORLD_PEER_SSH unset but BACKUP_REMOTE_HOST set, status --peer resolves it.
D="$TMP/peercfg"; make_data "$D" "LAPTOP" "14.363"
rc=$(run_world "MAIN-PC" "$D" BACKUP_REMOTE_HOST=user@laptop MOCK_PEER_REACHABLE=true \
      MOCK_PEER_DATA="$D" -- status --peer)
if grep -q "user@laptop" "$TMP/out" && grep -qi "reachable" "$TMP/out"; then
  ok "status --peer: resolves peer from BACKUP_REMOTE_HOST, reachable"
else bad "peer cfg" "rc=$rc; $(cat "$TMP/out")"; fi
```

For these tests, `cmd_status` must (a) always print running/stopped for the local machine, and (b) accept an optional `--peer` flag that prints peer SSH target + reachability. Update Case 1.1's expectation is unaffected (still prints holder + "this machine").

- [ ] **Step 2: Run tests, verify the new cases fail**

Run: `bash scripts/tests/test-world.sh`
Expected: Cases 2.1/2.2 FAIL (`running`/`stopped`/`--peer` not printed); Task 1 cases still pass.

- [ ] **Step 3: Implement the probes and extend `cmd_status`**

Add these functions above `main` in `scripts/world.sh`:

```bash
foundry_port() {
  local p; p="$(cd "$REPO_ROOT" && get_env_value FOUNDRY_PORT)"
  echo "${p:-30000}"
}

foundry_running_local() {
  curl -sf -o /dev/null "http://localhost:$(foundry_port)/" 2>/dev/null
}

peer_ssh() {
  local s; s="$(cd "$REPO_ROOT" && get_env_value WORLD_PEER_SSH)"
  [[ -z "$s" ]] && s="$(cd "$REPO_ROOT" && get_env_value BACKUP_REMOTE_HOST)"
  [[ -n "$s" ]] || die "no peer configured (set WORLD_PEER_SSH in .env)"
  echo "$s"
}

peer_data() {
  local d; d="$(cd "$REPO_ROOT" && get_env_value WORLD_PEER_DATA_PATH)"
  [[ -z "$d" ]] && d="$(cd "$REPO_ROOT" && get_env_value BACKUP_REMOTE_PATH)"
  d="${d:-$HOME/.local/share/FoundryVTT}"
  echo "${d/#\~/$HOME}"
}

peer_reachable() {
  ssh -o BatchMode=yes -o ConnectTimeout=5 "$(peer_ssh)" true 2>/dev/null
}

foundry_running_remote() {
  ssh -o BatchMode=yes "$(peer_ssh)" \
    "curl -sf -o /dev/null http://localhost:$(foundry_port)/" 2>/dev/null
}
```

Replace `cmd_status` with:

```bash
cmd_status() {
  local peer=false
  [[ "${1:-}" == "--peer" ]] && peer=true
  local holder self; holder="$(read_holder)"; self="$(i_am)"
  if [[ -z "$holder" ]]; then
    echo "World lease: (none). Run: ./scripts/world.sh init   (on the main PC)"
  else
    echo "World lease held by: $holder"
    if [[ "$holder" == "$self" ]]; then
      echo "  -> this machine ($self) holds the world."
    else
      echo "  -> this machine ($self) is frozen; $holder holds the world."
    fi
  fi
  if foundry_running_local; then
    echo "Local Foundry: running on port $(foundry_port)."
  else
    echo "Local Foundry: stopped."
  fi
  if [[ "$peer" == true ]]; then
    local ptarget; ptarget="$(peer_ssh)"
    if peer_reachable; then
      echo "Peer $ptarget: reachable."
    else
      echo "Peer $ptarget: UNREACHABLE (on the LAN?)."
    fi
  fi
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bash scripts/tests/test-world.sh`
Expected: PASS — all Task 1 + Task 2 cases green.

- [ ] **Step 5: Commit**

```bash
git add scripts/world.sh scripts/tests/test-world.sh
git commit -m "feat(world): Foundry-running probe and peer config resolution"
```

---

## Task 3: The `up` gate

**Files:**
- Modify: `scripts/world.sh`
- Test: `scripts/tests/test-world.sh`

**Interfaces:**
- Consumes: `i_hold`, `read_holder`, `i_am`.
- Produces: `cmd_up` — starts `docker compose up -d` only when `i_hold`; otherwise prints the refusal message (spec's Refusal UX) and exits non-zero. **Never syncs.** Also stamps the current `FOUNDRY_VERSION` into `<data>/Data/.foundry-world-version` on successful start (records "this version opened the world").

- [ ] **Step 1: Write failing tests**

Append before the summary:

```bash
# ── Case 3.1: up refuses on the non-holder, prints what to do ─────────────────
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
```

- [ ] **Step 2: Run tests, verify new cases fail**

Run: `bash scripts/tests/test-world.sh`
Expected: 3.1/3.2 FAIL (`cmd_up` still the stub "not implemented yet").

- [ ] **Step 3: Implement `cmd_up`**

Remove the `cmd_up` stub and add:

```bash
world_version() {
  local v; v="$(cd "$REPO_ROOT" && get_env_value FOUNDRY_VERSION)"
  echo "$v"
}

stamp_version() {
  local v; v="$(world_version)"
  [[ -n "$v" ]] || return 0
  mkdir -p "$(data_root)/Data"
  echo "$v" > "$(data_root)/Data/.foundry-world-version"
}

cmd_up() {
  if ! i_hold; then
    local holder; holder="$(read_holder)"
    cat >&2 <<EOF
✗ Cannot start Foundry — world lease held by ${holder:-<none>}.
  On LAN?      ./scripts/world.sh checkout      (pull world + take lease)
  Not on LAN?  ${holder:-The other machine} holds it. Options:
    - Author offline instead: content/src/ + foundry-content skill (no lease)
    - Wait until back on LAN
  Who holds it: ./scripts/world.sh status
EOF
    exit 1
  fi
  ( cd "$REPO_ROOT" && docker compose up -d )
  stamp_version
  echo "Foundry starting. This machine ($(i_am)) holds the world."
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bash scripts/tests/test-world.sh`
Expected: PASS — all cases through 3.2 green.

- [ ] **Step 5: Commit**

```bash
git add scripts/world.sh scripts/tests/test-world.sh
git commit -m "feat(world): up gate refuses non-holder, stamps world version"
```

---

## Task 4: Snapshot + version-compare helpers

**Files:**
- Modify: `scripts/world.sh`
- Test: `scripts/tests/test-world.sh`

**Interfaces:**
- Consumes: `data_root`.
- Produces:
  - `snapshot_dir DATADIR` → makes `DATADIR/Data.snap-<ts>` as a hardlinked copy of `DATADIR/Data` (via `rsync -a --delete --link-dest`), prunes to the newest 3 snapshots, echoes the snapshot path. `<ts>` from `date +%Y%m%d-%H%M%S`.
  - `version_lt A B` → returns 0 if version A is strictly older than B (using `sort -V`), else 1. Empty A treated as "unknown" → returns 1 (do not block when we can't tell — the running probe and verify still guard; only a *known* older version blocks, handled by callers).
  - `stamp_of DATADIR` → echoes contents of `DATADIR/Data/.foundry-world-version` (empty if absent).

- [ ] **Step 1: Write failing tests**

Append:

```bash
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
( cd "$SCRIPTS/.." && WORLD_SELF=x FOUNDRY_DATA_PATH="$D" bash -c '
    source scripts/world.sh
    for i in 1 2 3 4; do snapshot_dir "'"$D"'" >/dev/null; done
  ' )
count=$(find "$D" -maxdepth 1 -name "Data.snap-*" -type d | wc -l)
snap=$(find "$D" -maxdepth 1 -name "Data.snap-*" -type d | head -n1)
if [[ "$count" -le 3 ]] && [[ -f "$snap/worlds/troubled-waters/data.db" ]]; then
  ok "snapshot_dir: copies world, prunes to <=3"
else bad "snapshot" "count=$count snap=$snap"; fi
```

Note: sourcing `scripts/world.sh` runs nothing (guarded), so the helper functions are callable. Snapshots created back-to-back may share a timestamp second; `snapshot_dir` must tolerate an existing target (reuse/refresh it) so four rapid calls still produce ≤3 distinct dirs.

- [ ] **Step 2: Run tests, verify fail**

Run: `bash scripts/tests/test-world.sh`
Expected: 4.1/4.2 FAIL (functions undefined).

- [ ] **Step 3: Implement the helpers**

Add above `main`:

```bash
stamp_of() {
  local dd="$1"
  [[ -f "$dd/Data/.foundry-world-version" ]] && cat "$dd/Data/.foundry-world-version" || echo ""
}

version_lt() {
  local a="$1" b="$2"
  [[ -z "$a" || -z "$b" ]] && return 1          # unknown -> not "older"
  [[ "$a" == "$b" ]] && return 1
  [[ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -n1)" == "$a" ]]
}

snapshot_dir() {
  local dd="$1" ts prev
  ts="$(date +%Y%m%d-%H%M%S)"
  local target="$dd/Data.snap-$ts"
  prev="$(find "$dd" -maxdepth 1 -name 'Data.snap-*' -type d | sort | tail -n1)"
  local -a linkdest=()
  [[ -n "$prev" && "$prev" != "$target" ]] && linkdest=(--link-dest="$prev")
  rsync -a --delete "${linkdest[@]}" "$dd/Data/" "$target/"
  # Prune: keep newest 3.
  find "$dd" -maxdepth 1 -name 'Data.snap-*' -type d | sort | head -n -3 | \
    while IFS= read -r old; do rm -rf "$old"; done
  echo "$target"
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bash scripts/tests/test-world.sh`
Expected: PASS — all cases through 4.2 green.

- [ ] **Step 5: Commit**

```bash
git add scripts/world.sh scripts/tests/test-world.sh
git commit -m "feat(world): hardlinked snapshots and version-compare helpers"
```

---

## Task 5: The handoff transaction (`checkout` / `checkin` / `reclaim`)

**Files:**
- Modify: `scripts/world.sh`
- Test: `scripts/tests/test-world.sh`

**Interfaces:**
- Consumes: everything above — `peer_ssh`, `peer_data`, `peer_reachable`, `foundry_running_local`, `foundry_running_remote`, `snapshot_dir`, `stamp_of`, `version_lt`, `world_version`, `write_lease`, `i_am`, `data_root`.
- Produces:
  - `handoff DIRECTION` where `DIRECTION` is `pull` (peer → local, used by `checkout` and `reclaim`) or `push` (local → peer, used by `checkin`). Runs the full guarded transaction and flips the lease last.
  - `cmd_checkout` → guards this machine is *not* the holder-to-be conflict, then `handoff pull` and sets holder = `i_am`.
  - `cmd_checkin` → `handoff push` and sets holder = the peer's identity.
  - `cmd_reclaim` → `handoff pull` and sets holder = `i_am` (same as checkout; the peer here is the laptop).
- The transaction ordering (must match the spec exactly):
  1. peer reachable? else refuse.
  2. the **source** machine's Foundry not running? else refuse ("stop Foundry on <source> first").
  3. version guard: the **receiver**'s `FOUNDRY_VERSION` must not be older than the source world's stamp. Refuse on drift.
  4. snapshot BOTH sides (local via `snapshot_dir`; peer via `ssh <peer> ... snapshot`).
  5. `rsync --archive --delete` source `Data/` → target `Data/`, excluding `Backups/`, `container_cache/`, `Logs/`.
  6. verify: `rsync -rin --delete --checksum` source vs target prints no differences.
  7. flip lease LAST — write the *frozen* side first, the *gaining* side last.

**Peer identity:** the peer's hostname is needed to name it as holder on `checkin`. Resolve with `ssh <peer> 'cat <peerdata>/.foundry-lease'`-independent call: `peer_name()` → `ssh <peer> hostname` (cached in a var for the call).

- [ ] **Step 1: Write failing tests**

Append the transaction tests. These exercise refusals and a full round trip using the ssh shim (which runs "remote" commands locally against `MOCK_PEER_DATA`):

```bash
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

# ── Case 5.4: full checkout round trip — world moves, junk excluded, lease flips ─
L="$TMP/l4"; P="$TMP/p4"; make_pair "$L" "$P" "14.363" "MAIN-PC"
echo "PEER-ONLY-WORLD" > "$P/Data/worlds/troubled-waters/data.db"
rc=$(run_world "LAPTOP" "$L" WORLD_PEER_SSH=u@main WORLD_PEER_DATA_PATH="$P" \
      FOUNDRY_VERSION=14.363 MOCK_PEER_REACHABLE=true MOCK_REMOTE_UP=false -- checkout)
if [[ "$rc" == "0" ]] \
   && grep -q "PEER-ONLY-WORLD" "$L/Data/worlds/troubled-waters/data.db" \
   && [[ ! -e "$L/Data/Backups/old.bak" ]] \
   && [[ ! -e "$L/Data/container_cache/foundry.zip" ]] \
   && grep -q '"holder":"LAPTOP"' "$L/.foundry-lease" \
   && grep -q '"holder":"LAPTOP"' "$P/.foundry-lease"; then
  ok "checkout: world moved, Backups/cache excluded, lease flipped to LAPTOP both sides"
else bad "checkout round trip" "rc=$rc; local_lease=$(cat "$L/.foundry-lease" 2>&1); peer_lease=$(cat "$P/.foundry-lease" 2>&1); out=$(cat "$TMP/out")"; fi

# ── Case 5.5: checkin pushes laptop -> peer(main), lease returns to peer ──────
# Laptop currently holds (from 5.4 state shape); build fresh:
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
```

Note on 5.5: the ssh shim runs "remote" commands locally, so `ssh <peer> hostname` returns *this* box's hostname — that is why the expected peer-holder is `$(hostname)`. On real hardware it is the main PC's hostname. This is a shim artifact, not a logic change.

- [ ] **Step 2: Run tests, verify the new cases fail**

Run: `bash scripts/tests/test-world.sh`
Expected: 5.1–5.5 FAIL (`cmd_checkout`/`cmd_checkin` still stubs).

- [ ] **Step 3: Implement the transaction**

Remove the `cmd_checkout`/`cmd_checkin`/`cmd_reclaim` stubs. Add above `main`:

```bash
RSYNC_EXCLUDES=(--exclude 'Backups/' --exclude 'container_cache/' --exclude 'Logs/')

peer_name() { ssh -o BatchMode=yes "$(peer_ssh)" hostname 2>/dev/null; }

# remote_snapshot — snapshot the peer's Data via ssh, reusing snapshot_dir's logic
remote_snapshot() {
  local pd; pd="$(peer_data)"
  ssh -o BatchMode=yes "$(peer_ssh)" bash -s -- "$pd" <<'REMOTE'
dd="$1"; ts="$(date +%Y%m%d-%H%M%S)"; target="$dd/Data.snap-$ts"
prev="$(find "$dd" -maxdepth 1 -name 'Data.snap-*' -type d | sort | tail -n1)"
link=(); [ -n "$prev" ] && [ "$prev" != "$target" ] && link=(--link-dest="$prev")
rsync -a --delete "${link[@]}" "$dd/Data/" "$target/"
find "$dd" -maxdepth 1 -name 'Data.snap-*' -type d | sort | head -n -3 | while IFS= read -r o; do rm -rf "$o"; done
REMOTE
}

# handoff DIRECTION — pull (peer->local) or push (local->peer). Flips lease last.
# Args: $1 direction; $2 new_holder (who holds after); $3 label for the source.
handoff() {
  local dir="$1" new_holder="$2"
  local peer ssh_t pdata ldata
  ssh_t="$(peer_ssh)"; pdata="$(peer_data)"; ldata="$(data_root)"

  # 1. reachability
  peer_reachable || die "peer $ssh_t unreachable — are you on the LAN?"

  # 2. source must not be running
  local src_running=false src_label=""
  if [[ "$dir" == "pull" ]]; then
    foundry_running_remote && src_running=true; src_label="the peer ($ssh_t)"
  else
    foundry_running_local && src_running=true; src_label="this machine"
  fi
  [[ "$src_running" == false ]] || die "stop Foundry on $src_label first (world is open — unsafe to copy)."

  # 3. version guard: receiver's FOUNDRY_VERSION must not be older than source world stamp
  local src_stamp recv_ver
  recv_ver="$(world_version)"
  if [[ "$dir" == "pull" ]]; then
    src_stamp="$(ssh -o BatchMode=yes "$ssh_t" "cat '$pdata/Data/.foundry-world-version' 2>/dev/null || true")"
    if version_lt "$recv_ver" "$src_stamp"; then
      die "version drift: this machine runs FOUNDRY_VERSION=$recv_ver but the world was last written by $src_stamp. Align FOUNDRY_VERSION before handoff."
    fi
  else
    # push: receiver is the peer; compare peer's version to our world stamp.
    local peer_ver; peer_ver="$(ssh -o BatchMode=yes "$ssh_t" "grep -E '^FOUNDRY_VERSION=' '$pdata/../.env' 2>/dev/null | head -n1 | cut -d= -f2-" || true)"
    local our_stamp; our_stamp="$(stamp_of "$ldata")"
    if [[ -n "$peer_ver" ]] && version_lt "$peer_ver" "$our_stamp"; then
      die "version drift: peer runs FOUNDRY_VERSION=$peer_ver but the world was last written by $our_stamp. Align FOUNDRY_VERSION before handoff."
    fi
  fi

  # 4. snapshot BOTH
  echo "Snapshotting both sides..."
  snapshot_dir "$ldata" >/dev/null
  remote_snapshot

  # 5. mirror transfer
  echo "Transferring world..."
  if [[ "$dir" == "pull" ]]; then
    rsync -a --delete "${RSYNC_EXCLUDES[@]}" -e ssh "$ssh_t:$pdata/Data/" "$ldata/Data/"
  else
    rsync -a --delete "${RSYNC_EXCLUDES[@]}" -e ssh "$ldata/Data/" "$ssh_t:$pdata/Data/"
  fi

  # 6. verify equality (checksum dry-run must show no changes)
  local diffs
  if [[ "$dir" == "pull" ]]; then
    diffs="$(rsync -rin --delete --checksum "${RSYNC_EXCLUDES[@]}" -e ssh "$ssh_t:$pdata/Data/" "$ldata/Data/")"
  else
    diffs="$(rsync -rin --delete --checksum "${RSYNC_EXCLUDES[@]}" -e ssh "$ldata/Data/" "$ssh_t:$pdata/Data/")"
  fi
  [[ -z "$diffs" ]] || die "verification failed after transfer — source and target differ. Lease unchanged; your snapshots are intact. Diffs:\n$diffs"

  # 7. flip lease LAST — frozen side first, gaining side last.
  # remote lease helper:
  remote_set_lease() {
    local h="$1" now; now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    ssh -o BatchMode=yes "$ssh_t" \
      "printf '{\"holder\":\"%s\",\"since\":\"%s\"}\n' '$h' '$now' > '$pdata/.foundry-lease'"
  }
  if [[ "$dir" == "pull" ]]; then
    # local machine gains -> write peer(frozen) first, local(gaining) last
    remote_set_lease "$new_holder"
    write_lease "$new_holder"
  else
    # peer gains -> write local(frozen) first, peer(gaining) last
    write_lease "$new_holder"
    remote_set_lease "$new_holder"
  fi
  echo "Done. World now held by: $new_holder"
}

cmd_checkout() { handoff pull "$(i_am)"; }
cmd_reclaim()  { handoff pull "$(i_am)"; }
cmd_checkin()  { handoff push "$(peer_name)"; }
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bash scripts/tests/test-world.sh`
Expected: PASS — all cases 1.1 through 5.5 green.

- [ ] **Step 5: Commit**

```bash
git add scripts/world.sh scripts/tests/test-world.sh
git commit -m "feat(world): guarded checkout/checkin/reclaim handoff transaction"
```

---

## Task 6: Crash-safety ordering test (lease flips last)

**Files:**
- Modify: `scripts/tests/test-world.sh`

**Interfaces:**
- Consumes: `cmd_checkout` / `handoff`.
- Produces: no new code — a regression test proving that if the transfer/verify step fails, the lease stays with the source (no data loss, safe to rerun).

- [ ] **Step 1: Write the failing test**

Append. Force a verify failure by making the peer source unreadable mid-transfer via an rsync-fail shim toggled with `MOCK_RSYNC_FAIL`:

```bash
# Add to the rsync handling: a fail knob. Provide an rsync shim only for this case.
cat > "$SHIMS/rsync-failing" <<'EOF'
#!/usr/bin/env bash
exit 23   # rsync "partial transfer" error
EOF
chmod +x "$SHIMS/rsync-failing"

# ── Case 6.1: transfer failure leaves lease with the source, no partial win ──
L="$TMP/l6"; P="$TMP/p6"; make_data "$L" "" "14.363"; make_data "$P" "MAIN-PC" "14.363"
rc=$( ( cd "$SCRIPTS/.." || exit 99
        env PATH="$SHIMS:$PATH" WORLD_SELF="LAPTOP" FOUNDRY_DATA_PATH="$L" \
            WORLD_PEER_SSH=u@main WORLD_PEER_DATA_PATH="$P" FOUNDRY_VERSION=14.363 \
            MOCK_PEER_REACHABLE=true MOCK_REMOTE_UP=false MOCK_RSYNC_FAIL=1 \
            bash scripts/world.sh checkout
      ) > "$TMP/out" 2>&1; echo $? )
# Lease must NOT have flipped to LAPTOP on either side.
if [[ "$rc" != "0" ]] \
   && ! grep -q '"holder":"LAPTOP"' "$L/.foundry-lease" 2>/dev/null \
   && grep -q '"holder":"MAIN-PC"' "$P/.foundry-lease"; then
  ok "crash-safety: transfer failure keeps lease with source (MAIN-PC)"
else bad "crash safety" "rc=$rc; local=$(cat "$L/.foundry-lease" 2>&1); peer=$(cat "$P/.foundry-lease" 2>&1)"; fi
```

- [ ] **Step 2: Wire the `MOCK_RSYNC_FAIL` knob into `handoff`**

Because `set -e` is active, a failing `rsync` at the transfer step already aborts before the lease flip. Add a test-only hook so the failure is injectable without a real network error. In `handoff`, immediately before the transfer step (step 5), add:

```bash
  # Test hook: simulate a transfer failure to prove lease-flips-last safety.
  [[ "${MOCK_RSYNC_FAIL:-0}" == "1" ]] && die "transfer failed (injected). Lease unchanged; snapshots intact."
```

- [ ] **Step 3: Run tests, verify pass**

Run: `bash scripts/tests/test-world.sh`
Expected: PASS — Case 6.1 green (lease still `MAIN-PC` on the peer, no `LAPTOP` lease locally).

- [ ] **Step 4: Commit**

```bash
git add scripts/world.sh scripts/tests/test-world.sh
git commit -m "test(world): prove lease stays with source when transfer fails"
```

---

## Task 7: Docs and `.env.example`

**Files:**
- Modify: `.env.example`
- Create: `docs/WORLD_SYNC.md`
- Modify: `CLAUDE.md`

**Interfaces:** none (documentation + config sample).

- [ ] **Step 1: Add the peer vars to `.env.example`**

Append to `.env.example` after the `BACKUP_*` block:

```bash

# Portable World Sync (scripts/world.sh) — the "other machine" on your LAN.
# On the LAPTOP these point at the MAIN PC; on the MAIN PC they point at the
# laptop (for `reclaim`). Key-based SSH only. If unset, world.sh falls back to
# BACKUP_REMOTE_HOST / BACKUP_REMOTE_PATH.
WORLD_PEER_SSH=
WORLD_PEER_DATA_PATH=~/.local/share/FoundryVTT
```

- [ ] **Step 2: Write `docs/WORLD_SYNC.md`**

```markdown
# Portable World Sync

Run the same Foundry world on your main PC and a laptop over the LAN without
data loss. Design: `docs/superpowers/specs/2026-07-17-portable-world-lease-sync-design.md`.

## The one rule

**One machine edits at a time.** FoundryVTT worlds are LevelDB — they cannot be
merged. `world.sh` enforces a *lease*: exactly one machine "holds" the world;
the other refuses to start Foundry until you hand it over. You hand off, edit,
hand back — full parity in both directions. You do **not** edit both machines
while apart and merge later; nothing can merge LevelDB.

## One-time setup

On **both** machines, in `.env`:

- `FOUNDRY_DATA_PATH` — your Foundry data dir (default `~/.local/share/FoundryVTT`).
- `FOUNDRY_VERSION` — **must be identical on both machines** (a newer world can't
  be reopened by an older Foundry). `world.sh` refuses a handoff on drift.
- `WORLD_PEER_SSH` — `user@host` of the *other* machine on the LAN.
- `WORLD_PEER_DATA_PATH` — that machine's `FOUNDRY_DATA_PATH`.

Set up key-based SSH between the two (see `BACKUP_RESTORE.md`). Then, on the
**main PC** (the default holder), claim the lease once:

    ./scripts/world.sh init        # holder = this machine

Copy `Config/` (license + admin key) to the laptop once by any means; it is not
re-synced on every handoff.

## Daily use

Start Foundry through the gate (never `docker compose up` directly):

    ./scripts/world.sh up          # starts only if THIS machine holds the world

Take the world to the laptop (run on the **laptop**, on the LAN, main PC stopped):

    ./scripts/world.sh checkout    # pulls world from main, laptop takes the lease

Work offline as long as you like. Back home, return it (on the **laptop**, LAN):

    ./scripts/world.sh checkin     # pushes your edits to main, releases the lease

Left the laptop holding the world and it's in your bag? From the **main PC**:

    ./scripts/world.sh reclaim     # pulls the world back from the laptop

Check who holds it anytime:

    ./scripts/world.sh status --peer

## What travels

The whole `Data/` dir (worlds, modules, systems, assets) mirrors across so a
world never opens against the wrong add-ons. Excluded (stay per-machine):
`Backups/`, `container_cache/`, `Logs/`. `Config/` (license/admin/ports) is set
up once per machine, not synced.

## If something looks wrong

Every handoff snapshots **both** machines first, to `Data.snap-<timestamp>/`
(the newest 3 are kept, hardlinked so they cost almost no disk). To roll back,
stop Foundry and restore a snapshot:

    rsync -a --delete <data>/Data.snap-YYYYMMDD-HHMMSS/ <data>/Data/

A failed or interrupted handoff never flips the lease — the previous holder
stays authoritative, so you just rerun the command.
```

- [ ] **Step 3: Append the pointer to `CLAUDE.md`**

Add at the very end of `CLAUDE.md` (append-only per the repo's template-sync rule):

```markdown

## Portable world sync (main PC ↔ laptop)

`scripts/world.sh` moves the live world between machines over the LAN under a
hard lease (one holder at a time; the non-holder's `world.sh up` refuses).
Handoff snapshots both sides, mirrors `Data/` with `rsync --delete`, verifies,
and flips the lease last. Commands: `up`, `checkout`/`checkin` (laptop),
`reclaim` (main PC), `status --peer`. Full guide: `docs/WORLD_SYNC.md`. This is
world **state** movement; bulk **authoring** still goes through the
foundry-content skill (see "Content routing"). One editor at a time — LevelDB
worlds do not merge.
```

- [ ] **Step 4: Verify docs render and the sample parses**

Run: `bash -n scripts/world.sh && grep -q WORLD_PEER_SSH .env.example && test -f docs/WORLD_SYNC.md && echo OK`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add .env.example docs/WORLD_SYNC.md CLAUDE.md
git commit -m "docs(world): operator guide, .env.example peer vars, CLAUDE.md pointer"
```

---

## Self-Review

**1. Spec coverage:**
- Lease (one holder, file, both machines read) → Tasks 1, 3. ✓
- `up` gate refuses non-holder, never syncs → Task 3. ✓
- Handoff `checkout`/`checkin`/`reclaim`, ordering, snapshot both, mirror `--delete`, verify, lease-last → Task 5. ✓
- Refusal UX message → Task 3 (`cmd_up`). ✓
- Snapshot both before overwrite, rollback → Tasks 4, 5, 7 (docs). ✓
- Mirror-not-union guard → Task 5 (`rsync --delete`, verified by Case 5.4 excludes). ✓
- Version-match guard → Tasks 4 (`version_lt`), 5 (Case 5.3). ✓
- Excludes `Backups/`/`container_cache/`/`Logs/` → Task 5 (Case 5.4 asserts). ✓
- Crash → old holder authoritative → Task 6. ✓
- Config reuse `.env`, new `WORLD_PEER_*` with `BACKUP_REMOTE_*` fallback → Tasks 2, 7. ✓
- `Config/` once at setup → Task 7 (docs). ✓
- Out-of-scope (Option C, auto-checkout, internet) → not built, correct. ✓

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to"/bare "write tests". Every code step has real code. ✓

**3. Type/name consistency:** `data_root`, `lease_file`, `read_holder`, `write_lease`, `i_am`, `i_hold`, `foundry_port`, `foundry_running_local/remote`, `peer_ssh`, `peer_data`, `peer_reachable`, `world_version`, `stamp_version`, `stamp_of`, `version_lt`, `snapshot_dir`, `remote_snapshot`, `handoff`, `peer_name`, `cmd_*` — used consistently across tasks; `handoff pull|push` signature stable between Task 5 definition and Task 6 hook. ✓

## Known real-hardware notes (not blockers, called out honestly)

- The ssh shim runs "remote" commands locally, so tests can't distinguish the peer's hostname from the local one (Case 5.5 asserts `$(hostname)`). On real hardware `peer_name` returns the actual peer hostname — the logic is unchanged; only the test's expected value is a shim artifact.
- `push`-direction version read grabs the peer's `.env FOUNDRY_VERSION` via `$pdata/../.env`, which assumes the peer's data dir sits one level below its repo — true for the default `~/.local/share/FoundryVTT` only if the repo is there too, which it usually is not. This is a best-effort guard on the push side; the **stamp-based pull guard is the authoritative one** (it needs no repo path). If the peer `.env` can't be read the push guard is skipped (fail-open) and the transfer still proceeds — acceptable because the receiving (peer) Foundry will itself refuse to downgrade-open a newer world. Reviewer: confirm this is acceptable or tighten by stamping version into `Data/` and comparing stamps in both directions.
```
