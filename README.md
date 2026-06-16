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

## Install (the `.mcpb` extension)

1. Download `zendesk-read.mcpb` from the [**Releases**](../../releases) page.
2. In Claude Desktop, go to **Settings → Extensions → Advanced → Install Extension…**
3. Select the downloaded `zendesk-read.mcpb` and confirm.

### Cowork troubleshooting

Installing the `.mcpb` makes the tools available in regular Claude Desktop chats. If they **don't surface inside a Cowork session**, add the server to `claude_desktop_config.json` so Desktop bridges it into the Cowork VM. The file lives at:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

Add an `mcpServers` entry pointing at the server's `src/index.js`:

```json
{
  "mcpServers": {
    "zendesk-read": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/absolute/path/to/zendesk-read/src/index.js"]
    }
  }
}
```

Then fully quit (⌘Q) and reopen Claude Desktop. A few gotchas worth knowing:

- **Merge, don't append.** If the file already has content, add `mcpServers` as a key inside the existing top-level object — don't paste a second `{ ... }` block. Two top-level objects is invalid JSON and Desktop will silently drop it on launch.
- **Use absolute paths.** Desktop doesn't inherit your shell `PATH`, so a bare `"command": "node"` may fail to start. Use the full path (`which node` → e.g. `/opt/homebrew/bin/node`).
- **Path to `src/index.js`** is wherever you cloned/unpacked the server — not a relative path.
- On first call you may get a macOS Keychain prompt for `node`; click **Always Allow**.
- Verify with *"who am I in Zendesk?"* — Claude should run the `whoami` tool and report your account.

## First-time setup & auth flow

A Zendesk admin creates **one** OAuth client for the whole team:

- Zendesk **Admin Center → Apps and integrations → APIs → OAuth Clients → Add OAuth client**
- Client kind: **Public**
- Redirect URL: `http://localhost:52369/callback`
- Copy the **Unique identifier**.

Then each user, once:

```bash
# Tell the server which Zendesk instance and OAuth client to use
security add-generic-password -a "$USER" -s "claude-zendesk-subdomain" -w "<your-subdomain>" -U
node src/index.js --set-client-id <unique-identifier>

# Authorize — opens your browser to log in and approve read-only access
node src/index.js --authorize
```

After that, the extension works automatically: access tokens are refreshed in the background, and if the refresh token ever expires (Zendesk default: 30 days idle) the browser flow re-triggers — or just ask Claude to run the `zendesk_authorize` tool. To check what you're connected as, ask Claude *"who am I in Zendesk?"* (the `whoami` tool).

**Legacy fallback** (until 2027-04-30): skip the OAuth steps and instead store `claude-zendesk-email` and `claude-zendesk-api-token` in the Keychain; the server uses `email/token` Basic auth when no OAuth client is configured.

## Platform note

macOS only for now — credential storage relies on the macOS Keychain (`security`). Windows support is planned (it needs a Credential Manager backend). The bundled extension declares `platforms: ["darwin"]` accordingly.

## Building from source

```bash
npm install
npm install -g @anthropic-ai/mcpb
npm run pack          # produces zendesk-read.mcpb
```

## Endpoint reference

`zendesk_get` accepts any documented `GET` endpoint. See the official [Zendesk API reference](https://developer.zendesk.com/api-reference/) for the full surface (tickets, search, users, organizations, views, macros, satisfaction ratings, incremental exports, and more).

## License

MIT
