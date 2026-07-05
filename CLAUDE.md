# Claude Workflow Contract

## Mission
Deliver secure, maintainable software with deterministic quality gates.

## Priority Order
1. Security
2. Correctness
3. Maintainability
4. Delivery speed
5. Token efficiency

## Model Routing
Use local model by default for low-risk tasks:
- formatting
- boilerplate
- straightforward docs updates
- low-risk single-purpose refactors

Use Claude for high-risk or ambiguous tasks:
- architecture or cross-cutting design
- security and auth changes
- infra or network configuration changes
- unclear root-cause debugging
- broad refactors across many files

## Task Routing Protocol

Before starting a task, determine the routing:

1. Classify: `task_type` (format|docs|tiny-refactor|rename|simple-test|architecture|security|deep-debug|cross-cutting), `risk_level` (low|medium|high), `changed_file_count`.
2. Delegate via the lifecycle wrapper (runs `route-model.sh`, then health preflight → context-fit → bounded generation → output sanity):
   `bash scripts/delegate-local.sh "<task_type>" "<risk_level>" "<changed_file_count>" "<prompt>"` (or `-` with the prompt on stdin).
3. Exit 0: stdout is the local model's result — validate before applying.
4. Exit 3: stderr has `escalate:<reason>` — proceed in this session (Claude) normally. Never retry `route:*` escalations locally.
5. When orchestrating subagents, run `Route=Local` subtasks through the `local-worker` agent (`.claude/agents/local-worker.md`); on `VERDICT: ESCALATE` redo the subtask with a Claude subagent.

Routing decisions and delegation outcomes (success/escalate, reason, duration, tokens/sec) are logged to `.ai/route-log.jsonl`. Local model health is cached in `.ai/local-health.json` (`scripts/local-health.sh`, TTL `LOCAL_HEALTH_TTL`).

## Hard Escalation Triggers
Escalate to Claude if any condition is true:
1. Task risk is high.
2. Change touches auth, secrets, or firewall/networking.
3. Change spans more than 8 files.
4. Local endpoint is unavailable.
5. Test failures persist after one local attempt.

## Kanban / Board
Work is tracked on a per-repo GitHub Project board (see `docs/KANBAN_WORKFLOW.md`).
- The board **Route** field (Human / Claude / Local) is the routing protocol made
  visible; it is derived from `scripts/route-model.sh` via `scripts/suggest-route.sh`. Keep them consistent.
- Agents pick up work with `/next-issue`, which claims a card collision-safely
  (`scripts/board.sh claim`: self-assign + `wip` + In Progress + re-check).
- Golden rule: never touch a card that is already assigned or In Progress. One
  branch and one PR (`Closes #<n>`) per story. Orchestrate epics with `/run-epic`.
- All board writes go through `scripts/board.sh` (gh-CLI, no secrets).

## Guardrails
- Never place credentials or tokens in repository files.
- Keep Claude auth in mounted user config outside workspace files.
- Run quality checks before merge: pre-commit, semgrep, gitleaks, CI checks.
- Respect repository protections and required checks.

## Style
Default response style should be concise and precise.

---

# FoundryVTT Docker — Project Appendix

Everything below is foundry-specific and appended after the template contract
(append-only so template-sync merges stay clean).

## What this repo is

A fork of felddy/foundryvtt-docker running FoundryVTT (D&D 5e, world
"troubled-waters") in Docker, plus an MCP integration that lets Claude Code
act as an AI game master: create NPCs, quests, journals, and scenes directly
in the live world.

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
docker compose --profile ngrok up -d   # with ngrok remote access
```

Foundry UI: http://localhost:30000 (admin key + credentials from `.env`).

## Foundry MCP integration (AI game master)

Two-part system ([adambdooley/foundry-vtt-mcp](https://github.com/adambdooley/foundry-vtt-mcp), pinned v0.8.2):

1. **`foundry-mcp-bridge` module** — runs client-side in the GM's browser
   session and connects OUT to the MCP backend. Install via Foundry UI →
   Setup → Add-on Modules → Install Module → manifest URL:
   `https://raw.githubusercontent.com/adambdooley/foundry-vtt-mcp/master/packages/foundry-module/module.json`
   (if ever installed manually instead, the folder name must stay exactly
   `foundry-mcp-bridge`).
2. **MCP server** — `mcp-server/index.js` (gitignored; installed/updated by
   `./scripts/setup-mcp.sh`). Claude Code launches it via `.mcp.json`; start
   Claude Code from the repo root so the relative path resolves.

| Port  | Purpose                                        |
|-------|------------------------------------------------|
| 31415 | Foundry module → MCP backend WebSocket          |
| 31414 | MCP server ↔ backend control channel (internal) |
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

## Content routing: skill vs MCP (token efficiency)

Two ways to get content into Foundry — the choice is the routing protocol
applied to game content. Full pipeline doc: `docs/CONTENT_AUTHORING.md`.

The `foundry-content` skill (and the `foundry-mcp-setup` skill) ship in the
**foundry-gm** Claude Code plugin, installed from its marketplace:

```
/plugin marketplace add Moon-Knight13/foundry-gm-claude-plugin
/plugin install foundry-gm@foundry-gm-marketplace
```

The plugin scaffolds its build tooling into `scripts/content/` (already
present here); a `TOOLING_VERSION` marker in `build.mjs` lets the skill flag
a stale copy.

| Task | Route | Why |
|---|---|---|
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

1. `up`, then open http://localhost:30001 — a full clone (worlds included) on
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
|---|---|---|
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
|---|---|
| This repo's runtime, compose stack, MCP wiring, content pipeline, scripts, docs | An **Issue on `Moon-Knight13/foundryvtt-docker`** → add to **board #10** (`scripts/board.sh add <n>`). |
| The **foundry-gm plugin** itself — `foundry-content` / `foundry-mcp-setup` skills, the guard hook, the reviewer agent, or the build tooling the plugin ships | An **Issue on `Moon-Knight13/foundry-gm-claude-plugin`** (its own board/repo), not here. |
| Upstream felddy image/behavior we want fixed upstream | Branch on **`upstreamfork`**, PR to **`felddy/foundryvtt-docker`**. |

Rule of thumb: this repo *consumes* the plugin. A bug reproducible with the
plugin uninstalled belongs here; a bug in a skill/hook/agent the plugin ships
belongs on the plugin repo so the fix reaches every consumer.
