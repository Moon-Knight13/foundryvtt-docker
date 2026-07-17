# Portable World: Lease + Handoff Sync — Design

**Date:** 2026-07-17
**Status:** Approved design, pending implementation plan

## Problem

The Foundry stack runs on a main PC where the FoundryVTT user data lives (bind
mount, `FOUNDRY_DATA_PATH`). The user wants to run the *same* deployment on a
laptop — author content, edit worlds in the Foundry UI, and run live sessions —
then bring the changes home to the main PC **without data loss**. There is no
cloud storage for the world files.

A previous setup existed but was one-way (`BACKUP_RESTORE.md`: rsync pull only),
which cannot carry laptop-side changes back and offers no protection against
overwriting the newer copy.

## Core constraint (why naive sync is wrong)

FoundryVTT v11+ (this repo runs v14) stores world state as **LevelDB** — binary,
append-structured, **non-mergeable**. Two machines editing the same world cannot
be merged; you can only pick a winner. Therefore:

- **Bidirectional file sync of a world dir = last-writer-wins = data loss.**
- The correct model is **ownership handoff**: exactly one machine holds the
  authoritative world at a time; the other is frozen (refuses to start Foundry)
  until ownership is handed back.

This also matches an existing rule: one Foundry license permits one active
server (CLAUDE.md, "Safe A/B testing"). "Only one machine holds the live world"
is already the license rule, not just sync hygiene.

Note: *authored* content already has a merge-clean path — `content/src/` JSON in
git via the foundry-content skill. That is unaffected and remains the offline
authoring route. This design covers world **state**, which git cannot merge.

## Environment (decided)

- Main PC and laptop reachable **only on the same LAN** (not over the internet).
  Sync happens before leaving / after returning; offline in between.
- **Both machines have static LAN IPs**, so either can initiate a handoff.
- Transport: **rsync over SSH, key auth only** — reuses the existing
  `BACKUP_REMOTE_*` SSH setup from `BACKUP_RESTORE.md` / `.env`. No cloud, no new
  credentials.
- Default holder: **main PC** (primary rig).

## Decisions locked during brainstorming

| Decision | Choice | Why |
|---|---|---|
| Sync model | Ownership handoff, not bidirectional sync | LevelDB world is non-mergeable |
| Enforcement | **Hard lease** — non-holder refuses to start Foundry | Makes double-edit impossible, not merely detected |
| Data safety | **Snapshot both sides before every handoff** | Rollback if a sync goes wrong |
| Forgot-checkout while off-LAN | **Option A: refuse, with a "here's what to do" message** | Safest — never creates a second world copy, so no merge bug can exist. Author offline instead |
| What travels | **Whole `Data/`** (worlds + modules + systems + assets) | Handoff is self-consistent; world can't open against wrong module set |
| Excluded from handoff | `Backups/`, `container_cache/`, `Logs/` | Per-machine, regenerable; syncing `Backups/` would stomp local snapshot history |
| `Config/` (license, admin key, server `options.json`) | Synced **once at setup**, not per-handoff | Credential + machine-specific server config (port/hostname); `options.json` is regenerated from `.env` `FOUNDRY_*` on each container start, so each machine keeps its own |
| Transfer semantics | **Mirror, not union** (`rsync --delete`) | Target `Data/` becomes an exact copy of the holder's, so an add-on/system removed on one side actually disappears on the other — no stale module a world can reference and break on. Safe because both sides are snapshotted first |
| Foundry version | **Must match on both machines** — handoff refuses on mismatch | The only true corruption vector: Foundry migrates a world *forward* on load; an older binary cannot reopen a migrated world. Guard closes it |
| Sync as a compose step? | **No** | Lifecycle verbs (`up` on crash/reboot/config-edit) would auto-clobber; direction is a human decision; loss must be deliberate and loud |

### Why Option A over the break-glass alternatives

