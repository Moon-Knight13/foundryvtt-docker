# Content authoring (content-as-code)

Campaign content — NPCs, items, quest journals, scenes, roll tables, factions,
encounters — is authored as JSON files and compiled into a compendium module,
one module per game. This replaces the foundry-mcp content-creation tools for
anything bulk or offline: it costs a fraction of the tokens (no MCP tool schemas
or JSON results in Claude's context), every document is versioned alongside the
game's notes, and content survives world rebuilds because it lives in a module,
not the world database.

Module identity lives in the game's **`<slug>.config.json`** (`id`, `title`,
`system`, version, ownership). The build and `sync-content.sh` both read it —
change the module there, not in scripts. Omit `system` for a system-agnostic
module; set it (`dnd5e` for the games here) to bind packs to a system.

> **This repo owns no game.** There is no default module config and no default
> source tree: `build.mjs` and `sync-content.sh` both **require `--config`**, and
> the build requires `--src` unless the config carries a `srcDir`. Every example
> below therefore names a game. The one that lives in this repo,
> [`examples/demo-game/`](../examples/demo-game/), is **Ashwake Hollow** — an
> invented oneshot that exists only as a documentation subject and pipeline smoke
> test. Real games live in the vault; see `docs/PROJECT.md`.

## Pipeline

```text
<game>/Foundry/src/*.json  --build-->  content/dist/<module-id>/  --sync (host)-->  Data/modules/  --import-->  world
```

1. **Author** (Claude, in the devcontainer): the `foundry-content` skill —
   shipped by the **foundry-gm** plugin (`/plugin install
   foundry-gm@foundry-gm-marketplace`) — copies a template —
   system-agnostic: `templates/common/{journal,scene,roll-table,faction,encounter}.json`;
   dnd5e: `templates/dnd5e/{npc,item}.json` — into
   the game's `Foundry/src/{actors,items,journals,scenes,tables}/<kebab-name>.json`
   and edits the needed fields (factions and encounters are journal documents).
   Templates are minimal on purpose — Foundry defaults every omitted system
   field on import.
2. **Build** (Claude, in the devcontainer):

   ```bash
   node scripts/content/build.mjs \
     --config "<vault>/03 Oneshots/<Game>/Foundry/<slug>.config.json" \
     --src    "<vault>/03 Oneshots/<Game>/Foundry/src"
   ```

   Both flags are required (`--src` may be replaced by a `srcDir` in the config
   for the in-repo layout). Validates every source file (fails with file +
   field), validates `@UUID`
   cross-links against staged sources (broken links fail the build), assigns
   deterministic IDs, and compiles LevelDB packs plus `module.json` into
   `content/dist/<module-id>/`. One-time setup:
   `npm --prefix scripts/content install`.
3. **Sync** (you, on the HOST — the devcontainer cannot reach the Foundry
   data dir):

   ```bash
   ./scripts/content/sync-content.sh --config "<same config>"   # into $FOUNDRY_DATA_PATH
   ```

4. **Import** (you, in the Foundry UI): enable the game's module
   in the world (Game Settings → Manage Modules — packs are invisible
   until the module is on), open Compendium Packs, import documents — with
   **"Keep Document IDs" ticked**, or scene map pins will render but open
   nothing (see *Rules that bite*).
   Pack-content changes need a world reload; `module.json` changes need a
   world relaunch. **If Foundry runs in a container, restart it after syncing**
   (`docker compose restart`) — Foundry opens compendium (LevelDB) packs at
   container start, so a world reload alone keeps serving the old pack from open
   file handles; a stale/half-swapped pack shows old data or fails to import.

## Multiple modules — one per game (one repo, N games)

Every **game** (oneshot or campaign) gets its **own** module — its own config and
its own source tree — so its compendium is a separate module you enable only in
that game's world. Neither `build.mjs` nor `sync-content.sh` has a default: both
take `--config`, and the build takes `--src` (or reads `srcDir` from the config).

### Scaffold a new game's module

Don't hand-write the config. Run:

