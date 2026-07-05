# Contributing

Thanks for your interest! This is a personal FoundryVTT deployment that
doubles as a reference for retrofitting the
[claude_template_repo](https://github.com/Moon-Knight13/claude_template_repo)
onto an existing self-hosted service. Issues and PRs are welcome — if you're
unsure about anything, open an issue and ask.

## Ground rules

- All PRs target `develop` (the default branch). `main` is production and is
  promotion-only.
- Both branches are protected: PRs need a passing check run
  (validate-template, semgrep, gitleaks) and a review.
- **Never commit credentials.** `.env`, `license.json`, and `cookiejar.json`
  are off-limits — see [SECURITY.md](SECURITY.md). Secret scanning and push
  protection are enabled; gitleaks runs in CI and pre-commit.

## Development environment

The repo ships a devcontainer (VS Code → "Reopen in Container") with all
tooling preinstalled, including the Claude Code workflow described in
[CLAUDE.md](CLAUDE.md) and [docs/TEMPLATE_GUIDE.md](docs/TEMPLATE_GUIDE.md).

Working outside the devcontainer: install
[pre-commit](https://pre-commit.com) and run `pre-commit install` so the
lint/security hooks run on commit.

## Testing your changes

```bash
bash scripts/validate-template.sh     # template integrity (CI runs this too)
bash scripts/tests/test-delegation.sh # model-routing test suite
bash scripts/tests/test-day0.sh       # day-0 bootstrap checks
```

Changes to the Foundry stack itself should be exercised against a disposable
clone, never the live data: `./scripts/test-instance.sh up` (see CLAUDE.md,
"Safe A/B testing").

## Licence

By submitting a pull request you agree to release your contribution under
this repository's [MIT license](LICENSE).

## Upstream

Bugs in the container image itself (entrypoint, launcher, image build)
belong upstream at
[felddy/foundryvtt-docker](https://github.com/felddy/foundryvtt-docker) —
this fork consumes the published image and does not build its own.

Stage upstream contributions through our clean fork,
[Moon-Knight13/foundryvtt-docker-upstream](https://github.com/Moon-Knight13/foundryvtt-docker-upstream):
branch there (off its `develop`), do the image work in that tree, and open
the PR from it against felddy/foundryvtt-docker. Keeping upstream work out of
this repo avoids mixing image-source changes with our deployment/AI-workflow
history.
