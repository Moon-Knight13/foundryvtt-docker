---
name: foundry-content
description: Author FoundryVTT campaign content (NPCs, items, quest journals, scenes, roll tables, factions, encounters) as JSON in the project repo and compile it into a compendium module. Use for bulk or offline content creation — "create NPCs", "write quest journals", "bulk content", "add items/loot", "prep encounter content", "make a rumor table". Do NOT use for live-play operations (dice requests, token movement, scene activation, conditions) — those need the foundry-mcp server.
---

# Foundry Content Authoring (content-as-code)

Compile campaign content from `content/src/` into a Foundry compendium
module. Token-cheap replacement for foundry-mcp content tools: copy a
template, edit fields, build, hand off one host command. Content is
versioned in git and survives world rebuilds because it lives in a module,
not the world database.

## Step 0 — Scaffold (first use in a project)

If `scripts/content/build.mjs` does not exist in the project:

1. Copy the tooling into the project:
   `mkdir -p scripts/content && cp "${CLAUDE_PLUGIN_ROOT}"/skills/foundry-content/tooling/* scripts/content/`
2. `npm --prefix scripts/content install`
3. Create `content/content.config.json` — ask the user for module id
   (lowercase kebab-case), title, and game system:

   ```json
   {
     "id": "my-campaign-content",
     "title": "My Campaign Content",
     "system": "dnd5e",
     "version": "1.0.0"
   }
   ```

   Omit `"system"` entirely for a system-agnostic module.
4. Ensure `content/dist/` is gitignored.

If `scripts/content/build.mjs` exists, compare its `TOOLING_VERSION` with
the copy in `${CLAUDE_PLUGIN_ROOT}/skills/foundry-content/tooling/build.mjs`.
If the project copy is older (or has no marker), tell the user an updated
scaffold is available and offer to re-copy — show a diff first; never
overwrite silently.

## Workflow

1. **Copy a template — never write document JSON from scratch.**
   System-agnostic: `${CLAUDE_PLUGIN_ROOT}/skills/foundry-content/templates/common/{journal,scene,roll-table,faction,encounter}.json`
   dnd5e: `${CLAUDE_PLUGIN_ROOT}/skills/foundry-content/templates/dnd5e/{npc,item}.json`
   Destination: `content/src/{actors,items,journals,scenes,tables}/<kebab-name>.json`
   (factions and encounters are journals — they go in `content/src/journals/`).
   Edit only the fields you need; `REPLACE` markers show the minimum. Unknown
   system fields are defaulted by Foundry on import — do not invent schema.
2. **Build:** `node scripts/content/build.mjs`
   Compiles to `content/dist/<module-id>/`. Fails with file+field on invalid
   sources and on broken `@UUID` cross-links.
3. **Sync (USER runs on the HOST where the Foundry data dir lives):**
   `scripts/content/sync-content.sh [--test] [--data <path>]` — rsyncs the
   built module into `<data>/Data/modules/`. `--test` targets
   `FOUNDRY_TEST_DATA_PATH`; default targets `FOUNDRY_DATA_PATH`
   (fallback `~/.local/share/FoundryVTT`). Tell the user to run this if you
   cannot reach the data dir.
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
- Keep content tooling deps in `scripts/content/package.json` — never add
  them to the project root package.json.

## When NOT to use this skill

Live session work — rolling dice, moving/updating tokens, toggling conditions,
switching scenes, checking current game state. Use the foundry-mcp tools.
Editing documents already imported into a world — compendium re-import
overwrites the compendium copy only; world copies must be updated in the UI or
via foundry-mcp.

Note: this plugin's PreToolUse hook denies the foundry-mcp content-creation
tools (`dnd5e-create-npc`, `create-quest-journal`) and points back here. If
the user explicitly wants a live-session one-off, they can override with
`touch .ai/foundry-live-session` (in the project root; delete afterwards) or
`FOUNDRY_MCP_WRITES=allow` — do not work around the guard yourself.