```bash
scripts/content/new-game.sh <slug> [--type oneshot|campaign] [--system <sys>] \
  [--title "<Title>"] [--vault <path>] [--in-repo]
# e.g. scripts/content/new-game.sh harborwatch --type campaign --system dnd5e
```

By default the game lives **in the vault**: the script scaffolds the note
folders plus a `Foundry/` tree (`<slug>.config.json` + empty
`src/{actors,items,journals,scenes,tables}/`) under `--vault` (default
`$DND_VAULT_PATH`, else `$HOME/DnD`), then prints the build + sync commands.
`--in-repo` is the legacy mode: it writes `content/<slug>.config.json` and
`content/src-<slug>/` inside the repo instead. It refuses to overwrite an
existing config. Omit `--system` for a system-agnostic module.

### Naming convention (locked)

| Thing | Rule |
| --- | --- |
| config file | `content/<slug>.config.json` |
| `srcDir` | `src-<slug>` (dir under `content/`) |
| module `id` | `<slug>-oneshot` or `<slug>-campaign` |
| `packLabelPrefix` | the game's title |
| `system` | per game; omit for system-agnostic |

The table describes the **in-repo** layout (`new-game.sh --in-repo`). A
vault-hosted game — the default — names its config `Foundry/<slug>.config.json`
beside the notes, omits `srcDir` entirely, and is built with `--src`.

### Build + sync a specific module

```bash
node scripts/content/build.mjs    --config content/<slug>.config.json
./scripts/content/sync-content.sh --config content/<slug>.config.json   # on the host
```

The demo game ships the vault-hosted shape in miniature:

```bash
node scripts/content/build.mjs \
  --config examples/demo-game/ashwake-hollow.config.json \
  --src    examples/demo-game/src
```

`srcDir` is a directory under `content/`; each module builds into its own
`content/dist/<id>/`. Source-root precedence: `--src` / explicit `srcRoot` arg >
config `srcDir` > **error**. There is no third tier: a build that names neither
has nothing to compile, and saying so beats silently compiling whatever happens
to sit in `content/src`. The full lifecycle (spark,
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

Both models work. Vault-hosted (the `new-game.sh` default) keeps the repo
purely about process; in-repo (`new-game.sh --in-repo`) keeps a game
versioned with the tooling.

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

**Key links.** A spec key may carry `links` — curated module source paths,
never inferred from the note text (same philosophy as the art map):

```json
{ "n": 4, "label": "Rook's landing", "note": "SECRET: …",
  "links": ["actors/rook-vantle.json", "actors/bandit.json"] }
```

Each renders on the key's page as a **Related:** row of `@UUID` references,
so pin 4 opens straight onto Rook's actor sheet, the relevant handout, or
another journal. Links need the module id, so pass `--config` (and the
converter reads each linked file's `name` for the display text — pass
`map-to-scene.sh --config <game config>`, which also derives `--src` from the
scenes dir). A typo'd path fails the conversion immediately, and `build.mjs`'s
link validation would catch it again at build. Regenerating after editing only
`links` changes just the journals — scenes are byte-identical, so in Foundry
you re-import the GM Keys journals alone (Keep Document IDs) and existing pins
keep resolving.

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
already dragged into a world is a separate copy).

## Stat blocks: compile, don't transcribe

A vault NPC note carries a ```statblock fence — the in-person artifact, rendered
as a printable card by Fantasy Statblocks. It already holds every field the
Foundry actor needs, so the actor is **compiled** from it rather than retyped:

```bash
node scripts/content/statblock.mjs "<vault>/03 Oneshots/<Game>/NPCs/<NPC>.md" \
  --srd content/reference/srd-51.json \
  --out "<vault>/03 Oneshots/<Game>/Foundry/src/actors/<npc>.json"
