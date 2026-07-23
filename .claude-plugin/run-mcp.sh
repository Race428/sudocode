#!/bin/bash
# Launcher for the race428-sudocode MCP server.
#
# Self-contained: always runs THIS plugin's own build (never a global install,
# which would shadow the plugin's customizations). The MCP resolves its bundled
# @sudocode-ai/cli from node_modules, so no `sudocode` on PATH is required.
# Priority:
#   1. Run the plugin's built mcp/dist/index.js if present.
#   2. Otherwise build once from plugin source (types + cli + mcp), then run.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/.."
CLI_DIR="$REPO_ROOT/cli"
MCP_DIR="$REPO_ROOT/mcp"
MCP_DIST="$MCP_DIR/dist/index.js"
CLI_DIST="$CLI_DIR/dist/cli.js"

# Build the packages the plugin needs (types -> cli -> mcp). Skips the heavy
# frontend/server build. better-sqlite3 is native, so `npm install` fetches its
# prebuilt binary for this platform on first run.
build_plugin() {
    echo "Building race428-sudocode from plugin source (first run)..." >&2
    cd "$REPO_ROOT"

    if [ ! -d "node_modules" ]; then
        echo "Installing dependencies..." >&2
        npm install
    fi

    echo "Building types + cli + mcp..." >&2
    npm run build:plugin

    echo "Build complete." >&2
}

# 1. Use the plugin's own build if it exists.
if [ -f "$MCP_DIST" ] && [ -f "$CLI_DIST" ]; then
    echo "Running race428-sudocode MCP server (plugin build)" >&2
    exec node "$MCP_DIST"
fi

# 2. Build once from plugin source, then run.
if [ -d "$MCP_DIR" ] && [ -d "$CLI_DIR" ] && [ -f "$REPO_ROOT/package.json" ]; then
    build_plugin
    if [ -f "$MCP_DIST" ] && [ -f "$CLI_DIST" ]; then
        echo "Running freshly built race428-sudocode MCP server..." >&2
        exec node "$MCP_DIST"
    fi
    echo "Error: build completed but output files not found." >&2
    exit 1
fi

echo "Error: race428-sudocode plugin source not found next to this launcher." >&2
echo "The plugin must be installed as a full clone (it self-builds on first run)." >&2
exit 1
