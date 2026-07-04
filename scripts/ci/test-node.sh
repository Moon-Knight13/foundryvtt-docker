#!/usr/bin/env bash
# CI test for the Node/TypeScript container utilities in src/.
# There are no Node unit tests (package.json "test" is a deliberate exit 1);
# the compile is the meaningful check here. Runtime behaviour is covered by
# the container tests in felddy's build workflow.
set -euo pipefail

npm ci --ignore-scripts --no-audit --no-fund
npm run build
