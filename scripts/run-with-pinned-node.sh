#!/usr/bin/env bash
# Exec a package entry with the Node pinned in <pkg>/.node-path.
# Usage: run-with-pinned-node.sh <pkg-root> <script-relpath> [args...]
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: run-with-pinned-node.sh <pkg-root> <script-relpath> [args...]" >&2
  exit 1
fi

PKG_ROOT="$1"
SCRIPT_REL="$2"
shift 2

NODE_BIN=""
if [[ -n "${SUDOCODE_NODE:-}" ]]; then
  NODE_BIN="$SUDOCODE_NODE"
elif [[ -f "$PKG_ROOT/.node-path" ]]; then
  NODE_BIN="$(tr -d '[:space:]' < "$PKG_ROOT/.node-path")"
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "sudocode: pinned Node binary not found." >&2
  echo "From the sudocode fork, run: ./scripts/link.sh" >&2
  echo "Or set SUDOCODE_NODE to an absolute node path (must match better-sqlite3 ABI)." >&2
  exit 1
fi

TARGET="$PKG_ROOT/$SCRIPT_REL"
if [[ ! -f "$TARGET" ]]; then
  echo "sudocode: missing $TARGET — run npm run build in the sudocode fork." >&2
  exit 1
fi

exec "$NODE_BIN" "$TARGET" "$@"
