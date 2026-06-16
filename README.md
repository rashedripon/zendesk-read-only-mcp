# Zendesk Read-Only MCP

A **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server for Zendesk, designed for **Claude Desktop** and **Claude Cowork**. It lets Claude look up tickets, comments, audit history, users, organizations, views, and any other Zendesk `GET` endpoint — without the ability to change anything.

## Why read-only

Every tool in this server issues `GET` requests only. There is no code path that can create, update, or delete a ticket, user, or any other Zendesk record — writes are not "discouraged," they are **not implemented**, and the generic endpoint tool rejects anything that isn't a `GET`. When authenticated via OAuth, the token is additionally restricted to the `read` scope at Zendesk's end.

That makes it safe to hand to a whole team: the worst case is reading data the user already has permission to see. Nobody can accidentally close a ticket, reassign a queue, or mutate a customer record through Claude.

## Features

- **Per-user OAuth** (authorization code + PKCE, `read` scope) — each person authorizes with their own Zendesk login, so access reflects their own role and audit trails show their identity. No shared service account, no tokens passed around.
- **Credentials in the macOS Keychain** — access/refresh tokens are stored in the login Keychain, never in the repo, env vars, or plaintext files. Refresh tokens rotate automatically (Zendesk refresh tokens are single-use).
- **Legacy API-token fallback** — if no OAuth client is configured, it falls back to `email/token` Basic auth. Note Zendesk is retiring API tokens (no new tokens after **2026-10-27**, all tokens stop working **2027-04-30**), so OAuth is the recommended path.
- **Focused tools for the common cases** plus a generic escape hatch:

| Tool | What it does |
|---|---|
| `whoami` | Show the configured subdomain + auth mode, and verify the connection via `/users/me` |
| `search` | Search tickets/users/orgs with Zendesk search syntax |
| `get_ticket` | A single ticket: subject, status, priority, requester, assignee, tags, custom fields, CCs |
| `get_ticket_comments` | Public comments and internal notes on a ticket |
| `get_ticket_audits` | Full change history — who changed what and when (status flips, reassignments, tag changes) |
| `get_user` | Look up a user by numeric ID or email |
| `zendesk_get` | Call **any** documented Zendesk `GET` endpoint — Claude picks the path itself, guided by an endpoint map baked into the tool description |

The `zendesk_get` tool is the key to flexibility: you don't have to pre-map endpoints. Claude reads the endpoint guide and the [Zendesk API reference](https://developer.zendesk.com/api-reference/) and constructs the right path for whatever you ask.

## Requirements

- **macOS** (credentials are stored in the macOS Keychain via the `security` CLI)
- **Claude Desktop** (and/or Claude Cowork)
- **Node.js ≥ 18** if you run from source or re-pack the extension
- A Zendesk account, and — for OAuth — a Zendesk OAuth client (a one-time admin step, shared by the whole team)

## Install

### Prerequisites — one-time Zendesk admin step

Before anyone installs, a Zendesk admin creates one OAuth client shared by the whole team:

1. Go to **Zendesk Admin Center → Apps and integrations → APIs → OAuth Clients → Add OAuth client**
2. Kind: **Public** | Redirect URL: `http://localhost:52369/callback`
3. Copy the **Unique identifier** — users will need this during setup.

---

### Option A — Claude Code (fully automated, no terminal)

In Claude Code, say:

> *"Install the Zendesk MCP from https://github.com/rashedripon/zendesk-read-only-mcp"*

Claude Code runs directly on your Mac so it can write to your Keychain and config files. It will ask for your subdomain and OAuth client identifier, then handle everything — download, install, config, and browser authorization. Restart Claude Desktop when prompted. Works for both Claude Desktop and Cowork.

---

### Option B — Terminal script (for Cowork users or anyone without Claude Code)

Cowork runs in a sandbox and cannot modify your Mac directly, so setup must happen on your machine first. Run this in Terminal:

```bash
# Download and extract the latest release
LATEST_URL=$(curl -s https://api.github.com/repos/rashedripon/zendesk-read-only-mcp/releases/latest \
  | python3 -c "import sys,json; print([a['browser_download_url'] for a in json.load(sys.stdin)['assets'] if a['name'].endswith('.mcpb')][0])")
curl -L "$LATEST_URL" -o /tmp/zendesk-read.mcpb

INSTALL_DIR="$HOME/.claude/extensions/zendesk-read"
mkdir -p "$INSTALL_DIR"
unzip -o /tmp/zendesk-read.mcpb -d "$INSTALL_DIR"
cd "$INSTALL_DIR" && npm install --production --silent

# Register with Claude Desktop
python3 -c "
import json, os
config_path = os.path.expanduser('~/Library/Application Support/Claude/claude_desktop_config.json')
install_dir = os.path.expanduser('~/.claude/extensions/zendesk-read')
try:
    config = json.load(open(config_path))
except:
    config = {}
config.setdefault('mcpServers', {})['zendesk-read'] = {
    'command': 'node',
    'args': [os.path.join(install_dir, 'index.js')]
}
json.dump(config, open(config_path, 'w'), indent=2)
print('Config updated.')
"

# Store your credentials (replace the placeholders)
security add-generic-password -a "$USER" -s "claude-zendesk-subdomain" -w "<your-subdomain>" -U
security add-generic-password -a "$USER" -s "claude-zendesk-oauth-client-id" -w "<unique-identifier>" -U

# Open the browser authorization flow
node "$HOME/.claude/extensions/zendesk-read/index.js" --authorize
```

Restart Claude Desktop after the script completes. Cowork picks up the MCP automatically on the next session.

---

### Option C — `.mcpb` UI install (Claude Desktop, no enterprise lock)

If your organisation hasn't restricted the Extensions UI:

1. Download `zendesk-read.mcpb` from the [**Releases**](../../releases) page
2. In Claude Desktop: **Settings → Extensions → Advanced → Install Extension…**
3. Open Terminal and run:

```bash
security add-generic-password -a "$USER" -s "claude-zendesk-subdomain" -w "<your-subdomain>" -U
security add-generic-password -a "$USER" -s "claude-zendesk-oauth-client-id" -w "<unique-identifier>" -U
```

4. In Claude, ask: *"Authorize my Zendesk connection"* — this opens your browser to approve read-only access.

> **Enterprise note:** if the Install Extension button is greyed out due to org policy, use Option A or B instead.

---

## Verifying the connection

Ask Claude: *"Who am I in Zendesk?"* — the `whoami` tool confirms your subdomain, auth mode, and identity.

## Re-authorizing

If your token expires (Zendesk default: 30 days idle), ask Claude: *"Re-authorize my Zendesk connection"* and the browser flow re-triggers automatically.

## Legacy API token fallback

If no OAuth client is configured, the server falls back to `email/token` Basic auth. Store `claude-zendesk-email` and `claude-zendesk-api-token` in the Keychain. Note Zendesk is retiring API tokens — no new tokens after **2026-10-27**, all stop working **2027-04-30**. OAuth is the recommended path.

## Platform note

macOS only — credential storage relies on the macOS Keychain. Windows support is planned.

## Building from source

```bash
npm install
npm install -g @anthropic-ai/mcpb
npm run pack          # produces zendesk-read.mcpb
```

## Endpoint reference

`zendesk_get` accepts any documented Zendesk `GET` endpoint. See the [Zendesk API reference](https://developer.zendesk.com/api-reference/) for the full surface.

## License

MIT
