# Self-hosted FoundryVTT in Docker — Cloudflare-tunneled, Obsidian-backed prep

[![ci](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/ci.yml)
[![semgrep](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/semgrep.yml/badge.svg?branch=main)](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/semgrep.yml)
[![secret-scan](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/secret-scan.yml/badge.svg?branch=main)](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/secret-scan.yml)
[![CodeQL](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/codeql-analysis.yml/badge.svg?branch=main)](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/codeql-analysis.yml)
[![content-tests](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/content-tests.yml/badge.svg?branch=main)](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/content-tests.yml)

A self-hosted **[Foundry Virtual Tabletop](https://foundryvtt.com)** server that
runs in **Docker** and is reachable remotely through a **Cloudflare Tunnel** —
no port forwarding, no inbound ports. Game prep lives in an **Obsidian vault**
(the DM's durable source of truth) and is projected into Foundry for online or
hybrid play, while the same notes run an **in-person** table with no export.
**Claude Code** assists prep — authoring content as code and driving the live
world over an MCP bridge.

This page is a landing pad. Anything past "how do I start it" lives in
[the documentation map](#documentation-map).

## How it fits together

- **FoundryVTT container** — the published
  [felddy/foundryvtt-docker](https://github.com/felddy/foundryvtt-docker) image
  (`ghcr.io/felddy/foundryvtt:release`) run via [`compose.yml`](compose.yml);
  this fork doesn't build its own image. Live data (worlds, modules) is
  bind-mounted from `FOUNDRY_DATA_PATH`.
- **Remote access** — an optional **Cloudflare Tunnel** overlay
  ([`compose.cloudflare.yml`](compose.cloudflare.yml)): `cloudflared` dials out
  to Cloudflare's edge, giving players a stable HTTPS URL with zero inbound
  ports. Locally it's just `http://localhost:30000`.
- **DM prep backbone** — an **Obsidian vault you own** is the system-agnostic
  source of truth. FoundryVTT is a transient projection you can wipe and rebuild
  from the vault, the git content module, and D&D Beyond.
- **AI game master (optional)** —
  [Claude Code](https://claude.com/claude-code) authors NPCs, items, quests and
  scenes as code compiled into a compendium module, and drives the running world
  over the [foundry-vtt-mcp](https://github.com/adambdooley/foundry-vtt-mcp)
  bridge.
- **Content pipeline** (`scripts/content/`) — vault notes compile into a
  per-game Foundry module: `compile-game.mjs` builds statblocks from SRD
  fences, token art resolves through a curated map with an **art-coverage
  gate** that proves no blank tokens, `build.mjs` packages the module, and
  `ship-game.sh` runs compile → gate → build → sync → Foundry restart in one
  command. Gated in CI by the `content-tests` workflow.

The repository itself is developed AI-first — devcontainer, deny-by-default
firewall, CI gates, Kanban flow — from
[claude_template_repo](https://github.com/Moon-Knight13/claude_template_repo).
That foundation exists to work **on this repo**, not to run your table; see
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Quickstart

```bash
git clone https://github.com/Moon-Knight13/foundryvtt-docker.git
cd foundryvtt-docker
cp .env.example .env          # fill in FoundryVTT credentials + admin key
./deploy-setup.sh             # guided setup — or edit .env by hand
docker compose up -d
```

Foundry answers on <http://localhost:30000>. Every environment variable the
image understands is documented in the
[upstream README](https://github.com/felddy/foundryvtt-docker#readme).

Point `DND_VAULT_PATH` in `.env` at your Obsidian vault (default
`~/Documents/DnD`); compose bind-mounts it into Foundry at `/data/Data/DnD` so
its images and handouts appear in the file picker. Starting from scratch:

```bash
cp -r examples/vault-skeleton "$DND_VAULT_PATH"
```

That ships the folder taxonomy, blank Templater templates and generic guide
notes — never anyone's campaign content. See
[`examples/vault-skeleton/README.md`](examples/vault-skeleton/README.md) for the
Obsidian plugins to enable.

Optional profiles:

```bash
docker compose --profile monitoring up -d   # Netdata :19999, Dozzle :8080 (loopback-only)
docker compose -f compose.yml -f compose.cloudflare.yml up -d   # remote access via Cloudflare Tunnel
```

## Documentation map

| Doc | What it covers |
| --- | --- |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | Deployment guide: env setup, profiles, monitoring, performance, troubleshooting |
| [`docs/PROJECT.md`](docs/PROJECT.md) | FoundryVTT specifics for agents: MCP integration, content routing, container operations, security hard rules |
| [`docs/CONTENT_AUTHORING.md`](docs/CONTENT_AUTHORING.md) | Content-as-code pipeline: compile statblocks, curated art map + coverage gate, build → sync → import; skill-vs-MCP routing |
| [`docs/FOUNDRY_REBUILD.md`](docs/FOUNDRY_REBUILD.md) | Rebuild a wiped Foundry world from the durable sources (vault, git content module, D&D Beyond) |
| [`examples/vault-skeleton/`](examples/vault-skeleton/) | Copy-to-start Obsidian vault: taxonomy, blank Templater templates, and the in-person/Foundry "two surfaces" guide |
| [`scripts/maps/README.md`](scripts/maps/README.md) | Spec-driven battlemap generator: Player PNG + keyed DM PNG + Foundry `.dd2vtt` |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Working on this repo: devcontainer setup, tests, branch model, upstream contributions |
| [`CLAUDE.md`](CLAUDE.md) | Claude workflow contract: priorities, board rules, guardrails |
| [`SECURITY.md`](SECURITY.md) | Credential handling and the files agents must never read |
| [upstream template](https://github.com/Moon-Knight13/claude_template_repo) | Where the devcontainer/firewall/CI foundation came from (this repo is detached from template sync) |
| [`docs/KANBAN_WORKFLOW.md`](docs/KANBAN_WORKFLOW.md) | Board-driven agent workflow (`/next-issue`, `/run-epic`) |
| [`docs/explainer/index.html`](docs/explainer/index.html) | Self-contained visual briefing of the whole system (also published via GitHub Pages) |

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
