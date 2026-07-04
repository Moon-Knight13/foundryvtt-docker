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

# Get environment variable value from .env (same idiom as deploy-setup.sh —
# reads a single variable, never dumps the file)
get_env_value() {
  local var_name=$1
  if [ -f .env ]; then
    grep -E "^${var_name}=" .env | head -n1 | cut -d= -f2-
  fi
}

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

rm -rf mcp-server
mkdir -p mcp-server
cp -a "$TMP_DIR"/server/standalone-mcp-server/. mcp-server/
echo "✅ MCP server installed to mcp-server/ ($(du -h mcp-server/index.js | cut -f1) index.js)"

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
