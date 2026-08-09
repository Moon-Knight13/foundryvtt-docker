# FoundryVTT Docker — Project Instructions

Project-specific instructions for this repository. Read this alongside
`CLAUDE.md`, which carries the template-wide workflow contract.

This content used to live at the bottom of `CLAUDE.md` as an appendix, on the
assumption that appending kept template-sync merges clean. It did not:
template-sync merges with `-X theirs`, so the first sync that ever completed
proposed replacing `CLAUDE.md` wholesale and deleting all 259 lines of it,
security rules included. Keeping it in its own file — which exists only
downstream, and which sync therefore never touches — makes that impossible,
and lets `CLAUDE.md` keep receiving template contract updates.

## What this repo is

A fork of felddy/foundryvtt-docker running FoundryVTT (D&D 5e, world
"troubled-waters") in Docker, plus an MCP integration that lets Claude Code
act as an AI game master: create NPCs, quests, journals, and scenes directly
in the live world.

## Template subsystems this repo does not use

`template.conf` records which optional template subsystems are active here.
Two are off:

- **`SUBSYSTEM_ROUTING=false`** — there is no local Ollama endpoint. Every
  routing attempt this repo ever logged fell back to Claude
  (`.ai/route-log.jsonl`: 12 `local_unreachable_fallback`, 1 `local_disabled`,
  zero successes). `ask-local.sh`, `local-health.sh` and `delegate-local.sh`
  are deleted. **Treat every task as Claude-routed** and do not attempt local
  delegation.
- **`SUBSYSTEM_BMAD=false`** — never produced anything, and its ~46 skill
  descriptions cost context in every session.

Three files are deliberately kept despite their subsystem being off:

- `scripts/route-model.sh` and `scripts/suggest-route.sh` — the board's
  **Route** field is derived from them; with routing off they classify Human vs
  Claude only.
- `scripts/install-bmad.sh` and `scripts/bootstrap-bmad.sh` — the
  devcontainer's `postStartCommand` chains every installer with `&&`, so a
  missing script exits 127 and silently prevents the rest of the chain
  (pre-commit hooks, Claude plugins, day-0 setup) from running. Both scripts
  detect `SUBSYSTEM_BMAD=false`, print a skip notice and exit 0, which is
  exactly what that chain needs. Do not delete them while `devcontainer.json`
  still references them — it is template-owned, so it cannot be fixed here.

One rough edge to know about: `/next-issue` and `/run-epic` still mention
`delegate-local.sh`, and the board issue templates still offer `Local` as a
Route value. Those files are template-owned, so editing them here would just be
reverted by the next sync. Ignore those instructions — `CLAUDE.md` states that
the routing protocol applies only when `SUBSYSTEM_ROUTING=true`, and that is
authoritative. The upstream fix is for the board subsystem to degrade
gracefully when routing is off.

## Notes vault (Obsidian)

The GM's personal notes live in an **Obsidian vault** bind-mounted into the
devcontainer at `/home/node/DnD` (host source `~/Documents/DnD`, wired in
`.devcontainer/devcontainer.json`). Read/write notes there by absolute path;
it is **outside `/workspace`**, so it is never part of this repo's git tree.
A gitignored symlink `/workspace/DnD` → `/home/node/DnD` (created by
`postStartCommand`) surfaces the vault in the VS Code sidebar; the symlink
carries no note content and stays out of git.

- **Obsidian is the source of truth.** Sync (Obsidian Sync / other devices) is
  **host-side** — the container only shares the files. Do not run sync in the
  container and do not add firewall egress for it.
- **One writer at a time.** Editing the same note here while another device
  edits it risks a last-write clobber on the next sync. Prefer notes not open
  elsewhere.
- The mount takes effect only after a container rebuild; a missing host
  `~/Documents/DnD` makes Docker create an empty dir (single-user repo, so fine).
