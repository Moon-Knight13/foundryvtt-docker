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

Optional extra safety net: with Foundry stopped at the Setup screen you can also
use Foundry's built-in **Manage Backups → Create a Snapshot** for a per-package
rollback point. It is separate from `world.sh` (UI-only, and it saves into
`Data/Backups/`, which is deliberately never synced), so use it as an occasional
manual belt-and-suspenders — the automatic `Data.snap-*` above is what the
handoff relies on.
