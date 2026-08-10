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
   ./scripts/content/sync-content.sh --test   # test instance (FOUNDRY_TEST_DATA_PATH)
   ./scripts/content/sync-content.sh          # production data dir
   ```

4. **Import** (you, in the Foundry UI): enable the "Troubled Waters Content"
   module in the world (Game Settings → Manage Modules — packs are invisible
   until the module is on), open Compendium Packs, import documents.
   Pack-content changes need a world reload; `module.json` changes need a
   world relaunch.

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
its own `content/dist/<id>/`. Source-root precedence: explicit `srcRoot` arg >
config `srcDir` > `content/src`. The full lifecycle (spark, author in the vault,
package, play) lives in the vault guide
`examples/vault-skeleton/00 Index/Running a new game.md`.

## Scenes as code

Scenes use `templates/common/scene.json` in `content/src/scenes/`. Set
`background.src` to an image **Foundry can see** — under the mounted vault, e.g.
`/data/Data/DnD/<game>/Assets/Maps/<file>` (the vault is bind-mounted into the
Foundry container). This is the git-durable route for scene stubs. For maps that
need **walls + lights**, prefer exporting `.dd2vtt` from DungeonMapBuilder and
importing via the Universal Battlemap Importer — see `FOUNDRY_REBUILD.md`.

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
