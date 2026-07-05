---
name: foundry-content
description: Author FoundryVTT campaign content (NPCs, items, quest journals, scenes, roll tables, factions, encounters) as JSON in the repo and compile it into the content compendium module. Use for bulk or offline content creation — "create NPCs", "write quest journals", "bulk content", "add items/loot", "prep encounter content", "make a rumor table". Do NOT use for live-play operations (dice requests, token movement, scene activation, conditions) — those need the foundry-mcp server.
---

# Foundry Content Authoring (content-as-code)

Compile campaign content from `content/src/` into a Foundry compendium module.
Token-cheap replacement for foundry-mcp content tools: copy a template, edit
fields, build, hand off one host command.

Module identity (id, title, system) lives in `content/content.config.json` —
the build reads it; never hardcode the module id in tooling. This repo's
module is `troubled-waters-content` on dnd5e. Omitting `system` in the config
makes the packs system-agnostic.

## Workflow

1. **Copy a template — never write document JSON from scratch.**
   System-agnostic templates: `.claude/skills/foundry-content/templates/common/{journal,scene,roll-table,faction,encounter}.json`
   dnd5e templates: `.claude/skills/foundry-content/templates/dnd5e/{npc,item}.json`
   Destination: `content/src/{actors,items,journals,scenes,tables}/<kebab-name>.json`
   (factions and encounters are journals — they go in `content/src/journals/`).
   Edit only the fields you need; `REPLACE` markers show the minimum. Unknown
   system fields are defaulted by Foundry on import — do not invent schema.
2. **Build:** `node scripts/content/build.mjs`
   Compiles to `content/dist/<module-id>/`. Fails with file+field on invalid
   sources and on broken `@UUID` cross-links. Run
   `npm --prefix scripts/content install` once if node_modules is missing.
3. **Sync (USER runs on HOST, not in devcontainer):**
   `scripts/content/sync-content.sh --test` — test instance first (needs
   `FOUNDRY_TEST_DATA_PATH` set)
   `scripts/content/sync-content.sh` — production data dir
   Tell the user to run this; you cannot.
4. **Import (user, in Foundry UI):** enable the content module in the world
   (Game Settings → Manage Modules — packs are invisible until enabled), open
   Compendium Packs, import documents. Pack-content changes need a world
   reload; module.json changes need a world relaunch.

## Rules

- One document per file. Filename = kebab-case document name
  (`grimtooth-the-fence.json`). IDs are derived from the path — renaming a file
  changes its compendium ID and a re-import creates a duplicate.
- Cross-links: get the exact `@UUID[...]` string with
  `node scripts/content/uuid.mjs actors/<file>.json ["Display Name"]`
  (works for any type dir). The build validates links pointing at this module
  and fails on ids that match no source file — foreign compendium links
  (e.g. dnd5e SRD monsters) are not checked.
- GM-only journal pages: give the page `"ownership": { "default": 0 }`
  (see the faction template's Secrets page).
- Roll tables use the Foundry v13 result shape: `"type": "text"` and
  `"description"` (not the old numeric type / `text` field).
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
