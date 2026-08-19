# Rebuilding FoundryVTT from durable sources

FoundryVTT is treated as a **transient container**. Durable truth lives outside
its world DB:

- **Obsidian vault** (`~/Documents/DnD`, bind-mounted into Foundry at
  `/data/Data/DnD`) — prose, notes, assets, map specs, and the ```statblock
  fences that Foundry actors are compiled from.
- **Git content module(s)** — built from the vault (see `CONTENT_AUTHORING.md`).
- **D&D Beyond** — player characters.

So a world can be wiped and rebuilt. But "transient" is not the same as "free",
and the section below says exactly what a rebuild costs.

## What actually survives a wipe

Foundry has two kinds of compendium, and the difference decides what you lose.

| Kind | Lives in | Survives a world wipe? |
| --- | --- | --- |
| **Module** compendium (`dnd5e.monsters`, `<your-game>-oneshot.actors`) | the module folder on disk | **Yes** |
| **World** compendium (`world.ddb-<world>-ddb-spells`) | inside the world folder | **No** |

Note the world id baked into that second pack name. All twelve
`world.ddb-*` packs that ddb-importer creates are world-scoped, so a rebuild
costs a **full ddb-importer re-run**. That is acceptable — D&D Beyond is the
source of truth — but it is a step, not a freebie, and it used to be missing
from this page.

Genuinely transient, and fine to lose: token positions, fog of war, the combat
tracker, the active scene.

## The golden base

`foundry-base.json` pins the system and the core module set;
`scripts/content/foundry-base.mjs` acts on it. Run these on the **host** — the
devcontainer has no docker socket and does not mount the Foundry data directory.

```bash
node scripts/content/foundry-base.mjs capture <world>   # read a live world into a pinned manifest
node scripts/content/foundry-base.mjs promote <capture>  # fill core pins from a capture
node scripts/content/foundry-base.mjs provision         # install the pinned system + modules
node scripts/content/foundry-base.mjs update [id...]    # move pins forward, deliberately
node scripts/content/foundry-base.mjs snapshot          # copy the data dir as a restore point
node scripts/content/foundry-base.mjs restore --yes     # put the snapshot back
node scripts/content/foundry-base.mjs pull-games        # build + sync every game in the manifest
```

### Adjusting core

The golden base is meant to be *tuned*, not guessed at once. Run the drill, see
what breaks, add what was missing, run it again:

```bash
node scripts/content/foundry-base.mjs add <id> --from foundry-capture-<world>.json \
  --note "why this is here"
