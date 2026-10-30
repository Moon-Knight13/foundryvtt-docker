# foundry-gm — Claude Code plugin for FoundryVTT game masters

A Claude Code plugin marketplace with one plugin, **foundry-gm**: an AI
game master toolkit for [Foundry Virtual Tabletop](https://foundryvtt.com).

## What the plugin does

- **`foundry-content` skill — content-as-code.** Author campaign content
  (NPCs, items, quest journals, scenes, roll tables, factions, encounters)
  as JSON files in your project repo and compile them into a Foundry
  compendium module with deterministic IDs, validated `@UUID` cross-links,
  and a host-side sync script. System-agnostic core, dnd5e first-class.
  On first use it scaffolds the build tooling into your project
  (`scripts/content/`), so your repo owns its dependencies.
- **`foundry-mcp-setup` skill.** Install/troubleshooting guidance for the
  [foundry-vtt-mcp](https://github.com/adambdooley/foundry-vtt-mcp) bridge
  that lets Claude Code operate a live session (dice, tokens, conditions,
  scenes) — including the known packaging gotchas.
- **Routing guard (hook).** A PreToolUse hook denies the token-expensive
  MCP content-creation tools and points to the content-as-code skill, so
  bulk authoring never burns live-session tokens. Overridable per session
  for genuine live one-offs.
- **`foundry-content-reviewer` agent.** Read-only QA pass over your
  `content/src/` documents before build and import.

## Install

```
/plugin marketplace add Moon-Knight13/foundry-gm-claude-plugin
/plugin install foundry-gm@foundry-gm-marketplace
```

## Requirements

- Node.js (the content build uses
  [`@foundryvtt/foundryvtt-cli`](https://github.com/foundryvtt/foundryvtt-cli),
  installed into your project on first scaffold)
- A FoundryVTT server you administer (v12+, v13 recommended)
- Optional, for live play: the foundry-vtt-mcp bridge module + server

## Design notes

- The build tooling is **scaffolded into your project**, not run from the
  plugin cache — plugin updates never silently change your build. A
  `TOOLING_VERSION` marker lets the skill offer upgrades explicitly.
- No MCP server is bundled and the plugin makes no network calls; skills
  are lazy-loaded, so idle context cost is a few description lines.
- Compendium document IDs derive from source paths (sha256, first 16 hex
  chars) — imports update instead of duplicating, and links survive
  rebuilds.

## License

MIT. Not affiliated with Foundry Gaming, LLC; Foundry Virtual Tabletop is
their trademark. dnd5e templates contain schema structure only — bring your
own game content.
