#!/bin/bash

# Define terminal colors for use in logger functions
BLUE="\e[34m"
GREEN="\e[32m"
RED="\e[31m"
RESET="\e[0m"
YELLOW="\e[33m"

# Debug logging is historically gated on CONTAINER_VERBOSE being *set* (any
# value, even "false"). Normalize falsy values to unset so CONTAINER_VERBOSE=false
# actually disables debug output and the ${CONTAINER_VERBOSE+...} expansions
# elsewhere behave as documented.
case "${CONTAINER_VERBOSE:-}" in
  "" | false | FALSE | 0 | no | NO)
    unset CONTAINER_VERBOSE
    ;;
esac

# Mimic the winston logging used in logging.js
log_debug() {
  if [[ "${CONTAINER_VERBOSE:-}" ]]; then
    echo -e "${LOG_NAME} | $(date +%Y-%m-%d\ %H:%M:%S) | [${BLUE}debug${RESET}] $*"
  fi
}

log() {
  echo -e "${LOG_NAME} | $(date +%Y-%m-%d\ %H:%M:%S) | [${GREEN}info${RESET}] $*"
}

log_warn() {
  echo -e "${LOG_NAME} | $(date +%Y-%m-%d\ %H:%M:%S) | [${YELLOW}warn${RESET}] $*"
}

log_error() {
  echo -e "${LOG_NAME} | $(date +%Y-%m-%d\ %H:%M:%S) | [${RED}error${RESET}] $*"
}
