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

```
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
