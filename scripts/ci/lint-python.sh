#!/usr/bin/env bash
# CI lint for the Python test suite, using the repo's existing configs
# (.flake8, .isort.cfg). Invoked by .github/workflows/ci.yml when
# pyproject.toml is detected.
set -euo pipefail

python3 -m pip install --quiet --upgrade \
  flake8 flake8-bugbear flake8-comprehensions flake8-docstrings pep8-naming isort

python3 -m flake8 --config .flake8 src tests
python3 -m isort --check-only --settings-path .isort.cfg src tests
