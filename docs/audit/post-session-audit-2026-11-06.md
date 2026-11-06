# Post-Session Security Audit — 2026-11-06

**Repository:** Moon-Knight13/foundryvtt-docker
**Branch:** main (`85d87b2`)
**Scope:** Secrets, dead code, Docker security, dependencies, git hygiene, recent commits

## Summary

| Severity | Count |
|----------|-------|
| Critical | 2     |
| High     | 5     |
| Medium   | 5     |
| Low      | 3     |
| Info     | 4     |
| **Total**| **19**|

---

## Critical

### C-1: PEM files recoverable from git history

`src/secrets/fullchain.pem` and `src/secrets/privkey.pem` were committed in early
history (commits `35f4070` through `407f21b`) and later deleted. They are gone
from HEAD but remain recoverable via `git show <sha>:src/secrets/fullchain.pem`.

**Risk:** Anyone who clones or forks the repo can extract the private key.
**Fix:** If these certificates were ever used in production, **rotate them
immediately**. Consider `git filter-repo` or BFG to purge the blobs, then
force-push (coordinate with any forks).

### C-2: Dependabot — 1 critical vulnerability open

| Package  | Severity | Range              |
|----------|----------|--------------------|
| certifi  | critical | >= 2019.03.09, < 2026.10.18 |

This is a Python CA bundle used by `pre-commit` (installed in the devcontainer).
**Fix:** Bump certifi or rebuild the devcontainer image with updated packages.

---

## High

### H-1: Unpinned container images (supply-chain risk)

| File                    | Image                          |
|-------------------------|--------------------------------|
| `compose.cloudflare.yml:29` | `cloudflare/cloudflared:latest` |
| `compose.yml:125`       | `amir20/dozzle:latest`         |

The cloudflared file already contains a comment explaining how to pin to a
digest. Dozzle has no such note.
**Fix:** Pin both to `image@sha256:<digest>`. Automate digest rotation with
Dependabot or Renovate.

### H-2: Docker socket mounted to monitoring containers

```
compose.yml:121  /var/run/docker.sock:/var/run/docker.sock:ro  (netdata)
compose.yml:135  /var/run/docker.sock:/var/run/docker.sock:ro  (dozzle)
```

Read-only Docker socket still permits full Docker API access (container
creation, exec, image pull). A compromised monitoring container gains host-level
control.

**Mitigations already present:** Both are in the `monitoring` profile (not
started by default) and bound to `127.0.0.1`. These reduce — but do not
eliminate — the risk.
**Fix:** Use a socket proxy (e.g., `tecnativa/docker-socket-proxy`) that
exposes only the read-only API subset each tool needs.

### H-3: Netdata runs with SYS_PTRACE + apparmor:unconfined

`compose.yml:114-117` — Required by Netdata for process monitoring, but
combined with Docker socket access it maximises blast radius if Netdata is
compromised. No `cap_drop: [ALL]` baseline.
**Fix:** Add `cap_drop: [ALL]` then `cap_add` only what is needed. Evaluate
whether `apparmor:unconfined` can be replaced with a custom profile.

### H-4: No container health checks

None of the four services (foundry, cloudflared, netdata, dozzle) define a
`healthcheck`. Docker cannot detect a hung process vs. a healthy one.
**Fix:** Add health checks. Foundry: `curl -f http://localhost:30000` or a
Node.js liveness probe. Cloudflared: `cloudflared tunnel info` or TCP check.

### H-5: Dependabot — 18 high-severity vulnerabilities

| Package     | Count | Notes |
|-------------|-------|-------|
| virtualenv  | 11    | Multiple CVEs across version ranges |
| urllib3     | 2     | HTTP client vulnerabilities |
| filelock    | 1     | |
| js-yaml     | 1     | YAML parsing — relevant to content pipeline |

All from the Python/Node dependency trees in the devcontainer.
**Fix:** Batch-upgrade virtualenv and urllib3 in devcontainer build or pin
updated versions. js-yaml: update `package-lock.json` in `scripts/content/`.

---

## Medium

### M-1: Foundry container may run as root

`compose.yml` sets no `user:` directive. The `felddy/foundryvtt:release` image
defaults to root unless `CONTAINER_UID`/`CONTAINER_GID` are set. Neither appears
in `.env.example` or `compose.yml`.
**Fix:** Set `CONTAINER_UID=1000` and `CONTAINER_GID=1000` (or appropriate
values) in `.env.example` and document it.

