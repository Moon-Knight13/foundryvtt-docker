#!/usr/bin/env bash
# CI lint for the Node/TypeScript container utilities in src/.
# Invoked by .github/workflows/ci.yml when package.json is detected.
set -euo pipefail

npm ci --ignore-scripts --no-audit --no-fund
npx tsc --noEmit
