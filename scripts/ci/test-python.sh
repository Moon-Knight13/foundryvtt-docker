#!/usr/bin/env bash
# CI test for the Python suite. Runs the unit tests that drive src/*.sh via
# subprocess. Container tests (tests/container_test.py) need a built foundry
# image + docker and stay in felddy's build workflow, so they are excluded.
set -euo pipefail

python3 -m pip install --quiet --upgrade pytest hypothesis docker

python3 -m pytest tests/ \
  --ignore=tests/container_test.py \
  -p no:cacheprovider
