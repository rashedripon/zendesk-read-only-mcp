#!/usr/bin/env node
/**
 * zendesk-read-mcp — read-only Zendesk MCP server.
 *
 * Auth (in order of preference):
 *   1. OAuth 2.0 authorization code + PKCE (scope: read) — used when the
 *      Keychain item `claude-zendesk-oauth-client-id` exists. Tokens are
 *      stored in the macOS Keychain and refreshed automatically (Zendesk
 *      refresh tokens are single-use; each refresh rotates the pair).
 *   2. Legacy API token Basic auth (`claude-zendesk-email` +
 *      `claude-zendesk-api-token`) — fallback only. Zendesk retires API
 *      tokens on 2027-04-30 (no new tokens after 2026-10-27).
 *
 * CLI:
 *   node index.js --set-client-id <identifier>   store the OAuth client id
 *   node index.js --authorize                    run the browser OAuth flow
 *   node index.js                                start the MCP server (stdio)
 *
 * GET requests only. Write operations are not implemented and the generic
 * tool refuses anything that isn't a GET path.
 */

import { execFileSync, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Keychain
// ---------------------------------------------------------------------------

const KC = {
  subdomain: "claude-zendesk-subdomain",
  email: "claude-zendesk-email",
  apiToken: "claude-zendesk-api-token",
  clientId: "claude-zendesk-oauth-client-id",
  accessToken: "claude-zendesk-oauth-access-token",
  refreshToken: "claude-zendesk-oauth-refresh-token",
  expiresAt: "claude-zendesk-oauth-expires-at",
};

function kcGet(service) {
  try {
    const v = execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return v || null;
  } catch {
    return null;
  }
}

function kcSet(service, value) {
  execFileSync("security", [
    "add-generic-password",
    "-a", process.env.USER ?? "claude",
    "-s", service,
    "-w", value,
    "-U",
  ]);
}

function getSubdomain() {
  const sd = kcGet(KC.subdomain);
  if (!sd) {
    throw new Error(
      `Missing Keychain item ${KC.subdomain}. Add it with: ` +
        `security add-generic-password -a "$USER" -s "${KC.subdomain}" -w "<subdomain>" -U`
    );
  }
  return sd;
}

// ---------------------------------------------------------------------------
// OAuth 2.0 (authorization code + PKCE, scope: read)
// ---------------------------------------------------------------------------

const REDIRECT_PORT = 52369;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const OAUTH_SCOPE = "read";

async function tokenRequest(subdomain, body) {
  const res = await fetch(`https://${subdomain}.zendesk.com/oauth/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `OAuth token request failed (HTTP ${res.status}): ${JSON.stringify(json).slice(0, 300)}`
    );
  }
  return json;
}

function storeTokens(t) {
  kcSet(KC.accessToken, t.access_token);
  if (t.refresh_token) kcSet(KC.refreshToken, t.refresh_token);
  // expires_in may be null for older clients → 0 means "non-expiring".
  const expiresAt = t.expires_in ? Math.floor(Date.now() / 1000) + t.expires_in : 0;
  kcSet(KC.expiresAt, String(expiresAt));
}

/** Browser-based authorization code + PKCE flow. Blocks until the user
 *  approves in the browser (4 min timeout). */
async function interactiveAuthorize() {
  const subdomain = getSubdomain();
  const clientId = kcGet(KC.clientId);
  if (!clientId) {
    throw new Error(
      "No OAuth client configured. Create one in Zendesk Admin Center → Apps and integrations → " +
        `APIs → OAuth Clients (kind: Public, redirect URL: ${REDIRECT_URI}), then run: ` +
        "node index.js --set-client-id <unique identifier>"
    );
  }

  const verifier = randomBytes(64).toString("base64url"); // 86 chars (43–128 required)
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");

  const authUrl = new URL(`https://${subdomain}.zendesk.com/oauth/authorizations/new`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", OAUTH_SCOPE);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  const code = await new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT_URI);
      if (u.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const err = u.searchParams.get("error");
      const gotCode = u.searchParams.get("code");
      const ok = !err && gotCode && u.searchParams.get("state") === state;
      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html" });
      res.end(
        ok
          ? "<h3>Zendesk authorized &#10003; — you can close this tab and return to Claude.</h3>"
          : "<h3>Authorization failed — you can close this tab.</h3>"
      );
      srv.close();
      ok ? resolve(gotCode) : reject(new Error(`Authorization failed: ${err ?? "state mismatch"}`));
    });
    srv.on("error", reject);
    srv.listen(REDIRECT_PORT, "127.0.0.1", () => {
      execFile("open", [authUrl.toString()], (e) => {
        if (e) console.error(`Could not open a browser. Open this URL manually:\n${authUrl}`);
      });
    });
    setTimeout(() => {
      srv.close();
      reject(new Error("Timed out waiting for browser authorization (4 min)."));
    }, 240_000).unref();
  });

  const tokens = await tokenRequest(subdomain, {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    scope: OAUTH_SCOPE,
  });
  storeTokens(tokens);
  return tokens;
}

