# Zendesk Read-Only MCP

A **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server for Zendesk, designed for **Claude Desktop** and **Claude Cowork**. It lets Claude look up tickets, comments, audit history, users, organizations, views, and any other Zendesk `GET` endpoint — without the ability to change anything.

## Why read-only

Every tool in this server issues `GET` requests only. There is no code path that can create, update, or delete a ticket, user, or any other Zendesk record — writes are not "discouraged," they are **not implemented**, and the generic endpoint tool rejects anything that isn't a `GET`. When authenticated via OAuth, the token is additionally restricted to the `read` scope at Zendesk's end.

That makes it safe to hand to a whole team: the worst case is reading data the user already has permission to see. Nobody can accidentally close a ticket, reassign a queue, or mutate a customer record through Claude.

## Features

- **Per-user OAuth** (authorization code + PKCE, `read` scope) — each person authorizes with their own Zendesk login, so access reflects their own role and audit trails show their identity. No shared service account, no tokens passed around.
- **Credentials in the macOS Keychain** — access/refresh tokens are stored in the login Keychain, never in the repo, env vars, or plaintext files. Refresh tokens rotate automatically (Zendesk refresh tokens are single-use).
- **Legacy API-token fallback** — if no OAuth client is configured, it falls back to `email/token` Basic auth. Note Zendesk is retiring API tokens (no new tokens after **2026-10-27**, all tokens stop working **2027-04-30**), so OAuth is the recommended path.
- **One-call bulk pulls** — `zendesk_get_all` follows pagination (cursor, offset, and incremental styles) **server-side**, so you approve once instead of once per page. It pauses automatically at 80% of Zendesk's per-minute rate budget and reports where it stopped.
- **No silent truncation** — large responses are written in full to a local JSON file (with a preview returned to Claude) instead of being cut off, and `read_export` reads them back through the server so it works even in Cowork.
- **Multiple Zendesk instances** — a Help Center / Guide (or other brand) often lives on a different `*.zendesk.com` subdomain. Pass an optional `subdomain` argument to target it; the same OAuth token is reused across instances.
- **Focused tools for the common cases** plus a generic escape hatch:

| Tool | What it does |
|---|---|
| `whoami` | Show the configured subdomain + auth mode + export dir, and verify the connection via `/users/me` |
| `search` | Search tickets/users/orgs with Zendesk search syntax (one page) |
| `get_ticket` | A single ticket: subject, status, priority, requester, assignee, tags, custom fields, CCs |
| `get_ticket_comments` | Public comments and internal notes on a ticket |
| `get_ticket_audits` | Full change history — who changed what and when (status flips, reassignments, tag changes) |
| `get_user` | Look up a user by numeric ID or email |
| `zendesk_get` | Call **any** documented Zendesk `GET` endpoint, one page — Claude picks the path itself, guided by an endpoint map baked into the tool description (tickets, users, orgs, views, business rules/triggers, incremental exports, Help Center/Guide) |
| `zendesk_get_all` | Same, but auto-paginates the whole result set in one call — for audit histories, incremental exports, all triggers/automations, every Help Center article, etc. |
| `get_many` | Fetch many records by a **list of IDs** in one call via Zendesk's `show_many` batch endpoints (auto-chunked ≤100/call) — tickets, users, organizations |
| `list_exports` | List the JSON export files the server has saved from large pulls |
| `read_export` | Page records back from a saved export (optionally `fields=`-projected so many more fit per call), or `count_by=<field>` to tally the **whole** file server-side — the way to consume a large pull, **including in Cowork** |
| `zendesk_authorize` | (Re)run the OAuth browser flow |

The `zendesk_get`/`zendesk_get_all` pair is the key to flexibility: you don't have to pre-map endpoints. Claude reads the endpoint guide and the [Zendesk API reference](https://developer.zendesk.com/api-reference/) and constructs the right path for whatever you ask. If several endpoint guesses fail, the server tells Claude to stop guessing and ask you for the exact path.

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

