#!/usr/bin/env bash
# Kill stale sudocode-mcp processes that outlived their Cursor/Claude hosts.
#
# Usage:
#   ./scripts/cleanup-stale-mcp.sh           # kill mcp older than 24h
#   ./scripts/cleanup-stale-mcp.sh 6        # kill mcp older than 6h
#   ./scripts/cleanup-stale-mcp.sh 0        # kill ALL sudocode-mcp
#   ./scripts/cleanup-stale-mcp.sh --dry-run
set -euo pipefail

MAX_HOURS=24
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *) MAX_HOURS="$arg" ;;
  esac
done

# etime formats: [[dd-]hh:]mm:ss
etime_to_hours() {
  local etime="$1"
  local days=0 hours=0 mins=0 secs=0
  if [[ "$etime" == *-* ]]; then
    days="${etime%%-*}"
    etime="${etime#*-}"
  fi
  IFS=: read -r a b c <<<"$etime"
  if [[ -n "${c:-}" ]]; then
    hours=$a; mins=$b; secs=$c
  else
    mins=$a; secs=$b
  fi
  echo $((10#$days * 24 + 10#$hours + 10#$mins / 60))
}

killed=0
kept=0

while read -r pid etime rss rest; do
  [[ -z "${pid:-}" ]] && continue
  hours="$(etime_to_hours "$etime")"
  if (( hours >= MAX_HOURS )); then
    echo "KILL  pid=$pid age=${etime} (~${hours}h) rss=${rss}KB  $rest"
    if (( DRY_RUN == 0 )); then
      kill "$pid" 2>/dev/null || true
    fi
    killed=$((killed + 1))
  else
    echo "KEEP  pid=$pid age=${etime} (~${hours}h) rss=${rss}KB"
    kept=$((kept + 1))
  fi
done < <(ps -axo pid=,etime=,rss=,args= | rg 'node .*sudocode-mcp|bin/sudocode-mcp' | rg -v 'rg |cleanup-stale-mcp' || true)

echo ""
if (( DRY_RUN == 1 )); then
  echo "Dry run: would kill $killed, keep $kept (threshold ${MAX_HOURS}h)"
else
  echo "Killed $killed, kept $kept (threshold ${MAX_HOURS}h)"
fi