- **A (refuse)** never creates a second authoritative world copy. No merge path
  exists, so no merge bug can exist. Failure is *blocked* — loud, costs time
  (up to a whole trip without Foundry UI if checkout was forgotten before
  leaving LAN), never data. Offline authoring via the foundry-content skill
  still works with no lease.
- **C (force-take into scratch world)** is cheap to bolt on later — it's a flag
  on the same lease system, not a redesign. Deferred; build only if the block
  genuinely bites.
- **B (force-take into the real world, reconcile on return)** is the only option
  that can actually lose data. Rejected.

Safety order: **A > C > B**.

## Architecture

One new front-door script, `scripts/world.sh`, with three parts. Both machines
run **identical code**; only the hostname (and therefore lease holder identity)
differs.

### 1. Lease

- File `<data>/.foundry-lease` on both machines. JSON:
  `{ holder: <hostname>, since: <ISO timestamp>, world_checksum: <hash> }`.
- Single source of truth for "who holds the world". Both machines read it.
- Default holder is the main PC.
- Never hand-edited; kept correct because handoff is a transaction that flips it
  last (see below).

### 2. Preflight gate — `world.sh up`

Thin wrapper over `docker compose up -d`. **Never syncs.** Only decides yes/no on
starting:

```
read local .foundry-lease
  holder == me?  ── no ─► REFUSE, print who holds it + what to run
                 ── yes ─► docker compose up -d
```

Compose stays the dumb engine behind the gate. Because the gate lives *before*
compose, it can refuse — a compose service could not gate itself.

### 3. Handoff — `checkout` / `checkin` / `reclaim`

Human-initiated, explicit, snapshots first, prints what it did. Same transaction
in every direction; only source/target and lease-target differ.

| Command | Run on | Direction | Purpose |
|---|---|---|---|
| `checkout` | laptop | main → laptop | Take the world to the laptop, acquire lease |
| `checkin` | laptop | laptop → main | Bring the world home, release lease |
| `reclaim` | main PC | laptop → main | Pull the world back when the laptop was left holding it (laptop must be powered + on LAN) |
| `status` | either | — | Who holds it, is Foundry running, checksums, reachability |

`reclaim` = `checkin` executed from the other end; enabled by the laptop's static
IP. It refuses cleanly if the laptop is unreachable
("laptop holds world but unreachable at <ip> — power it on").

## Handoff transaction (safety-critical ordering)

Shown for `checkout` (main → laptop). `checkin` / `reclaim` are identical with
direction flipped.

```
laptop: ./world.sh checkout
  1. reachable?          ── no ─► REFUSE "main PC unreachable, on LAN?"
  2. source running?     ── yes ─► REFUSE "stop Foundry on main first"
  3. FOUNDRY_VERSION ==? ── mismatch ─► REFUSE "version drift: main X, laptop Y"
  4. SNAPSHOT BOTH       ── fail ─► ABORT (lease untouched)
        main:   Data → Data.snap-<date>
        laptop: Data → Data.snap-<date>
  5. rsync --delete Data/ main ──► laptop  (mirror; excl Backups, container_cache, Logs)
        crash here? lease still = MAIN → no loss → rerun
  6. VERIFY checksum source == target ── mismatch ─► ABORT, keep lease = MAIN
  7. FLIP LEASE  main = frozen, laptop = holder   ← last, point of no return
  ✓ laptop holds world; main refuses to start until checkin/reclaim
```

### Three safety invariants

1. **One holder, ever.** The lease file is the single source of truth; both
   machines read it before starting.
2. **Lease flips last.** Data is copied and checksum-verified *before* ownership
   moves. Any crash before step 6 leaves the lease with the old holder — zero
   loss, just rerun the command.
3. **Snapshot both before any overwrite.** `Data.snap-<date>` on both machines is
   the rollback if a sync goes wrong.

## Refusal UX (the entire user-facing surface of Option A)

