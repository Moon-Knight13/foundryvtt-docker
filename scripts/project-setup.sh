#!/usr/bin/env bash
# Project-specific container setup for foundryvtt-docker.
#
# This is the template's derivative extension point (docs/TEMPLATE_GUIDE.md,
# "Project-specific container setup"). The template ships it as a no-op; this
# copy is ours and is listed in .templatesyncignore so sync stops proposing the
# no-op back.
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
# This used to be `python3-pil` in .devcontainer/Dockerfile, but that file is
# template-owned and not ignore-listed, so template-sync deleted the line (it
# did exactly that in sync PR #70 — see issue #69). Installing here keeps the
# Dockerfile byte-identical to the template, which is what lets devcontainer
# security fixes keep flowing down.
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
