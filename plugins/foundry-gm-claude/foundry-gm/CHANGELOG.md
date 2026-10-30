# Changelog

## 0.1.1

- Fix: drop the redundant `hooks` key from `plugin.json`. The standard
  `hooks/hooks.json` path loads automatically, so referencing it in the
  manifest caused a duplicate-hooks load error (`/doctor`). The routing
  guard stays active via the auto-loaded file.

## 0.1.0

- Initial release.
- `foundry-content` skill: content-as-code compendium authoring with
  project scaffolding (`TOOLING_VERSION` 1), system-agnostic build with
  dnd5e templates, roll tables, faction/encounter journal templates,
  `@UUID` link validation, `uuid.mjs` link helper, host sync script.
- `foundry-mcp-setup` skill: foundry-vtt-mcp bridge install and
  troubleshooting guidance.
- PreToolUse routing guard denying MCP content-creation tools
  (`dnd5e-create-npc`, `create-quest-journal`) with live-session overrides.
- `foundry-content-reviewer` agent: read-only content QA.
