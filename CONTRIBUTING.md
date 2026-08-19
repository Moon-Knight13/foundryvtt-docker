# Contributing

Thanks for your interest! This is a personal FoundryVTT deployment that
doubles as a reference for retrofitting the
[claude_template_repo](https://github.com/Moon-Knight13/claude_template_repo)
onto an existing self-hosted service. Issues and PRs are welcome — if you're
unsure about anything, open an issue and ask.

## Ground rules

- All PRs target `main`, the single default branch.
- `main` is protected: PRs need passing check runs (validate-template,
  semgrep, gitleaks; content-tests, CodeQL, dependency-review and
  container-scan also run) and a review.
- **Never commit credentials.** `.env`, `license.json`, and `cookiejar.json`
  are off-limits — see [SECURITY.md](SECURITY.md). Secret scanning and push
  protection are enabled; gitleaks runs in CI and pre-commit.

## Development environment

This is for **hacking on this repository**, not for running your game — the
game stack is just `docker compose up` from the README quickstart. Development
happens inside the devcontainer supplied by the
[claude_template_repo](https://github.com/Moon-Knight13/claude_template_repo)
foundation: a deny-by-default egress firewall, the Claude Code workflow, and
all CI gate tooling come preinstalled.

Prerequisites: Docker, VS Code with the Dev Containers extension, and a Claude
Code (CLI) account for the AI workflow.

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
   Claude Code. Expect all green.

Notes:

- The firewall blocks unknown egress hosts by default; use the
  `/firewall-allow` skill to allowlist a new host. The devcontainer/firewall
  foundation came from
  [claude_template_repo](https://github.com/Moon-Knight13/claude_template_repo)
  (this repo is detached from template sync; every file here is repo-owned).
- The devcontainer has **no docker socket** by design — run the Foundry stack
  (`docker compose up -d`) from a host terminal, not from inside the container.

Working outside the devcontainer: install
[pre-commit](https://pre-commit.com) and run `pre-commit install` so the
lint/security hooks run on commit.

## Testing your changes

```bash
bash scripts/validate-template.sh     # template integrity (CI runs this too)
bash scripts/tests/test-day0.sh       # day-0 bootstrap checks
cd scripts/content && npm ci && npm test   # content-pipeline build + roundtrip
```

Changes to the Foundry stack itself are exercised against the live stack, with
a data-dir snapshot taken first as the undo path — see
[docs/FOUNDRY_REBUILD.md](docs/FOUNDRY_REBUILD.md). Take the snapshot between
sessions, not on game night.

## Branch model

`main` is the single default branch — all PRs land there, and it carries a
protection ruleset (PR + review + required checks).

This repo used to run felddy's two-branch release model (`develop` for
integration, `main` for production, promoted by fast-forward). That model earns
its keep when a branch *is* the released artifact; here nothing is deployed from
a branch — the stack runs `docker compose up` against the published felddy
image. In practice the promotion was performed once, then `main` sat 24 commits
behind for five weeks and collected automation PRs aimed at the stale branch.
The old history is preserved at tag `archive/main-2026-08-09`.

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
