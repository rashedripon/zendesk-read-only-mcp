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

## First-time setup

A Zendesk admin creates **one** OAuth client for the whole team (one-time, shared):

1. Go to **Zendesk Admin Center → Apps and integrations → APIs → OAuth Clients → Add OAuth client**
2. Client kind: **Public**
3. Redirect URL: `http://localhost:52369/callback`
4. Copy the **Unique identifier** — you'll need it below.

---

### If you installed via `.mcpb` (recommended)

Your subdomain is the part before `.zendesk.com` — e.g. if your Zendesk URL is `acme.zendesk.com`, your subdomain is `acme`.

Open Terminal and run these two commands:

```bash
# 1. Store your subdomain
security add-generic-password -a "$USER" -s "claude-zendesk-subdomain" -w "<your-subdomain>" -U

# 2. Store the OAuth client identifier your admin created
security add-generic-password -a "$USER" -s "claude-zendesk-oauth-client-id" -w "<unique-identifier>" -U
```

Then open Claude Desktop (or Cowork) and ask:

> *"Authorize my Zendesk connection"*

Claude will run the `zendesk_authorize` tool, which opens your browser, logs you into Zendesk, and stores the access token automatically. You're done — no terminal needed after this.

---

### If you installed from source

```bash
# Store your subdomain
security add-generic-password -a "$USER" -s "claude-zendesk-subdomain" -w "<your-subdomain>" -U

# Store the OAuth client identifier
node src/index.js --set-client-id <unique-identifier>

# Open the browser auth flow
node src/index.js --authorize
```

---

### Using in Cowork

Install the `.mcpb` in Claude Desktop first (Settings → Extensions → Advanced → Install Extension). The tools are usually bridged into Cowork automatically.

If they don't appear in a Cowork session, add this to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "zendesk-read": {
      "command": "node",
      "args": ["/Applications/Claude.app/Contents/Resources/extensions/zendesk-read/index.js"]
    }
  }
}
```

Then restart Claude Desktop.

---

### Re-authorizing

If your token expires (Zendesk default: 30 days idle), just ask Claude:

> *"Re-authorize my Zendesk connection"*

To verify you're connected, ask: *"Who am I in Zendesk?"*

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