Cowork runs in a sandbox and cannot modify your Mac directly, so setup must happen on your machine first. Run this single command in Terminal:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/rashedripon/zendesk-read-only-mcp/main/install.sh)"
```

The script will ask for your Zendesk subdomain and OAuth client identifier, then handle everything — download, install, config, credentials, and browser authorization. Restart Claude Desktop when done. Cowork picks up the MCP automatically on the next session.

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

## Updating an existing installation

New versions are published to the [Releases](../../releases) page. Your
credentials live in the macOS Keychain and are **never touched by an update**, so
you won't need to re-authorize or re-enter your subdomain / client id — just pull
the new version the same way you installed, then restart Claude Desktop.

- **Installed via Option A (Claude Code):** ask Claude Code —
  *"Update the Zendesk MCP to the latest release from https://github.com/rashedripon/zendesk-read-only-mcp"* — it re-downloads and replaces the installed copy.
- **Installed via Option B (terminal):** re-run the same one-line installer. It
  downloads the latest release bundle and overwrites the installed files. When it
  asks for your subdomain / client id you can just re-enter them (they're simply
  re-saved to the Keychain), and the final authorize step can be cancelled if your
  connection is still valid.
  ```bash
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/rashedripon/zendesk-read-only-mcp/main/install.sh)"
  ```
- **Installed via Option C (`.mcpb` UI):** download the latest `zendesk-read.mcpb`
  from Releases and install it again via **Settings → Extensions → Advanced →
  Install Extension…** — it replaces the previous version. No need to re-run the
  Keychain commands.

Then **fully quit and reopen Claude Desktop** (`⌘Q`, not just closing the window)
so the MCP server process restarts with the new code. Cowork picks up the new
version on its next session.

**Verify the update:** ask Claude *"list your Zendesk tools"* — you should see the
full set including `zendesk_get_all`, `get_many`, `list_exports`, and `read_export`.

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

## Multiple instances (Help Center on another subdomain)

Zendesk often serves a Help Center / Guide — or a separate brand — from a
*different* subdomain than your main support instance (e.g. tickets on
`acmesupport.zendesk.com` but Help Center articles on `acmeguide.zendesk.com`).
The same OAuth token works across them, so the only thing that changes is the
host.

Pass the optional **`subdomain`** argument to `zendesk_get` / `zendesk_get_all` /
`get_many` (and `whoami`) — it accepts either a **configured label** or a **raw
subdomain**:

```
zendesk_get  path=/help_center/articles  subdomain=acmeguide
```

Omit it and requests go to the primary instance as before. To make instances
easy to pick (they then show up in `whoami` and in the tool hints), register a
friendly label once:

```bash
node index.js --add-subdomain helpcenter=acmeguide
# stored in the Keychain item claude-zendesk-subdomains
```

Then `subdomain=helpcenter` routes to `acmeguide.zendesk.com`. Verify a given
instance authorizes with your token via `whoami` (e.g. ask *"check my Zendesk
connection for the helpcenter instance"*).

## Bulk pulls & large responses

For anything that spans many pages — full ticket audit histories, incremental
exports (`/incremental/...`), all triggers/automations, every Help Center
article — use `zendesk_get_all`. It loops through the pages itself, so Claude
asks for approval **once** rather than per page.

- **Rate-budget aware:** it watches Zendesk's `x-rate-limit` headers and pauses
  once ~80% of the per-minute quota is consumed, reporting where it stopped.
- **Spills to disk:** aggregates larger than the inline limit are written in full
  to a JSON file and Claude gets a preview + the path. Export directory defaults
  to `~/zendesk-mcp-exports/`; override with the `ZENDESK_EXPORT_DIR` env var.

To consume a saved export, use `read_export`, which pages records back through
the server in context-sized chunks (zero Zendesk API cost — it's a local read).

When you already have a **list of IDs**, use `get_many` instead of fetching them
one by one: it batches the IDs through Zendesk's `show_many` endpoints (≤100 per
request, chunked automatically), so 100 tickets cost one API call rather than 100.

### Works in Claude Cowork

Cowork runs in a sandboxed Linux VM that can't see the macOS host filesystem, but
**this server runs on the host** — so it reads its own export files and streams
them back over the MCP protocol. Large pulls are therefore fully usable in Cowork:
`zendesk_get_all` saves the file on the host, then `list_exports` / `read_export`
retrieve the data through the server, no host-filesystem access required.

### Counting & aggregation (don't undercount)

Counting, ranking, and "usage"-type questions have a built-in trap: a single
`zendesk_get` returns only the *first page*, and `read_export` returns only a
*window*. Answering from either silently undercounts. The server guards against
this:

- A single-page `zendesk_get` whose response has more pages appends a loud
  **"MORE PAGES EXIST — use `zendesk_get_all`"** warning.
- `read_export` paging shows a **"PARTIAL READ … you have NOT seen the rest"**
  banner until you reach end of file.
- To aggregate, don't page everything into context — call `read_export` with
  **`count_by=<field path>`**. It tallies *every* record in the file server-side
  and returns ranked value counts. Paths descend into arrays with `[]`, e.g.
  `count_by=status` or `count_by=child_events[].via_reference_id` (trigger fire
  counts).
- When you *do* need to look at many records, pass **`fields=<comma-separated
  paths>`** to slim each record to just what you need — so hundreds fit per call
  instead of a handful.

> **Fewer approval prompts:** each `read_export` call is a tool invocation, so the
> client asks for approval each time — a client-side policy the server can't
> bypass. The features above minimise the number of calls (one `count_by` call, or
> a few `fields`-projected pages). Because `read_export` is read-only and locked to
> the export directory, it's also safe to mark **"Always allow"** in Claude
> Desktop / Cowork to stop the prompts entirely.

So a correct "trigger usage over 30 days" flow is: `zendesk_get_all` the
`/incremental/ticket_events.json` stream to `end_of_stream` → `read_export` with
`count_by=child_events[].via_reference_id` → map IDs to trigger names. No partial
data, no in-context counting.

## Endpoint reference

Both `zendesk_get` and `zendesk_get_all` accept any documented Zendesk `GET`
endpoint. The tool descriptions carry a quick map covering tickets, users,
organizations, views, business rules (triggers/automations/macros/SLA),
incremental exports, and the Help Center / Guide knowledge base. See the
[Zendesk API reference](https://developer.zendesk.com/api-reference/) for the full
surface.

## License

MIT
