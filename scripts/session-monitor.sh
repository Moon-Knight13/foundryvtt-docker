#!/bin/bash
# Log host memory pressure and Foundry container stats during a game session.
# Start it before the session, Ctrl+C after. One CSV row every 5 seconds.
#
#   scripts/session-monitor.sh            # logs to ~/session-monitor-<date>.csv
#   scripts/session-monitor.sh /path/out  # custom output file
set -euo pipefail

OUT=${1:-"$HOME/session-monitor-$(date +%F-%H%M).csv"}
FOUNDRY=foundryvtt-docker-foundry-1

echo "time,mem_available_mb,swap_used_mb,psi_some_avg10,psi_full_avg10,foundry_mem_mb,foundry_cpu_pct,foundry_restarts" >"$OUT"
echo "logging to $OUT every 5s — Ctrl+C to stop"

while true; do
  avail=$(awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo)
  swap=$(awk 'NR==2{printf "%d", $4/1024}' /proc/swaps)
  some=$(awk -F'avg10=' '/some/{split($2,x," ");print x[1]}' /proc/pressure/memory)
  full=$(awk -F'avg10=' '/full/{split($2,x," ");print x[1]}' /proc/pressure/memory)
  stats=$(docker stats --no-stream --format '{{.MemUsage}},{{.CPUPerc}}' "$FOUNDRY" 2>/dev/null || echo "down,down")
  fmem=$(echo "$stats" | cut -d, -f1 | awk -F/ '{print $1}' | tr -d ' MiB' | cut -dG -f1)
  fcpu=$(echo "$stats" | cut -d, -f2 | tr -d '%')
  restarts=$(docker inspect "$FOUNDRY" --format '{{.RestartCount}}' 2>/dev/null || echo "?")
  echo "$(date +%T),$avail,$swap,$some,$full,$fmem,$fcpu,$restarts" >>"$OUT"
  sleep 5
done
