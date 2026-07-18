#!/usr/bin/env bash
# Record the absolute Node binary used for this fork install.
# Wrappers (cli/mcp/server bin/*) exec this Node so Cursor/shell PATH cannot
# load better-sqlite3 under a mismatched ABI.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NODE_BIN="$(node -p 'process.execPath')"

if [[ ! -x "$NODE_BIN" ]]; then
  echo "pin-node: not an executable Node binary: $NODE_BIN" >&2
  exit 1
fi

ABI="$(node -p 'process.versions.modules')"
VERSION="$(node -p 'process.version')"

for pkg in cli mcp server; do
  printf '%s\n' "$NODE_BIN" > "$ROOT/$pkg/.node-path"
done

# Fail fast if native addon cannot load under the pinned Node.
node --input-type=module -e "
  import Database from 'better-sqlite3';
  const db = new Database(':memory:');
  db.close();
  console.log('pin-node: better-sqlite3 OK');
" >/dev/null

echo "Pinned Node for sudocode wrappers:"
echo "  $NODE_BIN ($VERSION, NODE_MODULE_VERSION $ABI)"
echo "  wrote cli/.node-path mcp/.node-path server/.node-path"
