# CI Script Hooks

`ci.yml` detects language markers at the repository root and, when one is
found, runs the matching `lint-<lang>.sh` / `test-<lang>.sh` from this folder.
If a marker is detected and its scripts are missing, CI fails by design.

This repository has no root-level language marker — it is a Docker Compose
stack, a devcontainer, and shell scripts — so no hook in this folder is
currently required, and none is present.

The one Node package here, `scripts/content/` (the content-as-code build), is
**not** at the repository root, so root detection does not see it. Its tests
run from a dedicated workflow (`.github/workflows/content-tests.yml`) rather
than through these hooks.

Add a hook here only if a language marker (`package.json`, `pyproject.toml`,
`go.mod`, `Cargo.toml`, `pom.xml`) lands at the repository root.
