#!/bin/bash
# Shared .env reader. Source this file; do not execute it.
#
# get_env_value VAR — print VAR's value from ./.env (empty if absent).
# Reads a single variable, never dumps the file (see CLAUDE.md security rules).
# Strips one pair of surrounding single or double quotes, matching how docker
# compose interprets .env — so a quoted FOUNDRY_DATA_PATH behaves identically
# for compose and for the shell scripts that read it.
get_env_value() {
  local var_name=$1
  local val=""
  if [ -f .env ]; then
    val="$(grep -E "^${var_name}=" .env | head -n1 | cut -d= -f2-)"
  fi
  if [ "${#val}" -ge 2 ]; then
    case "$val" in
      \"*\") val="${val#\"}"; val="${val%\"}" ;;
      \'*\') val="${val#\'}"; val="${val%\'}" ;;
    esac
  fi
  printf '%s\n' "$val"
}