node scripts/content/foundry-base.mjs remove <id>
```

`add` takes the version and manifest URL from a capture file, or from the
installed `module.json` when no `--from` is given. Either way the module tells us
about itself — ids are routinely nothing like their titles, so nothing is typed.
Adding the same module twice updates it rather than duplicating, an existing
`note` survives a re-add, and a deliberately pinned URL is never overwritten.

**Expect the first drill to find missing dependencies.** `provision` installs
exactly what is pinned and does not resolve dependency chains, so a lean core can
come up with a quality-of-life module quietly broken. That is the point of
running it: each failure names a module to `add`, with a note saying why it
earned its place.

**Stop Foundry first.** `capture` reads a world's LevelDB settings store, and
LevelDB takes an exclusive lock — a running Foundry holds it, and the raw error
(`Database is not open`) looks like corruption rather than contention:

```bash
docker compose stop foundry
node scripts/content/foundry-base.mjs capture <world>
docker compose up -d
```

The same applies to `srd-cache.mjs`, and to `snapshot`/`restore`, which must not
copy a data directory a live server is writing to.

**Never hand-write module ids.** This is not caution for its own sake: of the
eight placeholders the first draft of `foundry-base.json` carried, six were
wrong in ways no amount of care would have caught — Chat Commander is
`_chatcommands` (leading underscore), Prime Performance is `fvtt-perf-optim`,
Dice Tray is `dice-calculator`, and Argon is *two* modules
(`enhancedcombathud` plus `enhancedcombathud-dnd5e`, the second being the half
that makes it work under dnd5e).

Run `capture`, then `promote` the result:

```bash
node scripts/content/foundry-base.mjs capture <world>
node scripts/content/foundry-base.mjs promote foundry-capture-<world>.json
```

`capture` writes what a world actually has; `promote` copies those versions and
manifest URLs into `foundry-base.json`. Deciding what belongs in core stays a
human judgement — copying a version string does not, and hand-copying manifest
URLs is exactly the transcription this pipeline exists to remove.

**Start with `capture`.** Do not hand-write module ids — a wrong one fails at
rebuild time, which is the worst time. `capture` reads the world's
`core.moduleConfiguration`, which is the only complete source: listing
compendium packs shows only modules that ship packs, so every library and
behaviour module (lib-wrapper, socketlib, most quality-of-life modules) is
invisible that way.

Capture reports, rather than decides:

- modules **active in the world but not in core** — promote or ignore, but see
  them first. Dropping `monks-active-tiles` silently breaks every scene built on
  active tiles.
- modules **in core but not enabled** in that world.

**Pins do not float.** "Always latest" is the hazard this exists to prevent —
`docs/PROJECT.md` records foundry-mcp module/server drift needing a deliberate
`MCP_VERSION` bump. `update` resolves the newest version, rewrites the manifest,
and leaves it in the working tree to review and commit. It also warns when
`foundry-mcp-bridge` moves, because that pin and `MCP_VERSION` in
`scripts/setup-mcp.sh` are the same fact.

**Snapshots refuse to write inside the repo.** The data directory contains
`license.json` and the admin key; a snapshot under the repo tree is one
`git add -A` away from committing a licence key.

## Foundry-side modules

| Module | Role |
| --- | --- |
| **SoSly Obsidian Bridge** | journals ↔ Obsidian vault, bidirectional |
| **Universal Battlemap Importer** (`dd-import`) | `.dd2vtt` → scenes with walls/lights/doors |
| **ddb-importer** | D&D Beyond characters → Foundry actors |
| **foundry-mcp-bridge** | live-world tooling for Claude Code |
| your **content compendium module(s)** | built from the vault |

## Rebuild drill

Run this against the real stack — there is no second instance (see
`docs/PROJECT.md`, "Testing changes against the live stack"). The snapshot is
the undo. Do it **between sessions, not on game night**: Foundry is down while
it runs.

1. `foundry-base.mjs snapshot` — and confirm it exists before wiping anything.
2. Wipe the world (or the data dir), then `foundry-base.mjs provision`.
3. Launch Foundry, create a world, then restore the game content:
   - `foundry-base.mjs pull-games` rebuilds every game listed in
     `foundry-base.json`'s `games` array — **check that array first**; while
     it is empty the command prints "No games listed in the manifest —
     nothing to pull" and restores nothing. Add each game's config path, or
     run `scripts/content/ship-game.sh <game-dir>` per game instead (it also
     restarts Foundry, which `pull-games` does not — restart yourself after
     a pull so the new packs load).
   - Either path runs the **strict art gate** between build and sync and
     hard-fails on a blank named-NPC token — fix art before continuing, do
     not bypass the gate mid-drill.
4. Enable the modules; import compendium packs with **"Keep Document IDs"**
   ticked (see `CONTENT_AUTHORING.md`, *Rules that bite* — without it, scene map
   pins render but open nothing).
5. Re-run **ddb-importer**: its packs are world-scoped and did not survive.
6. Run the SoSly bridge import to bring vault notes back as journals.
7. **Check both surfaces**, because a game that imports is not the same as a
   game that is ready to run:
   - *Foundry* — scenes carry walls and lights, actors carry real art rather
     than `mystery-man.svg`, and a GM map pin opens its journal page.
   - *In person* — every NPC note still renders a Fantasy Statblocks card with a
     portrait, handouts show their art full-size, and the Player map prints.
8. On success the rebuild **is** the new state. On failure,
   `foundry-base.mjs restore --yes`.

Assets resolve through the `/data/Data/DnD` mount — nothing is copied into the
world.

## Guardrails

- **One writer at a time now spans Foundry.** Do not edit the same journal in
  Foundry and Obsidian (or on two devices) at once — the bridge plus Obsidian
  Sync can clobber. Treat Obsidian as primary; let Foundry edits sync back, then
  stop.
- **A journal is owned by one pipe** — the bridge (prose) **or** the compendium
  build (structured), never both.
- **Keep the mount path stable** (`/data/Data/DnD`). Scene and journal image
  references resolve against it; changing it breaks links on rebuild.
- **One licence, one active server.** There is no parallel test instance to fall
  back on, which is why the snapshot comes first.
