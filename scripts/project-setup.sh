#!/usr/bin/env bash
# Project-specific container setup for foundryvtt-docker.
#
# Project-specific container setup steps that run after the security baseline
# (firewall, pre-commit, plugins) is in place.
#
# Runs last in devcontainer.json's postStartCommand `&&` chain, so a non-zero
# exit marks the whole postStartCommand failed. Everything here therefore warns
# and continues rather than aborting — neither task is worth a broken container.
#
# Egress is deny-by-default (.devcontainer/init-firewall.sh). pypi.org and
# files.pythonhosted.org are on the allowlist, which is what makes the Pillow
# install below possible at container start.

set -euo pipefail

# 1. Pillow, for scripts/maps/render_map.py.
#
# Installed here rather than in .devcontainer/Dockerfile for historical
# reasons (template sync used to revert Dockerfile edits — sync PR #70 /
# issue #69; the repo is detached from sync now). Installing at start keeps
# working and avoids an image rebuild, so it stays.
if python3 -c "import PIL" 2>/dev/null; then
  echo "project-setup: Pillow already present."
elif pip install --quiet --break-system-packages --user Pillow; then
  echo "project-setup: Pillow installed."
else
  echo "project-setup: WARN Pillow install failed — scripts/maps/render_map.py"
  echo "  will not run. Retry manually:"
  echo "    pip install --break-system-packages --user Pillow"
fi

# 2. Obsidian vault symlink.
#
# devcontainer.json bind-mounts the host vault at /home/node/DnD; this exposes
# it inside the workspace as /workspace/DnD (gitignored). Previously inlined at
# the front of postStartCommand — moved here so the chain matches the template's
# apart from the trailing hook call.
if [[ -d /home/node/DnD ]]; then
  ln -sfn /home/node/DnD /workspace/DnD
  echo "project-setup: /workspace/DnD -> /home/node/DnD"
else
  echo "project-setup: no vault at /home/node/DnD; skipping symlink."
  echo "  Set DND_VAULT_PATH on the host and rebuild if you want it mounted."
fi
