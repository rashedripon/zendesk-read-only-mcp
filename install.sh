#!/bin/bash
set -e

echo "=== Zendesk Read-Only MCP Installer ==="
echo ""

# --- Preflight: node is required (the MCP server runs on it) ---------------
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js (>= 18) is required but 'node' was not found on your PATH."
  echo "Install Node from https://nodejs.org and re-run this installer."
  exit 1
fi

# --- Collect credentials upfront -------------------------------------------
read -p "Enter your Zendesk subdomain (e.g. 'acme' from acme.zendesk.com): " SUBDOMAIN
read -p "Enter your OAuth client unique identifier: " CLIENT_ID
echo ""

# --- Download the latest release bundle ------------------------------------
echo "Downloading latest release..."
curl -fsSL "https://github.com/rashedripon/zendesk-read-only-mcp/releases/latest/download/zendesk-read.mcpb" \
  -o /tmp/zendesk-read.mcpb

# --- Extract (the .mcpb already bundles node_modules, so no npm install) ----
INSTALL_DIR="$HOME/.claude/extensions/zendesk-read"
mkdir -p "$INSTALL_DIR"
unzip -o /tmp/zendesk-read.mcpb -d "$INSTALL_DIR" > /dev/null
echo "✓ Extracted to $INSTALL_DIR"

# --- Resolve the server entry point from the bundle's own manifest ----------
# Robust to layout changes (e.g. index.js at root vs src/index.js) instead of
# hardcoding a path that silently breaks when the bundle is repacked.
ENTRY=$(node -e 'process.stdout.write(require(process.argv[1]).server.entry_point)' "$INSTALL_DIR/manifest.json")
ENTRY_PATH="$INSTALL_DIR/$ENTRY"
if [ ! -f "$ENTRY_PATH" ]; then
  echo "Error: could not locate the server entry point at $ENTRY_PATH"
  exit 1
fi

# --- Update Claude Desktop config (use node so there's no python3/Xcode CLT
#     dependency — node is already required to run the server) ---------------
CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
mkdir -p "$(dirname "$CONFIG")"
node -e '
  const fs = require("fs");
  const [configPath, entryPath] = [process.argv[1], process.argv[2]];
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch {}
  config.mcpServers = config.mcpServers || {};
  config.mcpServers["zendesk-read"] = { command: "node", args: [entryPath] };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
' "$CONFIG" "$ENTRY_PATH"
echo "✓ Claude Desktop config updated"

# --- Store credentials in the macOS Keychain --------------------------------
security add-generic-password -a "$USER" -s "claude-zendesk-subdomain" -w "$SUBDOMAIN" -U
security add-generic-password -a "$USER" -s "claude-zendesk-oauth-client-id" -w "$CLIENT_ID" -U
echo "✓ Credentials stored in Keychain"

# --- Authorize (non-fatal: if the browser flow is cancelled or times out,
#     the user can re-trigger it later from Claude) ------------------------
echo ""
echo "Opening browser for Zendesk authorization..."
if node "$ENTRY_PATH" --authorize; then
  echo "✓ Authorized"
else
  echo "⚠ Authorization didn't complete. You can finish it later by asking Claude:"
  echo "  'Authorize my Zendesk connection'"
fi

echo ""
echo "=== Done! Restart Claude Desktop to activate. ==="
echo "Then ask Claude: 'Who am I in Zendesk?' to verify."