```

One note in, one actor out. The actor's **name comes from the filename**, not
the fence's `name:` — a card headed "Vashti (Lamia)" becomes an actor called
"Vashti". Token disposition comes from the note's frontmatter (`hostile` by
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

This matters more than it sounds. An NPC built on the SRD **Lamia** is CHA 16
(+3) at CR 4 (PB +2), and its card says Deception **+7** — that is expertise
(3 + 2×2). Storing `value: 1` gives +5 at the table while the printed card says
+7, and nothing catches the drift. Compiling one real game's six actors found
exactly that bug in three of them.

Where a bonus is not reachable from any multiplier, the remainder is stored as a
flat `bonuses.check` **and warned about**, since that case is usually a typo.

### Checking against the published creature

`source: SRD 5.1 (CC-BY-4.0) — Lamia` names the base creature and the edition.
The compiler checks the fence against **two** references, which answer different
questions:

| Reference | Built by | Answers |
| --- | --- | --- |
| `open5e-{2014,2024}.json` | `open5e-cache.mjs` | *is this faithful to the published creature?* |
| `srd-5{1,2}.json` | `srd-cache.mjs` | *will this render correctly in my Foundry?* |

A disagreement between them is information, not an error.

Open5e supplies two things the dnd5e compendium cannot:

- **A numeric AC.** The compendium stores `{calc: "default", flat: null}` for
  armour-wearing creatures and derives AC at runtime, so a Bandit's AC of 12 was
  simply not checkable. Open5e states it.
- **Stated skill bonuses**, in the same form the fence writes them. That catches
  the same class of error as the expertise derivation above, from the other
  side: there the question is *what multiplier yields this bonus?*, here it is
  *is this the bonus the creature actually has?*

**The edition matters, and is not cosmetic.** The 2024 rules restat creatures:
the SRD Lamia is a *monstrosity* with Stealth **+3** in 5.1 and a *fiend* with
Stealth **+5** in 5.2; the SRD Spy is Medium in 5.1 and Small in 5.2. The
compiler picks the index from the `source:` line, so a note written from one
edition is never checked against the other.

Refresh the Open5e caches — network, but nothing else needs it:

```bash
node scripts/content/open5e-cache.mjs
```

That reads the [open5e-api](https://github.com/open5e/open5e-api) fixtures from
GitHub (already reachable; no firewall change) and writes
`content/reference/open5e-{2014,2024}.json`, which are **committed** so builds
and CI stay offline.

### How divergence is reported

Divergence is *expected* — a named NPC built on a Spy is meant to differ — so a
difference is reported as a **delta for a human to read, never an error**. Mark
the intentional ones with `deviations: [hp, ac]` in the fence, which keeps them
visible in review rather than invisible; `exact: true` promotes any remaining
delta to an error.

Fields a reference cannot supply are skipped, not failed: a missing value means
*not checkable*, never *zero*. The dnd5e compendium carries no stated skill
bonuses at all, so those are only compared when Open5e is available.

### Art coverage

An actor with no art still compiles — Foundry requires *some* `img` — but it is
never silent. The compiler warns when it falls back to `icons/svg/mystery-man.svg`,
because a blank silhouette is the most visible way this pipeline can ship
something wrong: fine in the JSON, obviously broken on the map.

The compiler resolves art through a chain, and stops deliberately short:

1. **`image:` in the fence** — always wins. Write it **vault-relative**
   (`03 Oneshots/<Game>/Assets/Tokens/<npc>.webp`) so the same line renders in
   Obsidian's statblock plugin; the compiler adds the `DnD/` mount prefix for
   Foundry. Paths Foundry already understands (`DnD/…`, `icons/…`, `systems/…`,
   `modules/…`, URLs) pass through verbatim.
2. **The SRD base creature's real token** (`source:` + the reference cache) —
   genuinely that creature's art, where the pack ships any (see the measured
   table below: it mostly does not).
3. **The curated icon map** (`content/reference/art-map.json`): a hand-checked
   `byName` match first, then — **for mooks only** — one silhouette per
   creature type in the map's `byType` (most SRD types; extend it by hand as
   gaps appear). The map is curated, never fuzzy-matched: fuzzy matching
   measured 61% apparent coverage while pairing *Adult Gold Dragon* with
   `gold-bar.svg`.
4. **Nothing.** A named NPC that misses the `byName` map resolves to the
   placeholder and its warning — a generic outline on someone you authored
   would hide exactly the gap the coverage gate exists to catch.

**What makes a mook is the note's title matching its base creature** —
`Bandit.md` built on Bandit is a bandit; `Rook Vantle.md` built on Spy is a
character. `source:` presence alone is NOT the test: measured on a real
module, every named NPC there is built on an SRD base, and a `source:` rule
dressed two different named characters in the same spy icon with a green gate.
`art_required: true` refuses the silhouette even for an exact-title mook;
`art_required: false` lets a named NPC accept its base creature's icon or the
silhouette.

The map's icons come from [game-icons.net](https://game-icons.net) (CC-BY 3.0,
pinned to a commit) and are fetched into the vault, not committed here:

```bash
node scripts/content/art-fetch.mjs   # → <vault>/06 Assets/Tokens/generic/<artist>/
```

Idempotent; writes `_attribution.md` beside the icons (CC-BY requires it).

The resolver's picks live only in the compiled JSON — the note itself stays
blank in Obsidian. To make them visible where you read:

```bash
node scripts/content/art-stamp.mjs "<vault>/03 Oneshots/<Game>"
```

writes each **map pick** back into its note as a vault-relative `image:` line
(inserted after `name:`), so Obsidian and Foundry now show the same icon.
Deliberately narrow: only `exact`/`type` map picks are stamped — an author's
existing `image:` line is never rewritten, real SRD art (`systems/…`, which
Obsidian cannot display) is left alone, and a named NPC's gap stays visible.
Idempotent; re-running stamps nothing.

The resolver also supports an optional `raster` tier for `www.dnd5eapi.co`'s
SRD monster PNGs (`art-resolve.mjs` honours a top-level `raster` block in
`art-map.json` when one is present; the committed map has none yet —
`measure-dnd5eapi.mjs` generates it). **Measured 2026-08-19** (post-rebuild,
in-container): 334 of 334 SRD monsters carry an image (100%), and the image
bodies are served directly with HTTP 200 — the feared S3 redirect to a second
host did not materialise. The tier stays off until someone decides mooks
should wear real creature art instead of the curated icons; pasting the
generated block into `art-map.json` with `enabled: true` is the whole switch.

Image-*generation* APIs were also evaluated for the named-NPC gap
(perchance.org, 2026-08-19 verdict): **no official API exists** — the site
serves a Cloudflare JS challenge to every non-browser client, and all client
libraries self-describe as unofficial reverse-engineering. Measured directly:
the community-tutorial endpoint (`/api/generateList.php`) 403s behind a
managed challenge (and returns generator *text*, never images, even when it
worked), and the real image backend (`image-generation.perchance.org`) sits
behind the same wall plus an in-browser ad-verification `userKey` a server
cannot mint. Do not build pipeline steps on it. Generated art remains welcome
the manual way: make the image in any web UI, save it under the game's
`Assets/Tokens/`, add the vault-relative `image:` line.

### Named-NPC art: the standard flow

When the gate stops a game on a named NPC, this is the normal way to close the
gap (first used on a real module's three named NPCs, 2026-08-19):

1. **Ask Claude to draw the token from the note.** The note's `## Appearance`
   and roleplay sections are the brief — write them well and the token draws
   itself. Claude hand-writes a flat-vector SVG portrait: 512 viewBox,
   circular token composition with a coloured rim, bust (or body, for
   non-humanoids) over a scene-appropriate backdrop, the character's tells
   made visible — whatever the note says people notice about them first (a pair
   of gold ear cuffs, eyes lit from inside by a compulsion).
   Obsidian and Foundry both render SVG natively, files are a few KB, and
   revisions are one edit away — "warmer palette", "angrier brows" are cheap
   asks.
