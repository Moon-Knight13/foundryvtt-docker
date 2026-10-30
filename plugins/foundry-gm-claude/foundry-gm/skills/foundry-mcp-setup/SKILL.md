---
name: foundry-mcp-setup
description: Install and troubleshoot the foundry-vtt-mcp bridge (adambdooley/foundry-vtt-mcp) that lets Claude Code operate a live FoundryVTT session — dice requests, tokens, conditions, scenes, world reads. Use when setting up foundry-mcp, when MCP tools can't reach Foundry, or when the MCP handshake times out.
---

# Foundry MCP Bridge Setup

[adambdooley/foundry-vtt-mcp](https://github.com/adambdooley/foundry-vtt-mcp)
(MIT) is a two-part system connecting Claude Code to a running FoundryVTT
world:

1. **`foundry-mcp-bridge` module** — runs client-side in the GM's browser
   session and connects OUT to the MCP backend. Install via Foundry UI →
   Setup → Add-on Modules → Install Module → manifest URL:
   `https://raw.githubusercontent.com/adambdooley/foundry-vtt-mcp/master/packages/foundry-module/module.json`
   (if installed manually, the folder name must stay exactly
   `foundry-mcp-bridge`).
2. **MCP server** — a local Node process Claude Code launches via
   `.mcp.json`. Get it from the project's GitHub releases (standalone server
   zip matching the module version).

| Port  | Purpose                                         |
|-------|-------------------------------------------------|
| 31415 | Foundry module → MCP backend WebSocket          |
| 31414 | MCP server ↔ backend control channel (internal) |
| 31416 | WebRTC signaling (often unused)                 |

`.mcp.json` in the project root (start Claude Code from the project root so
the relative path resolves):

```json
{
  "mcpServers": {
    "foundry-mcp": { "command": "node", "args": ["mcp-server/index.js"] }
  }
}
```

## Requirements and gotchas

- **A GM browser session must be open** — the module is client-side; every
  MCP tool fails without a logged-in GM tab.
- Write operations (create NPC/journal/scene) need **"Allow Write
  Operations"** enabled in the module settings.
- **Pin the version.** The manifest URL installs the *latest* module
  release; the server must match. Record the pinned version wherever your
  setup script or docs live and bump both sides together.
- **v0.8.x packaging bug**: the standalone server zip ships only the stdio
  wrapper (`index.js`); the real backend (`backend.bundle.cjs`) exists only
  inside the .exe/.dmg installer assets. Without it the wrapper spends ~70s
  retrying 127.0.0.1:31414 and Claude Code's 30s MCP handshake times out.
  Extract `backend.bundle.cjs` from the installer asset (it is a plain
  archive) into the server directory next to `index.js`.
- A stale `foundry-mcp-backend.lock` can block startup — check PID liveness
  before deleting. Ports 31414–31416 must be free on the machine running the
  server.
- `search-compendium` is name-only; use `list-creatures-by-criteria` for
  CR/type/movement filtering. Click "Rebuild Creature Index" in module
  settings after adding compendia.
- If Claude Code runs in a container, forward port 31415 so the GM browser
  on the host reaches the backend inside the container.

## Routing (token cost)

This plugin's PreToolUse hook denies the MCP content-creation tools
(`dnd5e-create-npc`, `create-quest-journal`) — bulk content goes through the
`foundry-content` skill instead; MCP is for live-play operations. Sessions
that never touch a live game should disable the foundry-mcp server entirely
(`/mcp` toggle or `claude --mcp-config` selection) — its tool schemas are
pure context overhead there.

Never experiment against a production world: clone the data dir and run a
second Foundry instance on another port first, enable the bridge module only
there, and take a backup before installing the module in production.
