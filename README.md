# FoundryVTT server + Claude Code AI game master

[![ci](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/ci.yml)
[![semgrep](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/semgrep.yml/badge.svg?branch=develop)](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/semgrep.yml)
[![secret-scan](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/secret-scan.yml/badge.svg?branch=develop)](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/secret-scan.yml)
[![CodeQL](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/codeql-analysis.yml/badge.svg?branch=develop)](https://github.com/Moon-Knight13/foundryvtt-docker/actions/workflows/codeql-analysis.yml)

A self-hosted [Foundry Virtual Tabletop](https://foundryvtt.com) deployment
where **Claude Code acts as an AI game master** — creating NPCs, quests,
journals, and scenes directly in the live world over an MCP bridge — and where
the repository itself is operated by AI agents under a governed workflow.

Three things compose it:

1. **[felddy/foundryvtt-docker](https://github.com/felddy/foundryvtt-docker)**
   (this repo's upstream) supplies the battle-tested container image. We run
   the published `ghcr.io/felddy/foundryvtt:release` image via
   [`compose.yml`](compose.yml) — this fork does not build its own image.
2. **[claude_template_repo](https://github.com/Moon-Knight13/claude_template_repo)**
   supplies the AI-development foundation: a devcontainer with a
   deny-by-default firewall, model routing (Claude ↔ local Ollama),
   gitleaks/semgrep/CodeQL gates, a GitHub-Projects Kanban flow, BMAD
   planning, and weekly template-sync PRs.
3. **[foundry-vtt-mcp](https://github.com/adambdooley/foundry-vtt-mcp)**
   bridges the two: a Foundry module + MCP server that lets Claude Code read
   and write the running world (see [`CLAUDE.md`](CLAUDE.md) for setup,
   ports, and the game-creation workflow).

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
docker compose --profile ngrok up -d        # temporary remote access (see DEPLOYMENT.md)
```

### AI game master (MCP)

```bash
./scripts/setup-mcp.sh        # installs the MCP server into mcp-server/
# install the foundry-mcp-bridge module via the Foundry UI, enable it in a
# world, turn on "Allow Write Operations", keep a GM browser tab open
claude                        # Claude Code picks up .mcp.json from the repo root
```

Test module changes against a disposable clone first —
`./scripts/test-instance.sh up` starts a full copy of your live data on
:30001 (see [`CLAUDE.md`](CLAUDE.md), "Safe A/B testing").

## Documentation map

| Doc | What it covers |
|---|---|
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | Full deployment guide: env setup, profiles, monitoring, performance, troubleshooting |
| [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md) | Backup and restore: SCP/rsync pull from a remote host, Foundry-native backups, the assets caveat |
| [`CLAUDE.md`](CLAUDE.md) | Claude workflow contract + FoundryVTT specifics: MCP integration, safe A/B testing, security hard rules |
| [`SECURITY.md`](SECURITY.md) | Credential handling and the files agents must never read |
| [`docs/TEMPLATE_GUIDE.md`](docs/TEMPLATE_GUIDE.md) | The template foundation: devcontainer, firewall, routing, CI gates, template-sync |
| [`docs/KANBAN_WORKFLOW.md`](docs/KANBAN_WORKFLOW.md) | Board-driven agent workflow (`/next-issue`, `/run-epic`) |
| [`docs/cookbooks/`](docs/cookbooks/) | Recipes — e.g. Cloudflare Tunnel for permanent remote access |

## Branch model

`develop` is the default and integration branch — all PRs land there.
`main` is production; promotion is a fast-forward push after verification.
Both branches carry protection rulesets (PR + review + required checks).

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
