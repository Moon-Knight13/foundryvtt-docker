#!/usr/bin/env bash
# PreToolUse hook: route bulk content authoring away from foundry-mcp.
#
# Content creation through the MCP bridge burns tokens (fat tool schemas +
# JSON results in context) and leaves nothing versioned in the repo. The
# foundry-content skill (content/src + scripts/content/build.mjs) is the
# canonical path for new NPCs, quest journals, and bulk content.
#
# Guarded tools deny with a pointer to the skill. Overrides for genuine
# live-session work:
#   touch .ai/foundry-live-session      # per-checkout, delete when done
#   export FOUNDRY_MCP_WRITES=allow     # per-shell, before launching claude
set -euo pipefail

INPUT=$(cat)
TOOL=$(jq -r '.tool_name // empty' <<<"$INPUT")

case "$TOOL" in
  mcp__foundry-mcp__dnd5e-create-npc | mcp__foundry-mcp__create-quest-journal) ;;
  *) exit 0 ;;
esac

if [[ "${FOUNDRY_MCP_WRITES:-}" == "allow" ]]; then
  exit 0
fi
if [[ -f "${CLAUDE_PROJECT_DIR:-.}/.ai/foundry-live-session" ]]; then
  exit 0
fi

jq -n --arg tool "$TOOL" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: ("\($tool) is guarded: bulk content authoring goes through the foundry-content skill, not foundry-mcp. Author JSON under content/src/ from the skill templates, run `node scripts/content/build.mjs`, then have the user run scripts/content/sync-content.sh on the host and import via the Foundry UI. Only if this is genuinely a live-session one-off, the user can override with `touch .ai/foundry-live-session` or FOUNDRY_MCP_WRITES=allow, then retry.")
  }
}'