2. **File goes in the game's own assets**, named after the character:
   `<Game>/Assets/Tokens/<character-slug>.svg`.
3. **Stamp the note** with the vault-relative line, right after `name:` in the
   statblock fence — `image: 03 Oneshots/<Game>/Assets/Tokens/<slug>.svg` —
   so Obsidian shows it too.
4. **Recompile and rerun the strict gate** — done when it reports
   `no blank tokens`.

Prefer painterly art for a particular face? Generate it in any web UI
(browser use is what the free generators support), save the file in the same
place, same `image:` line — steps 2–4 are identical. The two sources coexist
per-character; swapping later is a one-line change.

### The gate: prove it, not promise it

```bash
node scripts/content/art-coverage.mjs --config <module config> [--src <src>] \
  [--vault <path>] [--strict]
```

Walks the module source and classifies every art slot — actor portrait *and*
token, scene backgrounds, journal image pages. With a vault
(`$DND_VAULT_PATH`), every `DnD/…` path must resolve to a real file. Without
one (CI), those paths are counted `unchecked`, so a green CI report is a schema
statement, **not** a coverage guarantee — run it on the host for the proof.
`--strict` turns failures into a non-zero exit, the same warn-to-fail doctrine
as `exact: true`. Definition of done for a game: `--strict` passes.