### M-2: No `security_opt: [no-new-privileges:true]` on production containers

Foundry and cloudflared containers lack `no-new-privileges`, allowing setuid
escalation inside the container.
**Fix:** Add `security_opt: [no-new-privileges:true]` to both services.

### M-3: Host filesystem bind mounts are read-write

The Foundry data path and DnD vault are both mounted R/W. The vault mount is
documented as intentionally R/W (Foundry writes into it), but a container
compromise exposes both directories.
**Fix:** Consider `:ro` for the DnD vault if Foundry write access is not
actively used. Document the risk/decision either way.

### M-4: No custom network segmentation

All services share the default compose bridge network. Monitoring containers
(which mount the Docker socket) can reach Foundry on port 30000 and vice versa.
**Fix:** Define separate networks: one for foundry+cloudflared, one for
monitoring. Isolate Docker-socket-mounting containers from the application.

### M-5: 15 medium-severity Dependabot alerts

Spread across filelock (6), virtualenv (5), urllib3 (1), and others.
All in devcontainer dependency trees.

---

## Low

### L-1: Duplicate scripts across monorepo

`sync-content.sh` and `foundry-mcp-guard.sh` exist in both `scripts/` and
`plugins/foundry-gm-claude/foundry-gm/`. Expected after the monorepo fold
(`20e68b8`), but creates drift risk if one copy is updated without the other.
**Fix:** Verify which is canonical; symlink or remove the duplicate.

### L-2: `test-instance.sh` is dead code

`docs/PROJECT.md:348` explicitly documents: "There is no second instance.
`scripts/test-instance.sh` (still present, no [callers])." No workflow, script,
or config references it.
**Fix:** Remove or archive.

### L-3: 7 low-severity Dependabot alerts

Across filelock (3) and virtualenv (4). Low risk, batch with other updates.

---

## Info (no action required)

### I-1: `.gitignore` coverage is comprehensive

Covers `.env`, `.env.*`, `*.key`, `*.pem`, `*.cert`, `secrets.*`, `*.p12`,
`*.pfx`, `license.json`, `cookiejar.json`. No gaps found.

### I-2: No `.env` files committed

Only `.env.example` exists in the repo. No deleted `.env` files in git history.

### I-3: Workflow expressions are safe

All `github.event.*` references in workflow files appear in `if:` conditions
(expression context), not in `run:` blocks (shell context). The one
`${{ steps.check.outputs.rotted }}` in `pin-freshness.yml:82` is in a `run:`
block, but the value comes from the workflow's own step output (not external
input) — minimal injection risk.

### I-4: Devcontainer Dockerfile follows good practices

- Runs as non-root `node` user
- SHA256-verifies all downloaded binaries (gh, git-delta, zsh-in-docker)
- Builds gitleaks from source to avoid upstream CVE
- Pins base image by digest
- GitHub auth explicitly directed to `gh auth login` (browser OAuth), not env vars

---

## Recent commits review (last 10)

| Commit   | Risk | Notes |
|----------|------|-------|
| `85d87b2` | None | Pin-freshness workflow fix — skip rotted pins |
| `097350e` | None | Docs only (deployment guide) |
| `bf5c1a5` | Low  | Large feature (pregens) — adds many scripts, no secrets |
| `44f49cd` | None | Fix: create bind-mount dirs before Docker |
| `20e68b8` | Low  | Monorepo fold — introduced duplicate scripts (L-1) |
| `ed944fc` | None | Good: adds mem_limit, log caps, restart policy |
| `9e4ef37` | None | Dependabot: GitHub Actions version bumps |
| `f239e69` | None | Content fix — SVG sizing |
| `857a9ea` | None | Content fix — token sizing |
| `464663d` | None | Script path fix |

No secrets, credentials, or dangerous patterns found in recent commits.

---

## Dependabot severity breakdown (41 open alerts)

| Severity | Count | Key packages |
|----------|-------|--------------|
| Critical | 1     | certifi |
| High     | 18    | virtualenv (11), urllib3 (2), js-yaml (1), filelock (1) |
| Medium   | 15    | filelock (6), virtualenv (5), urllib3 (1) |
| Low      | 7     | filelock (3), virtualenv (4) |

Most alerts stem from Python tooling (virtualenv, certifi, urllib3) installed
in the devcontainer via `pre-commit`. The js-yaml alert affects the content
pipeline's Node dependencies.

---

*Audit-only. No fixes applied. No push.*
