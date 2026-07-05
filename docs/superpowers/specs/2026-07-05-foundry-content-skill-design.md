# Foundry Content Skill — Design

Date: 2026-07-05
Status: Approved (brainstorming session)

## Problem

Bulk world-content authoring (NPCs, items, journals, scenes) currently goes through the
`foundry-mcp` MCP server. MCP tool results are verbose JSON that persists in the session
context (~10% of token usage), and the tool surface is fixed. Foundry has no REST API —
its documented API (https://foundryvtt.com/api/) is a client-side JavaScript API — so the
alternative for offline authoring is the official `@foundryvtt/foundryvtt-cli`, which
reads/writes compendium pack databases directly.

Constraint: the devcontainer mounts only `/workspace`. The live Foundry data directory
(`$FOUNDRY_DATA_PATH`, default `~/.local/share/FoundryVTT`) is host-only. The skill
therefore cannot (and must not) touch live world databases.

## Approach (chosen: thin skill + templates)

Content-as-code: author content as one-JSON-file-per-document in the repo, compile into a
compendium **module** with the official Foundry CLI, sync the built module to the host
data directory with a host-run script, and import from compendia in the Foundry UI.

Rejected alternatives:
- Full custom toolkit CLI with dnd5e schema validation — most robust, but days of work and
  dnd5e schema drift makes it a maintenance burden. Grow toward it later if needed.
- Skill that only documents raw `fvtt` commands — no scaffolding, plumbing redone every
  session, token waste returns.
- Mounting the Foundry data dir into the devcontainer for direct world edits — live-DB
  corruption risk, devcontainer rebuild, host coordination. Out of scope for v1.

## Layout

```
content/
  src/actors/*.json        # one dnd5e NPC per file
  src/items/*.json
  src/journals/*.json
  src/scenes/*.json
  dist/                    # built module output (gitignored)
.claude/skills/foundry-content/
  SKILL.md                 # project skill
  templates/               # known-good JSON skeletons: npc, item, journal, scene
scripts/content/
  package.json             # isolated deps: @foundryvtt/foundryvtt-cli (NOT the image's package.json)
  build.mjs                # compile src -> LevelDB packs + module.json into content/dist/
  sync-content.sh          # HOST-run: rsync content/dist/<module> into Foundry data modules dir
```

Sources are committed; `content/dist/` (binary LevelDB) is gitignored. `/workspace` is a
host bind mount, so the built `dist/` is already on host disk — the sync script only
copies it into the data directory.

## Components

### build.mjs
- Uses `@foundryvtt/foundryvtt-cli` as a library (`compilePack`).
- Validates each source file: well-formed JSON plus required fields per type
  (`name`, `type` for actors/items; `name`, `pages` for journals; `name` for scenes).
- Injects deterministic `_id` (16-char hash of relative source path) and `_key`
  (`!<collection>!<id>`) so rebuilds are stable and re-imports don't duplicate.
- Writes `module.json`: id `troubled-waters-content`, title "Troubled Waters Content",
  four pack entries (Actor, Item, JournalEntry, Scene), `relationships.systems: dnd5e`,
  `compatibility.verified: 13`.
- Fails loudly: prints offending file and missing field, non-zero exit.

### sync-content.sh (host-run)
- Rsyncs `content/dist/troubled-waters-content/` into
  `$FOUNDRY_DATA_PATH/Data/modules/` (env var or `--data <path>` flag).
- `--test` flag targets the test-instance data directory instead of production.
- `--dry-run` passthrough. Refuses to run if `dist` is missing/empty.
- Never reads `.env` secrets; only needs the data path.

### SKILL.md
Teaches Claude:
- When to use: bulk/offline content authoring. When NOT to: live-play operations
  (dice requests, token moves, scene activation) — those stay on foundry-mcp.
- Copy-template-never-freehand rule: always start from `templates/*.json`, edit fields
  only. Keeps dnd5e schema valid and avoids regenerating boilerplate (token win).
- Commands: build, sync (remind user it runs on host), import steps in the Foundry UI.
- Scene rule: image paths must reference assets already in the data dir; the skill does
  not generate maps.

## Data flow

1. Claude copies a template, edits fields, saves under `content/src/<type>/`.
2. `node scripts/content/build.mjs` (devcontainer) -> `content/dist/troubled-waters-content/`.
3. User on host: `scripts/content/sync-content.sh --test` first; production once verified.
4. Foundry UI: enable module in world, import documents from its compendia.
   Pack-content changes need only a world reload; `module.json` changes need a restart.

## Error handling

- Build: per-file validation errors with path + field; malformed JSON reported with file.
- Sync: missing dist, missing data path -> clear error, exit 1.
- Import-time dnd5e schema errors are surfaced by Foundry; fix source, rebuild, resync.

## Testing

- Round-trip test: build, then `extractPack` the output, compare document count and
  names/ids against sources.
- Templates validated once against a real dnd5e world export before committing.
- `sync-content.sh --dry-run` exercised in CI-less shell test (bats or plain sh assert).

## Out of scope (v1)

- Editing existing world documents (requires data mount or live API).
- Map/image generation.
- dnd5e deep schema validation.
- Automatic import into a world (Foundry offers no headless import).