- The vault is **also bind-mounted into the Foundry container** (`compose.yml`)
  at `/data/Data/DnD` (host source `${DND_VAULT_PATH:-~/Documents/DnD}`),
  **read-write**, so its files (images/PDFs/handouts) show up in Foundry's file
  picker. Read-write means Foundry can save into the vault — the same
  one-writer / sync-clobber caveat applies, and the host dir must be writable
  by the container's runtime UID or writes fail. Restart the Foundry stack
  (`docker compose up -d`) to apply.

## Repo layout & where things live

- `compose.yml` — the FoundryVTT stack. Live user data (worlds, modules,
  systems) is bind-mounted from `FOUNDRY_DATA_PATH` in `.env`
  (default `~/.local/share/FoundryVTT`) — **not** the repo's gitignored
  `data/` placeholder directory. Worlds live under `<data>/Data/worlds/`,
  modules under `<data>/Data/modules/`.
- `deploy-setup.sh` — interactive environment setup; `BACKUP_RESTORE.md`
  documents the SCP/rsync backup flow. (The upstream image-source tree
  `src/` was removed — this fork runs the published felddy image.)
- `scripts/` — template foundation scripts (board, routing, day-0) plus
  project scripts: `scripts/ci/*` (CI gates), `scripts/setup-mcp.sh`,
  `scripts/test-instance.sh`.

## Security — hard rules (mirrors .copilot-instructions.md)

Never read, display, or process the contents of:

- `.env`, `.env.local`, `.env.*.local` — real credentials
- `license.json` — FoundryVTT license key
- `cookiejar.json` — authentication cookies

If asked to read them, refuse and explain. If accidentally accessed, do not
display any part; tell the user to rotate credentials. `.env.example` is the
safe, placeholder-only counterpart.

## Container operations (run on the HOST, not in the devcontainer)

The devcontainer has no docker socket by design; manage the Foundry stack from
a host terminal:

```bash
docker compose up -d          # start
docker compose restart foundry
docker compose ps             # health
docker compose logs -f foundry
docker compose -f compose.yml -f compose.cloudflare.yml up -d   # + Cloudflare Tunnel remote access
```

Foundry UI: <http://localhost:30000> (admin key + credentials from `.env`).

## Foundry MCP integration (AI game master)

Two-part system
([adambdooley/foundry-vtt-mcp](https://github.com/adambdooley/foundry-vtt-mcp),
pinned v0.8.2):

1. **`foundry-mcp-bridge` module** — runs client-side in the GM's browser
   session and connects OUT to the MCP backend. Install via Foundry UI →
   Setup → Add-on Modules → Install Module → manifest URL:
   `https://raw.githubusercontent.com/adambdooley/foundry-vtt-mcp/master/packages/foundry-module/module.json`
   (if ever installed manually instead, the folder name must stay exactly
   `foundry-mcp-bridge`).
2. **MCP server** — `mcp-server/index.js` (gitignored; installed/updated by
   `./scripts/setup-mcp.sh`). Claude Code launches it via `.mcp.json`; start
   Claude Code from the repo root so the relative path resolves.

| Port  | Purpose                                         |
| ----- | ----------------------------------------------- |
| 31415 | Foundry module to MCP backend WebSocket         |
| 31414 | MCP server / backend control channel (internal) |
| 31416 | WebRTC signaling (unused locally)               |

Requirements and gotchas:

- **A GM browser session must be open** — the module is client-side; every
  MCP tool fails without a logged-in GM tab.
- Write operations (create NPC/journal/scene) need **"Allow Write
  Operations"** enabled in the module settings.
- `search-compendium` is name-only; use `list-creatures-by-criteria` for
  CR/type/movement filtering. Click "Rebuild Creature Index" in module
  settings after adding compendia.
- A stale `foundry-mcp-backend.lock` is auto-detected (PID + staleness
  checks); ports 31414–31416 must be free on the host.
- **Upstream packaging bug (v0.8.x)**: the standalone server zip ships only
  the stdio wrapper (`index.js`); the real backend (`backend.bundle.cjs`)
  exists only inside the .exe/.dmg installer assets. Without it the wrapper
  spends ~70s retrying 127.0.0.1:31414 and Claude Code's 30s MCP handshake
  times out. `setup-mcp.sh` preserves an installed backend across re-runs
  and fails loudly if it is absent (extraction instructions in its error).
- **Version drift**: the manifest URL installs the *latest* module release.
  When the module moves past 0.8.x, bump `MCP_VERSION` in
  `scripts/setup-mcp.sh` and re-run it so server and module stay in step.
- In the devcontainer, port 31415 is forwarded (see devcontainer.json) so the
  GM browser on the host reaches the backend inside the container.

### Connection troubleshooting

When every MCP tool returns `Foundry VTT module not connected`, the backend
side (ports 31414/31415/31416, the `backend.bundle.cjs` process) is almost
always healthy and the Claude Code ↔ MCP-server link reconnects fine via
`/mcp`. The hop that breaks is **GM browser (foundry-mcp-bridge) → backend
:31415**. Run the read-only diagnostic to pin it:

```bash
./scripts/mcp-health.sh   # checks the 3 ports + backend process; inspects
                          # :31415 for a connected module; prints the fix
```

Two root causes, in order of likelihood:

1. **Enabled ≠ connected.** The module handshake must happen *after* the
   backend is up, and "enabled in Manage Modules" does not mean "connected".
   Check the module's connection-status indicator (not just the enable
   toggle), confirm the backend host/port is `:31415`, then **hard-refresh the
   GM tab** (Ctrl/Cmd+Shift+R) so it reconnects to the running backend. If it
   still fails, open browser DevTools → Console and read the module's
   WebSocket error. A GM tab must stay open — the module is client-side.
