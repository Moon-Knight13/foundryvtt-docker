# FoundryVTT Docker — Project Instructions

Project-specific instructions for this repository. Read this alongside
`CLAUDE.md`, which carries the workflow contract (priorities, board rules,
guardrails).

## What this repo is

A fork of felddy/foundryvtt-docker running FoundryVTT (D&D 5e) in Docker, plus
an MCP integration that lets Claude Code act as an AI game master: create NPCs,
quests, journals, and scenes directly in the live world.

The repo is the **pipeline**. It carries no game's content — not a world name,
not an actor, not a map spec. Games live in the Obsidian vault (below), and the
only game named anywhere in this repo is **Ashwake Hollow**, which is invented:
see [`examples/demo-game/`](../examples/demo-game/).

## Template heritage (detached)

This repo started from
[claude_template_repo](https://github.com/Moon-Knight13/claude_template_repo),
which supplied the devcontainer, firewall, CI gates, and board tooling. It is
now **detached from template sync**: the sync workflow and
`.templatesyncignore` are deleted and every file here is repo-owned — edit
freely, nothing gets reverted by an upstream merge.

Two upstream subsystems were removed outright rather than merely switched off:

- **Local-model routing** — no Ollama endpoint was ever reachable here; every
  logged routing attempt fell back to Claude. `route-model.sh`,
  `suggest-route.sh` and the rest of the delegation scripts are deleted, along
  with the firewall's port-11434 egress and the `local-ollama` MCP server
  entry. **Treat every task as Claude-routed.**
- **BMAD** — never produced anything, and its ~46 skill descriptions cost
  context in every session. Its installers are gone from the devcontainer
  `postStartCommand` chain.

`template.conf` remains as the switch panel for the subsystems this repo does
use (board, caveman, day-0); `scripts/validate-template.sh` enforces it in CI.
The live GitHub board may still carry a `Local` Route option and a "BMAD
Stage" field from before the removal — stale metadata, deletable in the board
UI, never an instruction.

## Notes vault (Obsidian)

The GM's personal notes live in an **Obsidian vault** bind-mounted into the
devcontainer at `/home/node/DnD`. The devcontainer mount source is
**hardcoded** to `${localEnv:HOME}/Documents/DnD` in
`.devcontainer/devcontainer.json` — only the Foundry container honours
`DND_VAULT_PATH` (`compose.yml`); a non-default vault path therefore needs the
devcontainer mount edited too, or the two containers see different trees.
Read/write notes there by absolute
path; it is **outside `/workspace`**, so it is never part of this repo's git tree.
A gitignored symlink `/workspace/DnD` → `/home/node/DnD` (created by
`postStartCommand`) surfaces the vault in the VS Code sidebar; the symlink
carries no note content and stays out of git.

> A public, content-free starter vault (this taxonomy + the blank templates)
> ships at `examples/vault-skeleton/` for others to copy into their own vault
> location.

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
- **Audio is a vault fact, not a Foundry one.** There is deliberately no
  `Playlist` collection: a Foundry playlist streams from your server to every
  connected client and does nothing for the sessions run in person. Each scene
  note carries `audio_source` / `audio_ref` / `audio_cue`, the game's
  `Soundtrack.md` names the bot once and renders a paste-ready cue sheet, and
  `compile-game.mjs` copies the cue onto the built scene so a GM-only macro can
  whisper it at the scene change. Never answer an audio question by creating a
  Foundry playlist — see
  [`docs/CONTENT_AUTHORING.md`](CONTENT_AUTHORING.md#ambience-stays-out-of-foundry),
  which also records why FlaviBot and Spotify cannot be driven from Foundry.

### This repo is the pipeline, not the content

**Do not commit a game's content here.** Actors, journals, scenes, items, tables
and map specs belong beside that game's Obsidian notes, where they are already
synced:

```text
03 Oneshots/<Game>/Foundry/
├── <slug>.config.json      # omit "srcDir" — it resolves under content/
├── maps/                   # render_map.py specs
└── src/{actors,items,journals,scenes,tables}/
```

`scripts/content/new-game.sh <slug>` scaffolds that whole layout — vault notes
and Foundry sources together — and prints a definition-of-done checklist. Build
without moving anything into the repo:

```bash
node scripts/content/build.mjs \
  --config "<vault>/03 Oneshots/<Game>/Foundry/<slug>.config.json" \
  --src    "<vault>/03 Oneshots/<Game>/Foundry/src"
```

Only **process** changes get committed here: tooling, docs, vault-skeleton
templates. Committing game content duplicates a source of truth that Obsidian
already syncs.

The older in-repo layout still works (`new-game.sh --in-repo`): it writes
`content/<slug>.config.json` and `content/src-<slug>/`, and the config's
`srcDir` tells the build where to look. See `docs/CONTENT_AUTHORING.md` for both
models.

**No default module, no default source tree.** `build.mjs` and
`sync-content.sh` both require `--config`, and the build requires `--src` unless
the config carries a `srcDir`. Earlier versions defaulted to
`content/content.config.json` + `content/src/`, which quietly made one real
game's content the implicit subject of every command; that seed and the in-repo
`content/src-<slug>/` tree beside it have been folded back into their games'
vault folders and removed from git. The only sources left here belong to the
invented demo game.

### A game is more than its compendium

The deliverable is the **vault folder**, not the module. A module that builds
cleanly and a game that is ready to run are different things — the full manifest
is under *Definition of done* in
`examples/vault-skeleton/00 Index/Running a new game.md`, and `new-game.sh`
creates every piece as a stub so a gap is visible rather than remembered.

Vault notes are the source of truth; the Foundry JSON is a projection of them.
Author the notes first and port once at packaging — never hand-maintain both
copies of an NPC.

## Repo layout & where things live

- `compose.yml` — the FoundryVTT stack. Live user data (worlds, modules,
  systems) is bind-mounted from `FOUNDRY_DATA_PATH` in `.env`
  (default `~/.local/share/FoundryVTT`). There is no repo-local data
  directory: nothing in `compose.yml` references one. Worlds live under
  `<data>/Data/worlds/`,
  modules under `<data>/Data/modules/`.
- `deploy-setup.sh` — interactive environment setup. (The upstream
  image-source tree `src/` was removed — this fork runs the published felddy
  image.)
- `foundry-base.json` — the pinned system + core module set a rebuilt Foundry
  install needs. Twenty-one of the twenty-five URLs name an exact version, each
  with a floating `check` URL beside it so the pin stays visible to the watcher;
  the four `gitlab.com` pins float on purpose, because that host is off the
  devcontainer firewall allowlist and a locked URL there cannot be verified from
  here. Move a pin with `scripts/content/foundry-base.mjs update`, which rewrites
  the URL and the version together, and commit the change. See
  `docs/FOUNDRY_REBUILD.md`.
- `scripts/` — template foundation scripts (board, day-0) plus project
  scripts: `scripts/ci/*` (CI gates), `scripts/setup-mcp.sh`,
  `scripts/mcp-health.sh`, `scripts/content/*`, `scripts/maps/*`.
  `scripts/content/foundry-base.mjs` is ops rather than content; it lives there
  because that is where the Node tooling's `package.json` is, and `pull-games`
  calls straight into `build.mjs`.

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
- **Port 31415 must be forwarded out of the devcontainer.** Upstream confirms
  the module is client-side and *it* initiates the WebSocket outbound to the
  MCP server. That browser runs on the host and dials `localhost:31415`, while
  the backend listens inside the devcontainer where Claude Code started it —
  the Foundry container is not part of this hop at all. `devcontainer.json`
  declares `forwardPorts: [31415]` so the hop exists without relying on VS
  Code's auto-detection — a rebuild or *Reload Window* is needed after changing
  it. Symptom when it's missing: `mcp-health.sh` reports the backend UP with no
  browser module connected. Do **not** forward 31414 — it is the loopback-only
  server↔backend control channel.
- **Force "Connection Type" to WebSocket** in the module settings. The default
  is *Auto*, which may negotiate WebRTC instead — a different path (31416,
  unused locally) that leaves the forwarded 31415 idle and makes a correct
  port-forward look broken.
- **"Websocket Server Host"** in module settings is the other half of the same
  lever: it is the address the browser dials. Leave it at `localhost` when 31415
  is forwarded as above; point it at the devcontainer's IP only if you are
  deliberately skipping the forward. One or the other — not both.
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
- **Version drift — this pin is coupled.** The module and the server are one
  fact, so `foundry-base.json` version-locks `foundry-mcp-bridge` to the
  **v0.8.2 tag**, manifest *and* `download`, rather than to `master` or
  `/releases/latest/`. Both locks are needed: a rebuild found the v0.8.2
  manifest pointing its own download at `/releases/latest/`, so provision read
  0.8.2 and installed 0.8.3 — a module ahead of its server with nothing saying
  so. Move this pin by editing the tag in both URLs, the `version`, and
  `MCP_VERSION` in `scripts/setup-mcp.sh` **together**, then re-run that script.
  The pin now carries `"coupled"`, so the monthly pin-freshness PR holds it back
  and names it rather than sweeping it along with ordinary module bumps. Give it
  a `check` URL and `update foundry-mcp-bridge` will report when it has moved;
  without one, a version-locked manifest reports the pin current forever.
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
3. **foundry-content skill** — author notes in the vault; statblocks compile
   from SRD fences (`compile-game.mjs`), art resolves through the curated map
   and gate (`art-coverage.mjs --strict` — see `docs/CONTENT_AUTHORING.md`,
   "Token art").
4. **Ship**: `scripts/content/ship-game.sh <game-dir>` (host side) runs
   compile → strict art gate → build → sync → Foundry restart in one command.
   Import with **Keep Document IDs** ticked.
5. Scene/token tools (MCP) — stage encounters in the live world from the
   imported compendium content; dice-request tools during play.

## Testing changes against the live stack

There is no second instance. `scripts/test-instance.sh` (still present, no
longer the recommended path) clones the data dir onto a stack on :30001, on
the premise that live worlds were irreplaceable.
That premise no longer holds — a world is rebuildable from the vault, the git
content module and D&D Beyond (see `docs/FOUNDRY_REBUILD.md`) — and one Foundry
licence permits only one active server, so the two stacks could never run at
once anyway.

Test against the real stack, with a data-dir snapshot as the undo path:

1. Snapshot the data dir before anything risky:
   `node scripts/content/foundry-base.mjs snapshot`. That is the **full** mode —
   worlds included — which is what an undo needs. (`--golden` is the other mode:
   a clean slate with no worlds. See `docs/FOUNDRY_REBUILD.md`.) It keeps the
   previous backup as `<data>.backup.1` and refuses to mirror an install that
   has lost worlds over a backup that still has them.
2. Install/enable the module, turn on Allow Write Operations, exercise it.
3. Rollback if needed: disable/uninstall the module (worlds are unaffected by a
   module removal), `foundry-base.mjs restore --world <id>` for a single world,
   or `foundry-base.mjs restore --yes` for the whole data directory.

Do this between sessions rather than on game night — the stack is down while a
restore runs.

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
