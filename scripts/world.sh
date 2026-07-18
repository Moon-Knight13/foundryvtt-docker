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

# cfg VAR — value of an exported env override, else the .env value (via
# get_env_value, which never dumps the file). The override lets tests and
# ad-hoc runs pass config as environment variables; production reads .env.
cfg() {
  local name="$1"
  if [[ -n "${!name:-}" ]]; then
    printf '%s\n' "${!name}"
  else
    ( cd "$REPO_ROOT" && get_env_value "$name" )
  fi
}

# ── Identity & paths ─────────────────────────────────────────────────────────
i_am() { echo "${WORLD_SELF:-$(hostname)}"; }

data_root() {
  local d; d="$(cfg FOUNDRY_DATA_PATH)"
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

# ── Foundry-running probe + peer config resolution ───────────────────────────
foundry_port() {
  local p; p="$(cfg FOUNDRY_PORT)"
  echo "${p:-30000}"
}

foundry_running_local() {
  curl -sf -o /dev/null "http://localhost:$(foundry_port)/" 2>/dev/null
}

peer_ssh() {
  local s; s="$(cfg WORLD_PEER_SSH)"
  [[ -z "$s" ]] && s="$(cfg BACKUP_REMOTE_HOST)"
  [[ -n "$s" ]] || die "no peer configured (set WORLD_PEER_SSH in .env)"
  echo "$s"
}

peer_data() {
  local d; d="$(cfg WORLD_PEER_DATA_PATH)"
  [[ -z "$d" ]] && d="$(cfg BACKUP_REMOTE_PATH)"
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

# ── Version stamp + snapshot helpers ─────────────────────────────────────────
world_version() { cfg FOUNDRY_VERSION; }

stamp_version() {
  local v; v="$(world_version)"
  [[ -n "$v" ]] || return 0
  mkdir -p "$(data_root)/Data"
  echo "$v" > "$(data_root)/Data/.foundry-world-version"
}

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

# ── Handoff transaction ──────────────────────────────────────────────────────
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

# handoff DIRECTION NEW_HOLDER — pull (peer->local) or push (local->peer).
# Runs the full guarded transaction and flips the lease LAST.
handoff() {
  local dir="$1" new_holder="$2"
  local ssh_t pdata ldata
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
    # push: receiver is the peer; compare peer's version to our world stamp (best-effort).
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

  # Test hook: simulate a transfer failure to prove lease-flips-last safety.
  [[ "${MOCK_RSYNC_FAIL:-0}" == "1" ]] && die "transfer failed (injected). Lease unchanged; snapshots intact."

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
  remote_set_lease() {
    local h="$1" now; now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    ssh -o BatchMode=yes "$ssh_t" \
      "printf '{\"holder\":\"%s\",\"since\":\"%s\"}\n' '$h' '$now' > '$pdata/.foundry-lease'"
  }
  if [[ "$dir" == "pull" ]]; then
    # local machine gains -> write peer (frozen) first, local (gaining) last
    remote_set_lease "$new_holder"
    write_lease "$new_holder"
  else
    # peer gains -> write local (frozen) first, peer (gaining) last
    write_lease "$new_holder"
    remote_set_lease "$new_holder"
  fi
  echo "Done. World now held by: $new_holder"
}

# ── Subcommands ──────────────────────────────────────────────────────────────
cmd_init() {
  local holder="${1:-$(i_am)}"
  write_lease "$holder"
  echo "Lease initialized: holder = $holder"
}

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

cmd_checkout() { handoff pull "$(i_am)"; }
cmd_reclaim()  { handoff pull "$(i_am)"; }
cmd_checkin()  { handoff push "$(peer_name)"; }

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