/** Resolve an Authorization header value. OAuth when a client id is set
 *  (refreshing/rotating as needed), otherwise legacy API-token Basic auth. */
async function getAuthHeader() {
  const clientId = kcGet(KC.clientId);

  if (clientId) {
    let access = kcGet(KC.accessToken);
    const exp = Number(kcGet(KC.expiresAt) ?? "0");
    const stale = !access || (exp !== 0 && Date.now() / 1000 > exp - 60);
    if (stale) {
      const rt = kcGet(KC.refreshToken);
      if (rt) {
        try {
          const t = await tokenRequest(getSubdomain(), {
            grant_type: "refresh_token",
            refresh_token: rt,
            client_id: clientId,
          });
          storeTokens(t); // refresh tokens are single-use — always store the new pair
          access = t.access_token;
        } catch {
          // Refresh token expired (default 30-day TTL) → full re-auth.
          access = (await interactiveAuthorize()).access_token;
        }
      } else {
        access = (await interactiveAuthorize()).access_token;
      }
    }
    return `Bearer ${access}`;
  }

  // Legacy fallback — Zendesk retires API tokens on 2027-04-30.
  const email = kcGet(KC.email);
  const apiToken = kcGet(KC.apiToken);
  if (email && apiToken) {
    return `Basic ${Buffer.from(`${email}/token:${apiToken}`).toString("base64")}`;
  }

  throw new Error(
    `No Zendesk credentials. Recommended: set up OAuth (Keychain item ${KC.clientId} + run ` +
      `"node index.js --authorize"). Legacy alternative until 2027-04-30: Keychain items ` +
      `${KC.email} and ${KC.apiToken}.`
  );
}

// ---------------------------------------------------------------------------
// HTTP helper — GET only, 30s timeout, response-size cap
// ---------------------------------------------------------------------------

const MAX_RESPONSE_CHARS = 60_000;

