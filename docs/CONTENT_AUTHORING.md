# Content authoring (content-as-code)

Campaign content — dnd5e NPCs, items, quest journals, scenes — is authored as
JSON files in the repo and compiled into the **Troubled Waters Content**
compendium module. This replaces the foundry-mcp content-creation tools for
anything bulk or offline: it costs a fraction of the tokens (no MCP tool
schemas or JSON results in Claude's context), every document is versioned in
git, and content survives world rebuilds because it lives in a module, not the
world database.

## Pipeline

```
content/src/*.json  --build-->  content/dist/troubled-waters-content/  --sync (host)-->  Data/modules/  --import-->  world
```

1. **Author** (Claude, in the devcontainer): the `foundry-content` skill
   (`.claude/skills/foundry-content/`) copies a template from
   `templates/{npc,item,journal,scene}.json` into
   `content/src/{actors,items,journals,scenes}/<kebab-name>.json` and edits
   the needed fields. Templates are minimal on purpose — Foundry defaults
   every omitted dnd5e field on import.
2. **Build** (Claude, in the devcontainer):

   ```bash
   node scripts/content/build.mjs
   ```

   Validates every source file (fails with file + field), assigns
   deterministic IDs, and compiles LevelDB packs plus `module.json` into
   `content/dist/troubled-waters-content/`. One-time setup:
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
- **Cross-links**:
  `@UUID[Compendium.troubled-waters-content.actors.Actor.<id16>]{Name}` —
  compute `<id16>` with
  `node -e "console.log(require('crypto').createHash('sha256').update('actors/FILE.json').digest('hex').slice(0,16))"`.
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

A PreToolUse hook (`scripts/hooks/foundry-mcp-guard.sh`, wired in
`.claude/settings.json`) enforces this: `dnd5e-create-npc` and
`create-quest-journal` are denied with a pointer to the skill. For a genuine
live-session one-off:

```bash
touch .ai/foundry-live-session    # per-checkout flag; delete when the session ends
# or
export FOUNDRY_MCP_WRITES=allow   # per-shell, before launching claude
```

Sessions that never touch a live game: disable the foundry-mcp server (`/mcp`
toggle) — its tool schemas are pure token overhead there.

## Sample content

`content/src/actors/harbormaster-vela.json` and
`content/src/journals/harbor-district-primer.json` are the seed examples — a
cross-linked NPC + journal pair that double as the pipeline smoke test.

## Tests

```bash
cd scripts/content && node --test
```

Unit tests plus a LevelDB round-trip (`compilePack` → `extractPack`). Run
after any change to `build.mjs`.