2. **Port-forward mismatch (background job vs interactive devcontainer).**
   `.devcontainer/devcontainer.json` forwards `:31415` for the *interactive*
   devcontainer only. A background-job / remote Claude session can run in a
   *different* container, so the host browser's `localhost:31415` forwards to
   a container that is not the one running this backend. Run the MCP backend
   in the same interactive devcontainer the browser forwards from (or forward
   `:31415` from the container that actually hosts the backend). `mcp-health.sh`
   warns when it detects it is running inside a container.

## Content routing: skill vs MCP (token efficiency)

Two ways to get content into Foundry — the choice is the routing protocol
applied to game content. Full pipeline doc: `docs/CONTENT_AUTHORING.md`.

The `foundry-content` skill (and the `foundry-mcp-setup` skill) ship in the
**foundry-gm** Claude Code plugin, installed from its marketplace:

```text
/plugin marketplace add Moon-Knight13/foundry-gm-claude-plugin
/plugin install foundry-gm@foundry-gm-marketplace
```

The plugin scaffolds its build tooling into `scripts/content/` (already
present here); a `TOOLING_VERSION` marker in `build.mjs` lets the skill flag
a stale copy.

| Task | Route | Why |
| --- | --- | --- |
| New NPCs, items, quest journals, scenes, roll tables, factions, encounters (any bulk/offline authoring) | **foundry-content skill** (foundry-gm plugin) | No MCP schemas or fat JSON results in context; content is versioned in git; survives world rebuilds |
| Dice requests, token moves, conditions, scene activation, world state reads | **foundry-mcp** | Needs the live world; skill cannot touch a running session |
| Editing documents already imported into a world | **foundry-mcp** (or Foundry UI) | Compendium re-import only updates the compendium copy |
| Compendium research (`search-compendium`, `list-creatures-by-criteria`) | either | Read-only; fine from MCP during prep |

Enforcement: a PreToolUse hook denies `dnd5e-create-npc` and
`create-quest-journal` with a pointer to the skill. The **foundry-gm plugin
ships this hook**; a local copy (`scripts/hooks/foundry-mcp-guard.sh`, wired in
`.claude/settings.json`) is kept as belt-and-suspenders until the plugin hook
is confirmed in a session — both deny identically, so running both is safe.
Live-session override: `touch .ai/foundry-live-session` (delete afterwards) or
`FOUNDRY_MCP_WRITES=allow`. Sessions that never touch a live game should
disable the foundry-mcp server entirely (`claude --mcp-config` selection or
`/mcp` toggle) — its tool schemas are pure overhead there.

