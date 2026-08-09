# Self-hosted FoundryVTT in Docker — Cloudflare-tunneled, Obsidian-backed prep

[![ci](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/ci.yml)
[![semgrep](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/semgrep.yml/badge.svg?branch=main)](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/semgrep.yml)
[![secret-scan](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/secret-scan.yml/badge.svg?branch=main)](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/secret-scan.yml)
[![CodeQL](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/codeql-analysis.yml/badge.svg?branch=main)](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/codeql-analysis.yml)

A self-hosted **[Foundry Virtual Tabletop](https://foundryvtt.com)** server that
runs in **Docker** and is reachable remotely through a **Cloudflare Tunnel** —
no port forwarding, no inbound ports. Game prep lives in an **Obsidian vault**
(the DM's durable source of truth) and is projected into Foundry for online or
hybrid play, while the same notes run an **in-person** table with no export.
**Claude Code** assists prep — authoring content as code and driving the live
world over an MCP bridge — and the repo also ships a devcontainer for
*developing this repository*, which is a dev tool, not part of running the game.

## How it fits together

- **FoundryVTT container** — the published
  [felddy/foundryvtt-docker](https://github.com/felddy/foundryvtt-docker) image
  (`ghcr.io/felddy/foundryvtt:release`) run via [`compose.yml`](compose.yml);
  this fork doesn't build its own image. Live data (worlds, modules) is
  bind-mounted from `FOUNDRY_DATA_PATH`. Contributions to the image itself are
  staged through a clean
  [upstream fork](https://github.com/Moon-Knight13/foundryvtt-docker-upstream)
  and PR'd to felddy.
- **Remote access** — an optional **Cloudflare Tunnel** overlay
  ([`compose.cloudflare.yml`](compose.cloudflare.yml), see
  [DEPLOYMENT.md](DEPLOYMENT.md#remote-access-via-cloudflare-tunnel)):
  `cloudflared` dials out to Cloudflare's edge, giving players a stable HTTPS
  URL with zero inbound ports. Locally it's just `http://localhost:30000`.
- **DM prep backbone** — an **Obsidian vault** you own is the system-agnostic
  source of truth; FoundryVTT is a transient projection you can wipe and rebuild
  from the vault, the git content module, and D&D Beyond. See
  [Prep in Obsidian, play in Foundry](#prep-in-obsidian-play-in-foundry).
- **AI game master (optional)** —
  [Claude Code](https://claude.com/claude-code) authors NPCs / items / quests /
  scenes as code compiled into a compendium module, and drives the running world
  (dice, tokens, scenes) over the
  [foundry-vtt-mcp](https://github.com/adambdooley/foundry-vtt-mcp) bridge (see
  [`docs/PROJECT.md`](docs/PROJECT.md)).

The repository itself is developed AI-first: the devcontainer, deny-by-default
firewall, model routing, CI gates, and Kanban flow come from
[claude_template_repo](https://github.com/Moon-Knight13/claude_template_repo)
and exist to work **on this repo**, not to run your table — see
[Working on this repo](#working-on-this-repo-devcontainer).

## Quickstart

```bash
git clone https://github.com/Moon-Knight13/foundryvtt-docker.git
cd foundryvtt-docker
cp .env.example .env          # fill in FoundryVTT credentials + admin key
./deploy-setup.sh             # guided setup — or edit .env by hand
docker compose up -d
```

Foundry answers on <http://localhost:30000>. All environment variables the
image understands are documented in the
[upstream README](https://github.com/felddy/foundryvtt-docker#readme).

Optional profiles:

```bash
docker compose --profile monitoring up -d   # Netdata :19999, Dozzle :8080 (loopback-only)
docker compose -f compose.yml -f compose.cloudflare.yml up -d   # remote access via Cloudflare Tunnel (see DEPLOYMENT.md)
```

### AI game master

Two complementary paths, routed by token cost
(see [`docs/CONTENT_AUTHORING.md`](docs/CONTENT_AUTHORING.md)):

**Content authoring (default — content-as-code).** Claude writes NPCs, items,
quest journals, and scenes as JSON in `content/src/` and compiles them into
the "Troubled Waters Content" compendium module; you sync it to the Foundry
data dir and import in the UI:

```bash
node scripts/content/build.mjs            # Claude runs this after authoring
./scripts/content/sync-content.sh --test  # you, on the host: test instance first
./scripts/content/sync-content.sh         # then production
```

**Live play (MCP).** Dice requests, tokens, conditions, scene activation, and
world-state reads go over the
[foundry-vtt-mcp](https://github.com/adambdooley/foundry-vtt-mcp) bridge:

```bash
./scripts/setup-mcp.sh        # installs the MCP server into mcp-server/
# install the foundry-mcp-bridge module via the Foundry UI, enable it in a
# world, turn on "Allow Write Operations", keep a GM browser tab open
claude                        # Claude Code picks up .mcp.json from the repo root
```

Test module changes against a disposable clone first —
`./scripts/test-instance.sh up` starts a full copy of your live data on
:30001 (see [`docs/PROJECT.md`](docs/PROJECT.md), "Safe A/B testing").

## Prep in Obsidian, play in Foundry

Prep lives in an **Obsidian vault you own** — system-agnostic notes that sync
across your devices. Foundry is just one place that prep gets *played*:
everything durable lives in the vault (plus the git content module and
D&D Beyond), so a Foundry world can be wiped and rebuilt in minutes.

- **Durable (source of truth):** the vault (prose, handouts, map `.dd2vtt`), the
  git content module, D&D Beyond characters.
- **Transient (fine to lose):** token positions, fog, the combat tracker, the
  active scene.

### Bring your own vault

The repo ships the *plumbing and a starter skeleton*, never anyone's notes. To
wire up yours:

1. Set `DND_VAULT_PATH` in `.env` (defaults to `~/Documents/DnD`). Compose
   bind-mounts it read-write into Foundry at `/data/Data/DnD`. The devcontainer
   mounts `~/Documents/DnD` at `/home/node/DnD` — always that fixed path, as
   VS Code reads neither `.env` nor nested variable defaults in mounts.
2. Start from the skeleton — copy it to your vault path and open it in Obsidian:

   ```bash
   cp -r examples/vault-skeleton "$DND_VAULT_PATH"   # or an empty folder to start bare
   ```

   It carries the folder taxonomy, blank Templater templates, and generic guide
   notes — no campaign content. See
   [`examples/vault-skeleton/README.md`](examples/vault-skeleton/README.md) for
   the Obsidian plugins to enable.

### Two play surfaces

Same notes, two tables:

- **In person** — run straight from the vault (laptop/tablet as your GM screen):
  Fantasy Statblocks cards, printed or displayed handouts and maps, dice + the
  Initiative Tracker. No export.
- **Online / hybrid** — project the vault into Foundry through purpose-built
  pipes:

  | Content | Pipe | Direction |
  | --- | --- | --- |
  | Notes / journals / handouts | **SoSly Obsidian Bridge** | bidirectional |
  | NPCs / items / roll tables / scenes | **content-as-code → compendium module** | one-way (git = truth) |
  | Images / art / map files | **`/data/Data/DnD` mount** | shared files (no copy) |
  | Maps as walled/lit scenes | **`.dd2vtt` → Universal Battlemap Importer** | source `.dd2vtt` lives in the vault |
  | Player characters | **D&D Beyond → ddb-importer** | DDB = truth |

### Maps

`scripts/maps/render_map.py` turns one JSON spec into a clean **Player** PNG, a
keyed **DM** PNG, and a Foundry **`.dd2vtt`** (walls + lights + doors baked in).
Full spec: [`scripts/maps/README.md`](scripts/maps/README.md).

### Taxonomy

The starter vault (`examples/vault-skeleton/`) lays out:

```text
00 Index/      Home, How this vault works, Notes to the table, Running a new game
01 Systems/    per-system rules notes (cairn, dnd5e, …)
02 Campaigns/  multi-session games
03 Oneshots/   single-session games
04 Bestiary/   reusable statblocks
05 Templates/  Templater templates (NPC, Location, Quest, Map Brief, …)
06 Assets/     handouts, maps, tokens
99 Inbox/      unsorted capture
```

To rebuild a wiped world from these durable sources, see
[`docs/FOUNDRY_REBUILD.md`](docs/FOUNDRY_REBUILD.md); the full design rationale
is in the
[architecture spec](docs/superpowers/specs/2026-07-18-obsidian-foundry-architecture-design.md).

## Documentation map

| Doc | What it covers |
| --- | --- |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | Full deployment guide: env setup, profiles, monitoring, performance, troubleshooting |
| [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md) | Backup and restore: SCP/rsync pull from a remote host, Foundry-native backups, the assets caveat |
| [`docs/PROJECT.md`](docs/PROJECT.md) | FoundryVTT specifics for agents: MCP integration, content routing, safe A/B testing, container operations, security hard rules |
| [`CLAUDE.md`](CLAUDE.md) | Template-wide Claude workflow contract (kept byte-identical to the template so sync stays clean) |
| [`docs/CONTENT_AUTHORING.md`](docs/CONTENT_AUTHORING.md) | Content-as-code pipeline: author JSON → build compendium module → sync → import; skill-vs-MCP routing |
| [`docs/FOUNDRY_REBUILD.md`](docs/FOUNDRY_REBUILD.md) | Rebuild a wiped Foundry world from the durable sources (vault, git content module, D&D Beyond) |
| [`scripts/maps/README.md`](scripts/maps/README.md) | Spec-driven battlemap generator: Player PNG + keyed DM PNG + Foundry `.dd2vtt` |
| [`examples/vault-skeleton/`](examples/vault-skeleton/) | Copy-to-start Obsidian vault: taxonomy, blank Templater templates, generic guide notes |
| [`SECURITY.md`](SECURITY.md) | Credential handling and the files agents must never read |
| [`docs/TEMPLATE_GUIDE.md`](docs/TEMPLATE_GUIDE.md) | The template foundation: devcontainer, firewall, routing, CI gates, template-sync |
| [`docs/KANBAN_WORKFLOW.md`](docs/KANBAN_WORKFLOW.md) | Board-driven agent workflow (`/next-issue`, `/run-epic`) |

## Working on this repo (devcontainer)

This section is for **hacking on this repository**, not for running your game —
the game stack is just `docker compose up` from the Quickstart. Development
happens inside the devcontainer supplied by the
[claude_template_repo](https://github.com/Moon-Knight13/claude_template_repo)
foundation — a deny-by-default egress firewall, the Claude Code workflow, and
all CI gate tooling come preinstalled.

Prerequisites:

- Docker plus VS Code with the Dev Containers extension
- A Claude Code (CLI) account for the AI workflow
- Optional: [Ollama](https://ollama.com) on host port 11434 for local model
  routing

Steps:

1. Clone the repo, open it in VS Code, and accept **"Reopen in Container"**.
   Tooling installs on container start, including the day-0 auto-setup
   (`scripts/setup-day0.sh`).
2. Inside the container, finish the auth-gated bootstraps:

   ```bash
   gh auth login --hostname github.com --git-protocol https --web -s project && gh auth setup-git
   claude   # authenticate Claude Code on first launch
   bash scripts/setup-day0.sh   # re-run so the GitHub ruleset + board bootstraps apply
   ```

3. Verify with `bash scripts/check-day0.sh` — or `/day0-check` from inside
   Claude Code. Expect all green (Ollama is a non-blocking WARN if absent).

Notes:

- The firewall blocks unknown egress hosts by default; use the
  `/firewall-allow` skill to allowlist a new host. Full detail on the
  foundation lives in [`docs/TEMPLATE_GUIDE.md`](docs/TEMPLATE_GUIDE.md).
- The devcontainer has **no docker socket** by design — run the Foundry stack
  (`docker compose up -d`) from a host terminal, not from inside the
  container.

## Branch model

`main` is the single default branch — all PRs land there, and it carries a
protection ruleset (PR + review + required checks).

This repo used to run felddy's two-branch release model (`develop` for
integration, `main` for production, promoted by fast-forward). That model earns
its keep when a branch *is* the released artifact; here nothing is deployed from
a branch — the stack runs `docker compose up` against the published felddy
image. In practice the promotion was performed once, then `main` sat 24 commits
behind for five weeks and collected a template-sync PR aimed at the stale
branch. The old history is preserved at tag `archive/main-2026-08-09`.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Issues and PRs welcome — this repo
doubles as a reference for retrofitting the Claude template onto an existing
self-hosted service.

## License

Released under the [MIT license](LICENSE), matching the upstream project.
All contributions are released under the same license.

## Credits

- [felddy/foundryvtt-docker](https://github.com/felddy/foundryvtt-docker) —
  the container image and its excellent documentation
- [adambdooley/foundry-vtt-mcp](https://github.com/adambdooley/foundry-vtt-mcp)
  — the Foundry MCP bridge
- Foundry Virtual Tabletop is a trademark of Foundry Gaming, LLC. This
  project is unaffiliated; a valid FoundryVTT license is required.
