#!/usr/bin/env bash
# Foundry MCP connection diagnostic — read-only.
#
# Answers "why does every MCP tool say 'Foundry VTT module not connected'?"
# by pinning WHICH hop is down. The chain is:
#
#   GM browser (foundry-mcp-bridge module)  --ws-->  backend :31415
#   backend  <--control-->  MCP server :31414 (127.0.0.1)
#   MCP server  <--stdio-->  Claude Code
#
# The backend side is almost always fine (this script confirms it); the hop
# that breaks is browser-module -> backend:31415. This script checks the three
# backend ports and the backend/server processes, then inspects :31415 for an
# established peer — if the port listens but no browser is connected, it prints
# the exact browser-side recovery steps.
#
# Read-only: inspects ports (ss) and processes (pgrep) only. It never reads
# .env, license.json, cookiejar.json, or any world/data file.
#
# Usage: mcp-health.sh
# Exit:  0  backend up AND module connected  ("connected path healthy")
#        1  a hop is down (message says which, with the fix)
set -euo pipefail

# Port map (see CLAUDE.md, "Foundry MCP integration"). Overridable for tests.
MCP_CONTROL_PORT="${MCP_CONTROL_PORT:-31414}" # MCP server <-> backend control (127.0.0.1)
MCP_BRIDGE_PORT="${MCP_BRIDGE_PORT:-31415}"   # Foundry module -> backend WebSocket
MCP_WEBRTC_PORT="${MCP_WEBRTC_PORT:-31416}"   # WebRTC signaling (unused locally)
: "${MCP_BRIDGE_PORT:?bridge port must be set}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVCONTAINER_JSON="$REPO_ROOT/.devcontainer/devcontainer.json"

for tool in ss pgrep; do
  if ! command -v "$tool" > /dev/null 2>&1; then
    echo "❌ $tool is required for the diagnostic (install iproute2 / procps)."
    exit 1
  fi
done

# True if something is LISTENING on the given TCP port (any local address).
port_listening() {
  local port="${1:?port required}"
  ss -tlnH 2> /dev/null | awk '{print $4}' | grep -qE "[:.]${port}\$"
}

# True if the given TCP port has at least one ESTABLISHED peer connection.
has_established_peer() {
  local port="${1:?port required}"
  ss -tnH state established 2> /dev/null \
    | awk '{print $3, $4}' | grep -qE "[:.]${port}( |\$)"
}

echo "🔎 Foundry MCP connection diagnostic"
echo ""

# --- Backend ports -----------------------------------------------------------
ports_ok=true
for entry in \
  "${MCP_BRIDGE_PORT}:module WebSocket (browser -> backend)" \
  "${MCP_CONTROL_PORT}:server<->backend control" \
  "${MCP_WEBRTC_PORT}:WebRTC signaling"; do
  port="${entry%%:*}"
  desc="${entry#*:}"
  if port_listening "$port"; then
    echo "✅ port ${port} listening — ${desc}"
  else
    echo "❌ port ${port} NOT listening — ${desc}"
    ports_ok=false
  fi
done

# --- Processes ---------------------------------------------------------------
backend_up=true
if pgrep -f 'backend\.bundle\.cjs' > /dev/null 2>&1; then
  echo "✅ backend process present (backend.bundle.cjs)"
else
  echo "❌ backend process not found (backend.bundle.cjs)"
  backend_up=false
fi

server_count="$(pgrep -fc 'mcp-server/index.js' 2> /dev/null || echo 0)"
echo "ℹ️  mcp-server (stdio wrapper) processes: ${server_count}"

echo ""

# --- Backend-side verdict ----------------------------------------------------
if [ "$ports_ok" != true ] || [ "$backend_up" != true ]; then
  echo "❌ Backend side is DOWN — the MCP server/backend is not fully up."
  echo "   Fix the backend first, then re-check the browser hop:"
  echo "     1. (Re)install the server:  ./scripts/setup-mcp.sh"
  echo "     2. Restart Claude Code from the repo root and check /mcp."
  echo "     3. Ensure ports ${MCP_CONTROL_PORT}-${MCP_WEBRTC_PORT} are free on the host"
  echo "        (a stale foundry-mcp-backend.lock can hold them)."
  exit 1
fi

# --- Browser-module hop ------------------------------------------------------
# Backend is healthy. The remaining failure mode is the browser module never
# completing (or losing) its WebSocket to :${MCP_BRIDGE_PORT}.
if has_established_peer "$MCP_BRIDGE_PORT"; then
  echo "✅ connected path healthy — a client is connected on :${MCP_BRIDGE_PORT}."
  exit 0
fi

echo "❌ Backend is UP but NO browser module is connected on :${MCP_BRIDGE_PORT}."
echo "   The failing hop is  GM browser (foundry-mcp-bridge) -> backend:${MCP_BRIDGE_PORT}."
echo ""
echo "   Browser-side recovery (do these in order):"
echo "     1. 'Enabled' is not 'connected'. In the GM tab open the module's"
echo "        connection-status indicator (Module Settings → Foundry MCP Bridge)"
echo "        and confirm it says connected, not just that the toggle is on."
echo "     2. Backend host/port in the module settings must be this backend:"
echo "        host reachable from the browser, port ${MCP_BRIDGE_PORT}."
echo "     3. The handshake only succeeds if the module connects AFTER the"
echo "        backend is up. Hard-refresh the GM tab now (Ctrl/Cmd+Shift+R) so"
echo "        it reconnects to the already-running backend."
echo "     4. Still down? Open browser DevTools → Console and look for the"
echo "        module's WebSocket error (connection refused / wrong host)."
echo "     5. A GM browser session must stay open — the module is client-side;"
echo "        every MCP tool fails with the tab closed."

# --- Port-forward caveat (background-job vs interactive devcontainer) ---------
# The host browser reaches :${MCP_BRIDGE_PORT} through a devcontainer port
# forward. That forward is declared for the INTERACTIVE devcontainer only; a
# background-job / remote Claude session can run in a different container whose
# :${MCP_BRIDGE_PORT} the host browser does not forward to.
if [ -f /.dockerenv ] || [ "${REMOTE_CONTAINERS:-}" = "true" ]; then
  echo ""
  echo "   ⚠️  Port-forward caveat — this diagnostic is running INSIDE a container"
  echo "       (host: $(hostname)). The backend is only reachable from the host"
  echo "       browser if THIS is the container whose :${MCP_BRIDGE_PORT} is forwarded."
  if [ -f "$DEVCONTAINER_JSON" ] && grep -q "${MCP_BRIDGE_PORT}" "$DEVCONTAINER_JSON"; then
    echo "       .devcontainer/devcontainer.json forwards :${MCP_BRIDGE_PORT} for the"
    echo "       interactive devcontainer. If you started this session as a"
    echo "       background job / separate container, the browser's"
    echo "       localhost:${MCP_BRIDGE_PORT} points at a DIFFERENT container — run the"
    echo "       MCP backend in the forwarded interactive devcontainer instead."
  fi
fi

exit 1
