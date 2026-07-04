#!/bin/bash
# Install (or update) the Foundry MCP server for Claude Code.
#
# Downloads the pinned foundry-vtt-mcp release and extracts the prebuilt
# standalone server into ./mcp-server/ (gitignored). Claude Code launches it
# via .mcp.json. Safe to re-run: it overwrites mcp-server/ in place.
#
# The companion Foundry module is normally installed through the Foundry UI
# (Setup → Add-on Modules → Install Module) with this manifest URL:
#   https://raw.githubusercontent.com/adambdooley/foundry-vtt-mcp/master/packages/foundry-module/module.json
# For offline installs, --with-module extracts the module zip directly into
# the Foundry data directory instead.
#
# Usage:
#   ./scripts/setup-mcp.sh                # install/update the MCP server
#   ./scripts/setup-mcp.sh --with-module  # also install the Foundry module
#                                         # into FOUNDRY_DATA_PATH (offline
#                                         # fallback; prefer the UI install)

set -e

# Keep in step with the installed Foundry module version (see CLAUDE.md,
# "Version drift"). Bump this and re-run when the module updates.
MCP_VERSION="0.8.2"
RELEASE_BASE="${MCP_DOWNLOAD_BASE:-https://github.com/adambdooley/foundry-vtt-mcp/releases/download/v${MCP_VERSION}}"
SERVER_ZIP="foundry-mcp-server-v${MCP_VERSION}.zip"
MODULE_ZIP="foundry-vtt-mcp.zip"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=scripts/lib/env-file.sh disable=SC1091
source "$REPO_ROOT/scripts/lib/env-file.sh"

WITH_MODULE=false
for arg in "$@"; do
  case "$arg" in
    --with-module) WITH_MODULE=true ;;
    -h | --help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -18
      exit 0
      ;;
    *)
      echo "❌ Unknown option: $arg (see --help)"
      exit 1
      ;;
  esac
done

# Preflight checks
if ! command -v node > /dev/null 2>&1; then
  echo "❌ node is required (>= 18). Install Node.js first."
  exit 1
fi
NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "❌ Node >= 18 required (found $(node --version))."
  exit 1
fi
for tool in curl unzip; do
  if ! command -v "$tool" > /dev/null 2>&1; then
    echo "❌ $tool is required."
    exit 1
  fi
done

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "📦 Downloading Foundry MCP server v${MCP_VERSION}..."
curl -fsSL "${RELEASE_BASE}/${SERVER_ZIP}" -o "$TMP_DIR/$SERVER_ZIP"
unzip -qo "$TMP_DIR/$SERVER_ZIP" -d "$TMP_DIR/server"

if [ ! -f "$TMP_DIR/server/standalone-mcp-server/index.js" ]; then
  echo "❌ Unexpected zip layout: standalone-mcp-server/index.js not found."
  exit 1
fi

# v0.8.x standalone zips omit backend.bundle.cjs (upstream packaging bug):
# index.js is only a stdio wrapper that spawns backend.bundle.cjs and proxies
# tool calls to it over 127.0.0.1:31414. Without the backend the wrapper
# retries for ~70s and Claude Code times out at 30s. Preserve a previously
# installed backend across reinstalls, and refuse to finish without one.
if [ -f mcp-server/backend.bundle.cjs ]; then
  cp mcp-server/backend.bundle.cjs "$TMP_DIR/backend.bundle.cjs.keep"
fi
rm -rf mcp-server
mkdir -p mcp-server
cp -a "$TMP_DIR"/server/standalone-mcp-server/. mcp-server/
if [ ! -f mcp-server/backend.bundle.cjs ] && [ -f "$TMP_DIR/backend.bundle.cjs.keep" ]; then
  cp "$TMP_DIR/backend.bundle.cjs.keep" mcp-server/backend.bundle.cjs
  echo "ℹ️  Restored backend.bundle.cjs from the previous install (missing from the release zip)."
fi
if [ ! -f mcp-server/backend.bundle.cjs ]; then
  echo "❌ backend.bundle.cjs is missing: the standalone zip ships only the stdio wrapper."
  echo "   Extract foundry-mcp-server/packages/mcp-server/dist/backend.bundle.cjs from the"
  echo "   FoundryMCPServer-Setup-v${MCP_VERSION}.exe release asset (7zz x Setup.exe) into mcp-server/."
  exit 1
fi
echo "✅ MCP server installed to mcp-server/ ($(du -h mcp-server/index.js | cut -f1) index.js, $(du -h mcp-server/backend.bundle.cjs | cut -f1) backend)"

if [ "$WITH_MODULE" = true ]; then
  DATA_PATH="$(get_env_value FOUNDRY_DATA_PATH)"
  DATA_PATH="${DATA_PATH:-$HOME/.local/share/FoundryVTT}"
  # Expand a leading ~ (values in .env are not shell-expanded)
  DATA_PATH="${DATA_PATH/#\~/$HOME}"
  MODULE_DIR="$DATA_PATH/Data/modules/foundry-mcp-bridge"

  if [ ! -d "$DATA_PATH/Data" ]; then
    echo "❌ Foundry data directory not found at $DATA_PATH"
    echo "   Set FOUNDRY_DATA_PATH in .env or start the container once first."
    exit 1
  fi

  echo "📦 Downloading Foundry module (foundry-mcp-bridge) v${MCP_VERSION}..."
  curl -fsSL "${RELEASE_BASE}/${MODULE_ZIP}" -o "$TMP_DIR/$MODULE_ZIP"
  # The zip root IS the module content; the folder name must stay exactly
  # foundry-mcp-bridge or the backend's socket routing breaks.
  rm -rf "$MODULE_DIR"
  mkdir -p "$MODULE_DIR"
  unzip -qo "$TMP_DIR/$MODULE_ZIP" -d "$MODULE_DIR"
  echo "✅ Module installed to $MODULE_DIR"
else
  echo "ℹ️  Foundry module not installed by this script. Install it in the"
  echo "   Foundry UI (Setup → Add-on Modules → Install Module) with manifest:"
  echo "   https://raw.githubusercontent.com/adambdooley/foundry-vtt-mcp/master/packages/foundry-module/module.json"
fi

echo ""
echo "Next steps:"
echo "  1. Enable 'Foundry MCP Bridge' in your world (Manage Modules) and turn"
echo "     on 'Allow Write Operations' in the module settings."
echo "  2. Restart Claude Code from the repo root and check /mcp — the"
echo "     'foundry-mcp' server should be connected."
echo "  3. Keep a GM browser session open while using MCP tools."
echo ""
echo "For safe testing against a cloned instance first, see"
echo "  ./scripts/test-instance.sh (and CLAUDE.md, 'Safe A/B testing')."
