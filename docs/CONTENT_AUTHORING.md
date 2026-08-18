# Content authoring (content-as-code)

Campaign content — NPCs, items, quest journals, scenes, roll tables, factions,
encounters — is authored as JSON files in the repo and compiled into a
compendium module (this repo's: **Troubled Waters Content**, dnd5e). This
replaces the foundry-mcp content-creation tools for anything bulk or offline:
it costs a fraction of the tokens (no MCP tool schemas or JSON results in
Claude's context), every document is versioned in git, and content survives
world rebuilds because it lives in a module, not the world database.

Module identity lives in **`content/content.config.json`** (`id`, `title`,
`system`, version, ownership). The build and `sync-content.sh` both read it —
change the module there, not in scripts. Omit `system` for a system-agnostic
module; set it (here: `dnd5e`) to bind packs to a system.

## Pipeline

```text
content/src/*.json  --build-->  content/dist/<module-id>/  --sync (host)-->  Data/modules/  --import-->  world
```

1. **Author** (Claude, in the devcontainer): the `foundry-content` skill —
   shipped by the **foundry-gm** plugin (`/plugin install
   foundry-gm@foundry-gm-marketplace`) — copies a template —
   system-agnostic: `templates/common/{journal,scene,roll-table,faction,encounter}.json`;
   dnd5e: `templates/dnd5e/{npc,item}.json` — into
   `content/src/{actors,items,journals,scenes,tables}/<kebab-name>.json` and
   edits the needed fields (factions and encounters are journal documents).
   Templates are minimal on purpose — Foundry defaults every omitted system
   field on import.
2. **Build** (Claude, in the devcontainer):

   ```bash
   node scripts/content/build.mjs
   ```

   Validates every source file (fails with file + field), validates `@UUID`
   cross-links against staged sources (broken links fail the build), assigns
   deterministic IDs, and compiles LevelDB packs plus `module.json` into
   `content/dist/<module-id>/`. One-time setup:
   `npm --prefix scripts/content install`.
3. **Sync** (you, on the HOST — the devcontainer cannot reach the Foundry
   data dir):

   ```bash
   ./scripts/content/sync-content.sh          # Foundry data dir ($FOUNDRY_DATA_PATH)
   ```

4. **Import** (you, in the Foundry UI): enable the "Troubled Waters Content"
   module in the world (Game Settings → Manage Modules — packs are invisible
   until the module is on), open Compendium Packs, import documents — with
   **"Keep Document IDs" ticked**, or scene map pins will render but open
   nothing (see *Rules that bite*).
   Pack-content changes need a world reload; `module.json` changes need a
   world relaunch. **If Foundry runs in a container, restart it after syncing**
   (`docker compose restart`) — Foundry opens compendium (LevelDB) packs at
   container start, so a world reload alone keeps serving the old pack from open
   file handles; a stale/half-swapped pack shows old data or fails to import.

## Multiple modules — one per game (one repo, N games)

`build.mjs` and `sync-content.sh` default to `content/content.config.json` +
`content/src/`. Every **game** (oneshot or campaign) gets its **own** module —
its own config + `srcDir` — so its compendium is a separate module you enable
only in that game's world.

### Scaffold a new game's module

Don't hand-write the config. Run:

```bash
scripts/content/new-game.sh <slug> [--type oneshot|campaign] [--system <sys>] [--title "<Title>"]
# e.g. scripts/content/new-game.sh harborwatch --type campaign --system dnd5e
```

It writes `content/<slug>.config.json` and creates the empty
`content/src-<slug>/{actors,items,journals,scenes,tables}/` tree (with
`.gitkeep`s), then prints the build + sync commands. It refuses to overwrite an
existing config. Omit `--system` for a system-agnostic module.

### Naming convention (locked)

| Thing | Rule |
| --- | --- |
| config file | `content/<slug>.config.json` |
| `srcDir` | `src-<slug>` (dir under `content/`) |
| module `id` | `<slug>-oneshot` or `<slug>-campaign` |
| `packLabelPrefix` | the game's title |
| `system` | per game; omit for system-agnostic |
| exception | default `content/src/` + `troubled-waters-content` is the seed/demo — left as-is. |

### Build + sync a specific module

```bash
node scripts/content/build.mjs    --config content/<slug>.config.json
./scripts/content/sync-content.sh --config content/<slug>.config.json   # on the host
```

`srcDir` is a directory under `content/` (default `src`); each module builds into
its own `content/dist/<id>/`. Source-root precedence: `--src` / explicit
`srcRoot` arg > config `srcDir` > `content/src`. The full lifecycle (spark,
author in the vault, package, play) lives in the vault guide
`examples/vault-skeleton/00 Index/Running a new game.md`.

### Vault-hosted games (sources outside this repo)

A game's module sources do **not** have to live in this repo. This repo is the
pipeline; a game whose notes are already Obsidian-synced can keep its config and
source tree beside those notes and never be committed here at all:

```text
03 Oneshots/<Game>/
├── <Game>.md                       # GM index note
├── Advert.md                       # GroupFlows recruitment post
├── Assets/Maps/                    # Player + DM PNGs, .dd2vtt
└── Foundry/
    ├── <slug>.config.json          # no srcDir key — pass --src instead
    ├── maps/                       # render_map.py specs
    └── src/{actors,items,journals,scenes,tables}/
```

Build it by pointing both flags at the vault:

```bash
node scripts/content/build.mjs \
  --config "<vault>/03 Oneshots/<Game>/Foundry/<slug>.config.json" \
  --src    "<vault>/03 Oneshots/<Game>/Foundry/src"
```

Omit `srcDir` from a vault-hosted config — it resolves under `content/` and
would silently point at the wrong tree. Output still lands in
`content/dist/<id>/` (gitignored), so `sync-content.sh` is unchanged. For maps,
`map-to-scene.sh --scenes-dir <vault>/.../Foundry/src/scenes` writes the Scene
next to the other sources.

Both models work. In-repo (`new-game.sh`) keeps a game versioned with the
tooling; vault-hosted keeps the repo purely about process.

## Scenes as code

Two routes put a map into the compendium.

**Full battlemap (walls + lights + doors) — recommended.** Generate the map,
then convert its `.dd2vtt` into a Scene document:

```bash
python3 scripts/maps/render_map.py <spec>.json <outdir>
node scripts/content/dd2vtt-to-scene.mjs "<outdir>/<name>.dd2vtt" \
  --background "DnD/<game>/Assets/Maps/<name> - Player.webp" \
  --out content/src-<slug>/scenes/<name>.json
# or both steps at once:
scripts/maps/map-to-scene.sh <spec>.json <slug> --outdir <dir> --background <src>
```

The converter reads the **same `.dd2vtt` the Universal Battlemap Importer
consumes**, so the scene gets the same walls (from `line_of_sight`), doors
(`portals`), and lights — but git-durable and imported as part of the module,
not a separate UI step. `build.mjs` keys the embedded walls/lights via the
`scenes` entry in its `EMBEDDED` map.

**GM map pins.** `map-to-scene.sh` also passes the spec's numbered `keys` —
the ones `render_map.py` draws as circles on the DM PNG — through
`dd2vtt-to-scene.mjs --keys ... --keys-journal ...`. That emits a GM-only
`<Scene> — GM Keys` journal (one page per key) into the module's `journals/`,
plus a scene `Note` pinned at each key linking to its page. Clicking pin 4 in
the VTT opens key 4, with the same numbering as the DM image, so the GM stops
cross-referencing a PNG mid-session. The pages carry `ownership.default: 0`
because keys routinely hold the scene's secrets, and Foundry hides a pin whose
journal the player cannot see.

> Foundry v13 removed the automatic migration of the legacy `Note#icon` string
> to `Note#texture.src`, so the pins are emitted with `texture.src`. Don't
> "simplify" that back to `icon` — the pin would import without its marker.

**Scene stub (no walls).** Author a scene JSON by hand in
`content/src-<slug>/scenes/` with just a `background.src` — the git-durable route
when you don't need dynamic walls/lights.

**The compendium ships no image.** `--background` (and a `background.src`) is a
Foundry **Data-relative** path to an image already under the Foundry data dir —
the vault is bind-mounted at `/data/Data/DnD`, so a vault map at
`DnD/<game>/Assets/Maps/<file>` resolves. **Online / hybrid:** the PNG must sit
on the **host that serves Foundry** (remote players load it over the tunnel),
not only in the devcontainer.

**Baked light — use `--no-lights` for `render_map` maps.** `render_map.py` bakes
its lighting into the Player PNG *and* emits dynamic lights, so importing both
double-lights the scene. For generated maps, pass `--no-lights`: ship the
baked-lit image with walls only (add dynamic lights by hand if you want them).
Keep lights for dd2vtt from sources that don't bake light in.

**Automate, then refine by hand.** The converted scene is a *base* — walls,
lights, and doors auto-placed. Tune lighting/darkness, add ambient sounds or
note pins in the VTT afterwards. Hand-refinements are **per-world and do not
round-trip back**: re-import only when the map itself changes, not over a scene
you've already hand-tuned (re-import replaces the compendium copy; a scene
already dragged into a world is a separate copy). Map **keys → clickable note
pins** is a planned follow-on.

## Stat blocks: compile, don't transcribe

A vault NPC note carries a ```statblock fence — the in-person artifact, rendered
as a printable card by Fantasy Statblocks. It already holds every field the
Foundry actor needs, so the actor is **compiled** from it rather than retyped:

```bash
node scripts/content/statblock.mjs "<vault>/03 Oneshots/<Game>/NPCs/Selyse.md" \
  --srd content/reference/srd-51.json \
  --out "<vault>/03 Oneshots/<Game>/Foundry/src/actors/selyse.json"
```

One note in, one actor out. The actor's **name comes from the filename**, not
the fence's `name:` — a card headed "Selyse (Lamia)" becomes an actor called
"Selyse". Token disposition comes from the note's frontmatter (`hostile` by
default, or `neutral` / `friendly`), because "starts the session as an ally" is
a fact about this NPC, not about the shared SRD stat line.

This replaces the NPC template's old instruction that *Claude* compiles the
actor JSON by hand. That was the most repeated step in the pipeline and the only
one nothing checked.

### Proficiency vs expertise

Bonuses are written the way the stat block prints them (`deception: 7`), but
dnd5e does not store bonuses — it stores a proficiency multiplier and derives
the number. The compiler works out which multiplier produces the stated bonus
from the ability score and the CR-derived proficiency bonus.

This matters more than it sounds. Selyse is CHA 16 (+3) at CR 4 (PB +2), and her
card says Deception **+7** — that is expertise (3 + 2×2). Storing `value: 1`
gives +5 at the table while the printed card says +7, and nothing catches the
drift. Compiling this found exactly that bug in three shipped actors.

Where a bonus is not reachable from any multiplier, the remainder is stored as a
flat `bonuses.check` **and warned about**, since that case is usually a typo.

### Checking against the SRD base

`source: SRD 5.1 (CC-BY-4.0) — Lamia` names the base creature. With `--srd`
pointing at a cache index, the compiler diffs the fence against it.

Divergence is *expected* — a named NPC built on a Spy is meant to differ — so a
difference is reported as a **delta for a human to read, never an error**. Mark
the intentional ones with `deviations: [hp, ac]` in the fence, which keeps them
visible in review rather than invisible; `exact: true` promotes any remaining
delta to an error.

Fields the cache cannot supply are skipped, not failed. Armour-wearing monsters
have no stored AC (see below), and treating that as a mismatch would flag every
one of them.

## SRD reference cache

`scripts/content/srd-cache.mjs` distils the dnd5e system's SRD monster packs
into a small committed index used to inherit token art and to check authored
stat blocks against the base creature they were written from. Run it on the
**host** — it reads the Foundry data dir, which the devcontainer does not mount
— and re-run it after a system upgrade:

```bash
docker compose stop foundry          # LevelDB is single-process; see below
node scripts/content/srd-cache.mjs \
  --art "$DND_VAULT_PATH/06 Assets/Tokens/srd"
docker compose up -d
```

**Foundry must be stopped.** Compendium packs are LevelDB directories, and
LevelDB takes an exclusive lock: a running Foundry holds every pack open, so
reading them from outside fails. The raw errors name nothing useful — the CLI
reports `Iterator is not open: cannot call next() after close()` and
classic-level reports `Database is not open`, both of which look like corruption
rather than a lock. The scripts now detect this and say so.

That writes `content/reference/srd-51.json` (SRD 5.1, `dnd5e.monsters`) and
`srd-52.json` (SRD 5.2 / 2024 rules, `dnd5e.actors24`). Both editions are
indexed because a statblock note cites which one it was written from
(`source: SRD 5.1 (CC-BY-4.0) — Lamia`), and the 2014 and 2024 stat lines
genuinely differ. No network access and no running Foundry server: it opens the
compendium LevelDB directly.

`--art` also copies each creature's token image into the vault. This is not
optional decoration — a `systems/dnd5e/tokens/...` path resolves inside Foundry
only, so without a real file in the vault the printed Fantasy Statblocks card
has no portrait. One copy in `06 Assets/Tokens/srd/` serves both surfaces:
Obsidian by vault path, Foundry Data-relative through the existing mount.

Two things to know about the cached data:

- **It is the document as stored, not as Foundry derives it.** Armour-wearing
  monsters therefore have no numeric AC — Bandit stores
  `{calc: "default", flat: null}` and its 12 is computed at runtime from
  equipped Leather Armor plus a Dex modifier. The cache records the calc mode
  and leaves `ac` absent; a missing `ac` means *not checkable*, never *AC 0*.
- **It is CC-BY-4.0 content.** Attribution and the exact scope of what is
  cached live in [`content/reference/LICENSE.md`](../content/reference/LICENSE.md).
  Regenerate the files rather than editing them.

## Rules that bite

- **IDs derive from the source path** (sha256 of e.g.
  `actors/harbormaster-vela.json`, first 16 hex chars). Renaming a file
  changes its compendium ID — a re-import then creates a duplicate instead of
  updating. Name files well the first time.
- **Cross-links**: get the full
  `@UUID[Compendium.<module-id>.<pack>.<Type>.<id16>]{Name}` string with
  `node scripts/content/uuid.mjs actors/FILE.json ["Display Name"]`.
  The build fails on links to this module whose id matches no source file;
  links into other compendia (dnd5e SRD etc.) are left alone.
- **Roll tables** use the Foundry v13 result shape (`"type": "text"`,
  `"description"`); GM-only journal pages get `"ownership": { "default": 0 }`.
- **Scenes don't ship images** — `background.src` must point at an image
  already under the Foundry data dir.
- **Tick "Keep Document IDs" on every import.** Without it, scene map pins
  render but open nothing. `Note.entryId` stores a plain *world* document id,
  which this pipeline derives deterministically via `docId()`; on a normal
  import Foundry assigns the JournalEntry a fresh random id, so the pin points
  at a document that does not exist. Embedded ids (journal *pages*) survive
  either way — which is exactly why the pin's `pageId` resolves while its
  `entryId` dangles, and why the symptom looks like a broken journal rather
  than a broken import. Verified on Foundry 14.364: entry `e86544d245c8371b`
  came back as `tuFvVouFTWaqtiuG`, while page `b76074d6ad82a046` was preserved.
  Re-importing *without* the box ticked adds duplicates alongside the correct
  copies rather than replacing them; delete the randomly-id'd ones.
- **Re-import overwrites the compendium copy only.** Documents already
  dragged into a world are separate copies; update those in the UI or via
  foundry-mcp.
- Content tooling deps live in `scripts/content/package.json` — never in the
  repo root `package.json` (it belongs to the container launcher).

## Routing: skill vs foundry-mcp

The MCP bridge stays for what genuinely needs a live world: dice requests,
token movement, conditions, scene activation, reading world state, and
editing documents already imported into a world. Full routing table in
[`CLAUDE.md`](../CLAUDE.md), "Content routing".

A PreToolUse hook enforces this: `dnd5e-create-npc` and `create-quest-journal`
are denied with a pointer to the skill. The **foundry-gm plugin** ships this
hook; a local copy (`scripts/hooks/foundry-mcp-guard.sh`, wired in
`.claude/settings.json`) is kept until the plugin hook is confirmed in a
session (both deny identically). For a genuine live-session one-off:

```bash
touch .ai/foundry-live-session    # per-checkout flag; delete when the session ends
# or
export FOUNDRY_MCP_WRITES=allow   # per-shell, before launching claude
```

Sessions that never touch a live game: disable the foundry-mcp server (`/mcp`
toggle) — its tool schemas are pure token overhead there.

## Sample content

`content/src/actors/harbormaster-vela.json`,
`content/src/journals/harbor-district-primer.json`, and
`content/src/tables/harbor-rumors.json` are the seed examples — a
cross-linked NPC + journal pair plus a rumor table that double as the
pipeline smoke test.

## Tests

```bash
cd scripts/content && node --test
```

Unit tests plus a LevelDB round-trip (`compilePack` → `extractPack`). Run
after any change to `build.mjs`.

`srd-cache.mjs` is covered by unit tests over fixtures taken from real stored
SRD documents, so its distillation logic is checked here even though generating
an actual cache needs a host Foundry install.
