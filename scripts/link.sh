#!/bin/bash
set -e

# Get the root directory (parent of scripts/)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Linking sudocode packages..."

# Ensure wrappers are executable and pin Node to the current ABI-safe binary.
chmod +x \
  "$ROOT/scripts/pin-node.sh" \
  "$ROOT/scripts/run-with-pinned-node.sh" \
  "$ROOT/cli/bin/"* \
  "$ROOT/mcp/bin/"* \
  "$ROOT/server/bin/"*

# Prefer Node 24 if available via nvm (matches current better-sqlite3 builds).
if [[ -z "${SUDOCODE_NODE:-}" && -x "$HOME/.nvm/versions/node/v24.8.0/bin/node" ]]; then
  export PATH="$HOME/.nvm/versions/node/v24.8.0/bin:$PATH"
fi

"$ROOT/scripts/pin-node.sh"

cd "$ROOT/cli" && npm link
echo "✓ CLI linked"

cd "$ROOT/server" && npm link
echo "✓ Server linked"

cd "$ROOT/mcp" && npm link
echo "✓ MCP linked"

echo ""
echo "All packages linked successfully!"
echo "You can now use: sudocode, sudocode-server, sudocode-mcp"
echo "Bins always exec the Node recorded in each package's .node-path"