### One command per game

```bash
scripts/content/ship-game.sh "$DND_VAULT_PATH/03 Oneshots/<Game>" [--force] [--no-restart]
```

Host-side chain: **compile → art gate (strict) → build → sync → restart
Foundry**. `compile-game.mjs` (usable on its own, also inside the devcontainer)
compiles every `NPCs/*.md` statblock fence and every `Handouts/*.md` image
embed in one pass — only notes newer than their output recompile, one broken
note reports without abandoning the rest. The gate sits *between* compile and
build, so a game with a blank named NPC stops before anything reaches Foundry.
`foundry-base.mjs pull-games` runs the same gate between build and sync for
every game in the manifest.

The raster tier's measurement tool (already run once — see the measured verdict
above — but rerunnable any time the API changes):

```bash
node scripts/content/measure-dnd5eapi.mjs --out /tmp/raster.json
```

counts `image` fields across all SRD monsters on `www.dnd5eapi.co`, probes one
image for redirects, and emits a **disabled** `raster` block to paste into
`art-map.json` if the numbers justify it.

## Handout art: showable in Foundry

Until now every journal page this pipeline produced was `type: "text"`, so art
could not be shared in-world at all. `handout.mjs` fixes that:

```bash
node scripts/content/handout.mjs "<vault>/03 Oneshots/<Game>/Handouts/<Note>.md"
```

It reads the note's image embeds — Obsidian `![[art.webp|caption]]` wikilinks or
standard `![caption](art.webp)` — resolves each filename against the game's
`Assets/` and then the wider vault, and emits a journal of **image pages** into
`Foundry/src/journals/`. In Foundry the GM right-clicks a page → **Show to
Players**; `player_visible: true` in the frontmatter makes it Observer-level so
players can reopen it later. `player_visible: false` keeps it GM-only.

**Images only, on purpose.** *Notes to the table* states the rule: a journal is
owned by one pipe — the SoSly Obsidian Bridge (prose) or the compendium build
(structured) — never both. The bridge already carries handout text, so emitting
prose here would create exactly the duplication that rule forbids. For the same
reason the journal is named `<Note> — Art`, which cannot collide with the
bridge's copy.

`src` is Data-relative (`DnD/03 Oneshots/…/Assets/Art/x.webp`), resolved at
runtime through the vault mount — the same convention scene backgrounds use, so
**one file serves the printed handout and the Foundry page**. Commented-out
embeds are ignored, and an embed whose file cannot be found is an error rather
than a silently blank frame at the table.

### Where art lives

`new-game.sh` scaffolds three asset folders, and the distinction matters:

