---
name: foundry-content
description: Author FoundryVTT campaign content (dnd5e NPCs, items, quest journals, scenes) as JSON in the repo and compile it into the troubled-waters-content compendium module. Use for bulk or offline content creation — "create NPCs", "write quest journals", "bulk content", "add items/loot", "prep encounter content". Do NOT use for live-play operations (dice requests, token movement, scene activation, conditions) — those need the foundry-mcp server.
---

# Foundry Content Authoring (content-as-code)

Compile campaign content from `content/src/` into a Foundry compendium module.
Token-cheap replacement for foundry-mcp content tools: copy a template, edit
fields, build, hand off one host command.

## Workflow

1. **Copy a template — never write document JSON from scratch.**
   Templates: `.claude/skills/foundry-content/templates/{npc,item,journal,scene}.json`
   Destination: `content/src/{actors,items,journals,scenes}/<kebab-name>.json`
   Edit only the fields you need; `REPLACE` markers show the minimum. Unknown
   dnd5e fields are defaulted by Foundry on import — do not invent schema.
2. **Build:** `node scripts/content/build.mjs`
   Compiles to `content/dist/troubled-waters-content/`. Fails with file+field
   on invalid sources. Run `npm --prefix scripts/content install` once if
   node_modules is missing.
3. **Sync (USER runs on HOST, not in devcontainer):**
   `scripts/content/sync-content.sh --test` — test instance first (needs
   `FOUNDRY_TEST_DATA_PATH` set)
   `scripts/content/sync-content.sh` — production data dir
   Tell the user to run this; you cannot.
4. **Import (user, in Foundry UI):** enable "Troubled Waters Content" module
   in the world (Game Settings → Manage Modules — packs are invisible until
   enabled), open Compendium Packs, import documents. Pack-content changes
   need a world reload; module.json changes need a world relaunch.

## Rules

- One document per file. Filename = kebab-case document name
  (`grimtooth-the-fence.json`). IDs are derived from the path — renaming a file
  changes its compendium ID and a re-import creates a duplicate.
- Cross-links in journal text:
  `@UUID[Compendium.troubled-waters-content.actors.Actor.<id16>]{Name}` —
  `<id16>` = first 16 hex chars of sha256 of the source path relative to
  `content/src` (e.g. `actors/grimtooth-the-fence.json`). Compute:
  `node -e "console.log(require('crypto').createHash('sha256').update('actors/FILE.json').digest('hex').slice(0,16))"`
- Scenes: `background.src` must point at an image that already exists under the
  Foundry data dir (e.g. `worlds/<world>/maps/*.webp`). This skill does not
  generate or upload images.
- Tests: `cd scripts/content && node --test` after changing build.mjs.
- Never touch the repo root package.json; content deps live in
  scripts/content/package.json.

## When NOT to use this skill

Live session work — rolling dice, moving/updating tokens, toggling conditions,
switching scenes, checking current game state. Use the foundry-mcp tools.
Editing documents already imported into a world — compendium re-import
overwrites the compendium copy only; world copies must be updated in the UI or
via foundry-mcp.

Note: a PreToolUse hook (`scripts/hooks/foundry-mcp-guard.sh`) denies the
foundry-mcp content-creation tools (`dnd5e-create-npc`, `create-quest-journal`)
and points back here. If the user explicitly wants a live-session one-off,
they can override with `touch .ai/foundry-live-session` or
`FOUNDRY_MCP_WRITES=allow` — do not work around the guard yourself.
Routing table: `CLAUDE.md` "Content routing"; pipeline doc:
`docs/CONTENT_AUTHORING.md`.