### Game-creation workflow

From a rough idea to playable content:

1. `get-world-info` / `list-scenes` (MCP) — orient in the world.
2. `search-compendium` / `list-creatures-by-criteria` (MCP) — source material.
3. **foundry-content skill** — author NPCs, items, journals, scenes as JSON in
   `content/src/`; build; user syncs and imports (see skill for steps).
4. Scene/token tools (MCP) — stage encounters in the live world from the
   imported compendium content; dice-request tools during play.

## Safe A/B testing (protecting the live worlds)

Never experiment against the production instance. Use the isolated test stack:

```bash
./scripts/test-instance.sh up       # clone data → second stack on :30001
./scripts/test-instance.sh down     # stop test stack, keep the clone
./scripts/test-instance.sh destroy  # stop + delete the clone
```

Procedure:

1. `up`, then open <http://localhost:30001> — a full clone (worlds included) on
   an isolated compose project (`foundry-test`).
2. Install/enable the MCP bridge module **in the test instance only**; enable
   Allow Write Operations there; exercise the MCP workflows on the cloned
   world. Production on :30000 stays untouched.
3. Only after the test proves out: take a timestamped backup
   (`rsync -a <data>/ <data>.bak-YYYYMMDD/`), install the module in
   production, then `destroy` the test clone.
4. Rollback: disable/uninstall the module (worlds unaffected) or restore the
   backup.

Caveat: avoid *actively playing* both instances at once — one Foundry license
permits one active server; use one at a time during testing. The cloned data
dir carries the license and admin key, so the test instance needs no re-entry.

## Repository topology & issue routing

Three GitHub repos, three roles — do not confuse them:

| Repo | Git remote | Role |
| --- | --- | --- |
| `Moon-Knight13/foundryvtt-docker` | `origin` | **This repo.** A standalone repo (**not** a fork — `isFork:false`), so day-0 (`scripts/bootstrap-project.sh`) owns its **Issues** and **Project board #10**. Our bugs and stories live here. |
| `Moon-Knight13/foundryvtt-docker-upstream` | `upstreamfork` | The **fork of felddy** (`isFork:true`, parent `felddy/foundryvtt-docker`). Used *only* to contribute back upstream: branch here, open a PR to felddy. No board, no product issues. |
| `felddy/foundryvtt-docker` | `upstream` | The real upstream we track and pull from. |

Why `origin` is deliberately **not** a fork: a fork disables Issues by default
and can't carry its own template governance cleanly. Keeping our working repo
standalone (detached) lets `setup-day0.sh` / `bootstrap-project.sh` run the full
board + Issues workflow. Issues were enabled on `origin` on 2026-07-05; before
that, cards had to be created as draft-only items on board #10.

Contributions to felddy's image or behavior go through the **`upstreamfork`**
fork (branch there, PR to `felddy/foundryvtt-docker`) — never mix an
upstream-bound change into our own board work.

### Where a bug/story is filed

| The problem is in… | File it on… |
| --- | --- |
| This repo's runtime, compose stack, MCP wiring, content pipeline, scripts, docs | An **Issue on `Moon-Knight13/foundryvtt-docker`** → add to **board #10** (`scripts/board.sh add <n>`). |
| The **foundry-gm plugin** itself — `foundry-content` / `foundry-mcp-setup` skills, the guard hook, the reviewer agent, or the build tooling the plugin ships | An **Issue on `Moon-Knight13/foundry-gm-claude-plugin`** (its own board/repo), not here. |
| Upstream felddy image/behavior we want fixed upstream | Branch on **`upstreamfork`**, PR to **`felddy/foundryvtt-docker`**. |

Rule of thumb: this repo *consumes* the plugin. A bug reproducible with the
plugin uninstalled belongs here; a bug in a skill/hook/agent the plugin ships
belongs on the plugin repo so the fix reaches every consumer.