| Folder | For | Source |
| --- | --- | --- |
| `Assets/Maps/` | battlemaps | `render_map.py` |
| `Assets/Tokens/` | per-NPC token art | SRD (`srd-cache.mjs --art`) or your own, pointed at by `image:` in a fence |
| `Assets/Art/` | full illustrations to show players | yours — the SRD ships token art only, which does not enlarge well |

Plus one vault-wide folder, shared by every game:

| Folder | For | Source |
| --- | --- | --- |
| `06 Assets/Tokens/generic/` | curated icons and type silhouettes for mooks | `art-fetch.mjs`, from the committed `art-map.json` |

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

### How much SRD art actually exists

Measured against a real dnd5e install (system 5.3.3), and it is far less than
the phrase "inherit the SRD token art" suggests:

| Pack | Creatures | Real art | Generic stand-in | Ship no art | Randomised art not installed |
| --- | --- | --- | --- | --- | --- |
| `dnd5e.monsters` (SRD 5.1) | 346 | **0** | 0 | 346 | 0 |
| `dnd5e.actors24` (SRD 5.2) | 431 | **2** | 12 | 383 | 34 |

An earlier version of this table said the 2024 pack copied 14 usable images. It
does copy 14 files — but twelve of them are **byte-identical**: one 8 KB
humanoid SVG shipped under twelve different NPC names (Akra, Aoth, Beiro, …).
`copyArt` now hashes what it copies and counts a file whose bytes serve three
or more creatures as `generic`, not as art. Real coverage is **2 of 431**.

The legacy SRD pack ships **no token art at all**. The 2024 pack ships a little,
and points at rather more inside `modules/dnd-monster-manual/` — the paid
official module — using *wildcard* paths like
`.../tokens/awakened-shrub-*.webp`, which Foundry expands at runtime to
randomise a token. `srd-cache.mjs` expands those too, so they resolve for anyone
who owns that module and are reported as unavailable for anyone who does not.

**So SRD inheritance is a bonus, not the plan.** For a named NPC, expect to
supply art yourself in the game's `Assets/Tokens/` and point `image:` at it. The
compiler's placeholder warning is there precisely because most creatures will
not inherit anything.

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
  `actors/rook-vantle.json`, first 16 hex chars). Renaming a file
  changes its compendium ID — a re-import then creates a duplicate instead of
  updating. Name files well the first time.
- **Cross-links**: get the full
  `@UUID[Compendium.<module-id>.<pack>.<Type>.<id16>]{Name}` string with
  `node scripts/content/uuid.mjs --config <game config> actors/FILE.json
  ["Display Name"]`. `--config` is **required**: the link names a module, and a
  link naming the wrong one resolves to nothing in the VTT.
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
- Content tooling deps live in `scripts/content/package.json` — keep them
  there; the repo root deliberately has no `package.json`.

## Routing: skill vs foundry-mcp

The MCP bridge stays for what genuinely needs a live world: dice requests,
token movement, conditions, scene activation, reading world state, and
editing documents already imported into a world. Full routing table in
[`docs/PROJECT.md`](PROJECT.md), "Content routing".

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

[`examples/demo-game/`](../examples/demo-game/) holds **Ashwake Hollow**, an
invented oneshot that exists only to be an example. Its three sources —
`src/actors/rook-vantle.json`, `src/journals/hollow-primer.json` and
`src/tables/hollow-rumours.json` — are a cross-linked NPC + journal pair plus a
rumour table, the smallest set that exercises document validation, `@UUID` link
validation and pack compilation. They double as the pipeline smoke test:

```bash
node scripts/content/build.mjs \
  --config examples/demo-game/ashwake-hollow.config.json \
  --src    examples/demo-game/src
```

No real game's content lives in this repo. See `docs/PROJECT.md`, "This repo is
the pipeline, not the content".

## Tests

```bash
cd scripts/content && node --test
```

Unit tests plus a LevelDB round-trip (`compilePack` → `extractPack`). Run
after any change to `build.mjs`.

`srd-cache.mjs` is covered by unit tests over fixtures taken from real stored
SRD documents, so its distillation logic is checked here even though generating
an actual cache needs a host Foundry install.