async function zdGet(path, params = {}) {
  const subdomain = getSubdomain();

  // Normalize: accept "/tickets/1", "tickets/1", or "/api/v2/tickets/1".
  let p = String(path).trim();
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/^\/api\/v2/, "");
  if (p.includes("..") || /^[a-z]+:\/\//i.test(p)) {
    throw new Error(`Invalid path: ${path}`);
  }

  const url = new URL(`https://${subdomain}.zendesk.com/api/v2${p}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: await getAuthHeader(), Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });

  const body = await res.text();

  if (!res.ok) {
    const hints = {
      401: "Unauthorized — credentials are wrong/expired. For OAuth run the zendesk_authorize tool; for legacy API tokens update the Keychain items.",
      403: "Forbidden — your Zendesk role (or OAuth scope) lacks access to this resource.",
      404: "Not found — wrong resource ID or endpoint URL. Check plural/singular and the API reference.",
      422: "Query syntax error — most common on /search. Check the query string.",
      429: `Rate limited — retry after ${res.headers.get("retry-after") ?? "?"}s.`,
    };
    throw new Error(
      `HTTP ${res.status} on GET ${url.pathname}${url.search}. ` +
        (hints[res.status] ?? "") +
        ` Body: ${body.slice(0, 500)}`
    );
  }

  // Surface rate-limit pressure so the model can throttle proactively.
  const limit = Number(res.headers.get("x-rate-limit"));
  const remaining = Number(res.headers.get("x-rate-limit-remaining"));
  let note = "";
  if (limit && remaining / limit < 0.3) {
    note = `\n\n[rate-limit warning: ${remaining}/${limit} requests remaining this minute — slow down or narrow the query]`;
  }

  let text = body;
  if (text.length > MAX_RESPONSE_CHARS) {
    text =
      text.slice(0, MAX_RESPONSE_CHARS) +
      `\n\n[truncated: response was ${body.length} chars. Narrow the request with query params, ` +
      `pagination (page[size]), or sideloading, and ask for specific fields.]`;
  }
  return text + note;
}

function toolResult(text) {
  return { content: [{ type: "text", text }] };
}

async function run(fn) {
  try {
    return toolResult(await fn());
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
}

// ---------------------------------------------------------------------------
// CLI entry points (before MCP transport)
// ---------------------------------------------------------------------------

const clientIdFlag = process.argv.indexOf("--set-client-id");
if (clientIdFlag !== -1) {
  const id = process.argv[clientIdFlag + 1];
  if (!id) {
    console.error("Usage: node index.js --set-client-id <unique identifier>");
    process.exit(1);
  }
  kcSet(KC.clientId, id);
  console.log(`Stored OAuth client id in Keychain (${KC.clientId}).`);
  process.exit(0);
}

if (process.argv.includes("--authorize")) {
  try {
    await interactiveAuthorize();
    console.log("Authorized ✓ — OAuth tokens stored in macOS Keychain.");
    process.exit(0);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Server + tools
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "zendesk-read", version: "2.0.0" });

// --- Convenience tools (the 80% cases) -------------------------------------

server.registerTool(
  "search",
  {
    title: "Search Zendesk",
    description:
      "Search tickets, users, or organizations with Zendesk search syntax. " +
      'Examples: "type:ticket status:open assignee:me", "type:ticket created>2026-01-01 priority:high", ' +
      '"type:user email:alice@example.com", \'type:organization name:"Acme Corp"\'. ' +
      "Offset pagination, hard cap 1000 results — for larger pulls use zendesk_get with /search/export. " +
      "Note: /search has a much lower rate limit than other endpoints; avoid search-driven loops.",
    inputSchema: {
      query: z.string().describe("Zendesk search query (raw, not URL-encoded)"),
      page: z.number().int().min(1).optional().describe("Page number (default 1)"),
      per_page: z.number().int().min(1).max(100).optional().describe("Results per page, max 100"),
      sort_by: z.string().optional().describe("e.g. created_at, updated_at, priority, status"),
      sort_order: z.enum(["asc", "desc"]).optional(),
    },
  },
  async ({ query, ...params }) => run(() => zdGet("/search", { query, ...params }))
);

server.registerTool(
  "get_ticket",
  {
    title: "Get ticket",
    description:
      "Fetch a single ticket by ID: subject, status, priority, requester, assignee, tags, custom fields, CCs. " +
      "Comments/audit history/SLA metrics live on separate endpoints — use get_ticket_comments, get_ticket_audits, " +
      "or zendesk_get /tickets/{id}/metrics for those.",
    inputSchema: {
      id: z.number().int().describe("Ticket ID"),
      include: z.string().optional().describe("Comma-separated sideloads, e.g. users,organizations,groups"),
    },
  },
  async ({ id, include }) => run(() => zdGet(`/tickets/${id}`, { include }))
);

server.registerTool(
  "get_ticket_comments",
  {
    title: "Get ticket comments",
    description: "All public comments and internal notes on a ticket, including attachments metadata.",
    inputSchema: {
      id: z.number().int().describe("Ticket ID"),
      "page[size]": z.number().int().min(1).max(100).optional(),
    },
  },
  async ({ id, ...params }) => run(() => zdGet(`/tickets/${id}/comments`, params))
);

server.registerTool(
  "get_ticket_audits",
  {
    title: "Get ticket audits",
    description:
      "Full change history of a ticket: every status/assignee/field/tag change with timestamp and actor. " +
      "Use this for 'who closed it', 'why was it reopened', 'when did status flip', tag history, email headers.",
    inputSchema: {
      id: z.number().int().describe("Ticket ID"),
      "page[size]": z.number().int().min(1).max(100).optional(),
    },
  },
  async ({ id, ...params }) => run(() => zdGet(`/tickets/${id}/audits`, params))
);

server.registerTool(
  "get_user",
  {
    title: "Get user",
    description:
      "Look up a Zendesk user by numeric ID or email. Pass id for /users/{id}, or email for /users/search (returns 0 or 1 match). " +
      "Use zendesk_get /users/me for the authenticated user.",
    inputSchema: {
      id: z.number().int().optional().describe("Numeric user ID"),
      email: z.string().optional().describe("Email address to search for"),
    },
  },
  async ({ id, email }) =>
    run(() => {
      if (id) return zdGet(`/users/${id}`);
      if (email) return zdGet("/users/search", { query: email });
      throw new Error("Provide either id or email.");
    })
);

// --- Generic escape hatch (any documented GET endpoint) ---------------------

server.registerTool(
  "zendesk_get",
  {
    title: "Zendesk GET (any endpoint)",
    description: `Call ANY documented Zendesk GET endpoint. Use this whenever no specific tool fits — pick the endpoint yourself from the API reference: https://developer.zendesk.com/api-reference/ (Postman examples: https://www.postman.com/zendesk-redback/workspace/zendesk-public-api). Read-only: GET endpoints only, writes are impossible through this server.

Endpoint quick map (path is relative to /api/v2):
- Tickets: /tickets, /tickets/{id}, /tickets/show_many?ids=1,2,3, /tickets/recent, /tickets/{id}/incidents, /tickets/{id}/metrics, /ticket_fields, /ticket_forms
- Per-user tickets: /users/{uid}/tickets/requested|ccd|assigned
- Search: /search?query=... (1000-result cap), /search/count, /search/export (cursor-paginated, no cap — prefer for big pulls)
- Users: /users, /users/me, /users/{id}, /users/search?query=<email>, /users/{id}/identities, /users/{id}/groups, /users/{id}/organization_memberships
- Orgs: /organizations, /organizations/{id}, /organizations/{id}/users, /organizations/{id}/tickets, /organizations/search?name=...
- Views: /views, /views/{id}/tickets, /views/{id}/execute; Macros: /macros; Groups: /groups; Brands: /brands; CSAT: /satisfaction_ratings?ticket_id={id}
- Bulk/historical: /incremental/tickets/cursor.json?start_time=<unix> (designed for backfills, page[size] up to 1000 — never paginate /tickets end-to-end)

Where ticket data lives (try related endpoints before reporting "not found"):
fields/tags/CCs → /tickets/{id} · comment bodies → /tickets/{id}/comments · change history/reopen reasons/email headers → /tickets/{id}/audits · SLA/first-reply times → /tickets/{id}/metrics · problem↔incident links → /tickets/{id}/incidents

Pagination: modern endpoints use cursor pages — params page[size] (max 100) + page[after] from meta.after_cursor, loop while meta.has_more. /search uses page/per_page with next_page URLs. Common 404 causes: plural vs singular, wrong noun (/incidents vs /problems). If unsure between endpoints, try the most likely one — a wrong guess is cheap and the error hints help.`,
    inputSchema: {
      path: z
        .string()
        .describe('Endpoint path relative to /api/v2, e.g. "/tickets/88421/audits" or "/views/123/execute"'),
      params: z
        .record(z.string())
        .optional()
        .describe('Query parameters as key/value strings, e.g. {"query": "type:ticket status:open", "page[size]": "100"}. Values are URL-encoded for you — pass them raw.'),
    },
  },
  async ({ path, params }) => run(() => zdGet(path, params ?? {}))
);

// --- Auth management ---------------------------------------------------------

server.registerTool(
  "zendesk_authorize",
  {
    title: "Authorize Zendesk (OAuth)",
    description:
      "Run the OAuth browser flow: opens zendesk.com in the user's browser to log in and approve read-only access. " +
      "Use when API calls fail with 401 or when the user wants to (re)connect their Zendesk account. " +
      "Requires the OAuth client id Keychain item to be set up first (one-time admin step).",
    inputSchema: {},
  },
  async () =>
    run(async () => {
      await interactiveAuthorize();
      return "Authorized ✓ — OAuth tokens stored in the macOS Keychain. Subsequent calls use Bearer auth with automatic refresh.";
    })
);

server.registerTool(
  "whoami",
  {
    title: "Current Zendesk account",
    description:
      "Show which Zendesk subdomain and auth mode (OAuth vs legacy API token) this server is using, " +
      "and verify the API connection via /users/me.",
    inputSchema: {},
  },
  async () =>
    run(async () => {
      const subdomain = getSubdomain();
      const mode = kcGet(KC.clientId) ? "OAuth (authorization code + PKCE, scope: read)" : "legacy API token (EOL 2027-04-30 — migrate to OAuth)";
      const me = await zdGet("/users/me");
      return `subdomain: ${subdomain}\nauth mode: ${mode}\n\n/users/me response:\n${me}`;
    })
);

// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