```
✗ Cannot start Foundry — world lease held by MAIN-PC since Tue 2026-07-14 19:04.
  On LAN?      ./scripts/world.sh checkout      (pull world + take lease)
  Not on LAN?  Main PC holds it. Options:
    - Author offline instead: content/src/ + foundry-content skill (no lease)
    - Wait until back on LAN
  Who holds it: ./scripts/world.sh status
```

## Components & boundaries

| Unit | Does | Depends on |
|---|---|---|
| `scripts/world.sh` | Front door: `up`, `checkout`, `checkin`, `reclaim`, `status` | rsync, ssh, docker compose, lease file |
| Lease read/write | Parse/emit `.foundry-lease`, compare holder to local hostname | jq (or shell), hostname |
| Snapshot | Copy `Data/` → `Data.snap-<date>` on a machine, prune old snaps | cp/rsync, disk |
| rsync transfer | Move `Data/` between hosts with the exclude set, verify checksum | ssh keys, `BACKUP_REMOTE_*` in `.env` |
| Gate | Compare lease holder to hostname; start or refuse | Lease read, docker compose |

`world.sh up` and the sync commands are deliberately separate front-door verbs so
that lifecycle (`up`) can never trigger data movement.

## Config (reuse existing `.env`)

- `BACKUP_REMOTE_*` — already present; the laptop→main (and main→laptop) SSH
  target and path. Both static IPs configured here.
- New: laptop's static IP / SSH target for the main→laptop direction (`reclaim`,
  `checkout` pull), mirroring `BACKUP_REMOTE_*`.
- `Config/` synced once at initial setup (carries `license.json` + admin key);
  excluded from per-handoff sync.

## Error handling

- **Unreachable peer:** refuse with "on LAN?" hint; never proceed on a half-known
  state.
- **Peer Foundry running:** refuse; a running server means the world is open and
  unsafe to copy.
- **`FOUNDRY_VERSION` mismatch:** refuse before any snapshot/copy; handing a
  forward-migrated world to an older binary corrupts it. Resolve by aligning the
  version pin on both machines first.
- **Snapshot fails (e.g. disk full):** abort before any overwrite; lease
  untouched.
- **Checksum mismatch after rsync:** abort, keep lease with the source; the
  target copy is suspect, do not hand ownership to it.
- **Crash mid-sync:** lease unchanged → old holder still authoritative → rerun.
- **Lease file missing/corrupt:** `status` reports it; `up` refuses (fail
  closed); a documented `world.sh init` re-establishes the default holder.

## Testing

- **Lease logic (unit, host-independent):** holder==me → allow; holder==other →
  refuse; missing lease → refuse.
- **Transaction ordering:** simulate crash before step 6 → lease unchanged, both
  copies intact. Simulate checksum mismatch → abort, lease unmoved.
- **Snapshot/rollback:** corrupt a sync, restore from `Data.snap-<date>`, verify
  world opens.
- **Exclude set:** confirm `Backups/`, `container_cache/`, `Logs/` are not
  transferred and local `Backups/` history survives a handoff.
- **Round trip (integration, manual on real hosts):** checkout → edit on laptop →
  checkin → verify main PC sees the laptop edits and opens the world clean.
- **Reclaim:** laptop holds lease, powered + on LAN → `reclaim` from main pulls it
  back; laptop unreachable → refuses cleanly.

## Out of scope (deferred)

- **Option C break-glass** (force-take into a scratch world for off-LAN work) —
  add later only if the refusal genuinely bites. It is a flag on this lease
  system, not a redesign.
- **Automatic checkout on leaving LAN** (suspend/shutdown hook) — considered;
  the "tell me what to do" refusal message is the chosen UX instead. Can be added
  later without changing the model.
- **Internet/remote handoff** — LAN-only by decision. Cloudflare Tunnel
  (`compose.cloudflare.yml`) already covers *playing* remotely against the main
  PC without moving the world at all.
