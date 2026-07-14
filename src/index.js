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
 *
 * Bulk reads: zendesk_get_all auto-paginates server-side (one approval, no
 * per-page prompts), pauses at 80% of the per-minute API rate budget, and
 * spills large results to a local JSON file instead of truncating them.
 */

import { execFileSync, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Keychain
// ---------------------------------------------------------------------------

const KC = {
  subdomain: "claude-zendesk-subdomain",
  subdomains: "claude-zendesk-subdomains",
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

/** Map of label → subdomain for every configured Zendesk instance. The primary
 *  (`claude-zendesk-subdomain`) is labelled "default"; extras come from
 *  `claude-zendesk-subdomains` as comma-separated "label=subdomain" (or bare
 *  "subdomain") pairs. The OAuth token is shared across all of them. */
function subdomainRegistry() {
  const reg = new Map();
  const def = kcGet(KC.subdomain);
  if (def) reg.set("default", def);
  const extra = kcGet(KC.subdomains);
  if (extra) {
    for (const item of extra.split(",").map((s) => s.trim()).filter(Boolean)) {
      const [a, b] = item.includes("=") ? item.split("=") : [item, item];
      reg.set(a.trim(), (b ?? a).trim());
    }
  }
  return reg;
}

/** Resolve a subdomain selector (label or literal) to an actual subdomain.
 *  Empty → the primary. Any valid bare subdomain is accepted (auth is shared,
 *  read-only), so a brand's Help Center instance can be reached without setup. */
function resolveSubdomain(sel) {
  if (!sel) return getSubdomain();
  const s = String(sel).trim();
  const reg = subdomainRegistry();
  if (reg.has(s)) return reg.get(s);
  for (const v of reg.values()) if (v === s) return s;
  if (/^[a-z0-9][a-z0-9-]*$/i.test(s)) return s;
  const known = [...reg.entries()].map(([k, v]) => (k === v ? k : `${k}=${v}`)).join(", ");
  throw new Error(`Invalid subdomain "${sel}". Configured instances: ${known || "(only default)"}.`);
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
// HTTP layer
//   - GET only, 30s timeout
//   - rate-limit budget: pause bulk pulls at 80% of the per-minute quota
//   - large payloads spill to a local JSON file (no silent truncation)
// ---------------------------------------------------------------------------

// Inline cap protects Claude's CONTEXT WINDOW (tokens) — a different resource
// from Zendesk's API rate limit. Past this, the full body is written to a file
// and only a preview + path are returned. It is no longer a data ceiling.
const INLINE_MAX_CHARS = 50_000;
const PREVIEW_CHARS = 4_000;
// Stop auto-pagination once we've consumed ≥80% of the per-minute API budget.
const RATE_BUDGET = 0.8;
const DEFAULT_MAX_RECORDS = 100_000;

function exportDir() {
  const dir = process.env.ZENDESK_EXPORT_DIR || path.join(os.homedir(), "zendesk-mcp-exports");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function writeExport(label, text) {
  const safe = String(label || "export").replace(/[^a-z0-9_-]+/gi, "_").slice(0, 40) || "export";
  const file = path.join(exportDir(), `${safe}-${stamp()}.json`);
  fs.writeFileSync(file, text);
  return file;
}

// Resolve a name/path to a file INSIDE the export dir — and only there. The
// server runs on the macOS host, so reading exports through these tools works
// even from Claude Cowork (whose sandboxed VM can't see the host filesystem):
// the file never crosses the boundary, only the tool result does.
function resolveExportFile(name) {
  const dir = exportDir();
  const resolved = path.resolve(dir, String(name));
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
    throw new Error(`read_export only reads files inside the export dir (${dir}).`);
  }
  if (!fs.existsSync(resolved)) throw new Error(`No such export file: ${path.basename(resolved)} (in ${dir})`);
  return resolved;
}

// Find the record array in an export: a top-level array, else `results`, else
// the first array-valued key (tickets/audits/triggers/...). Falls back to
// treating the whole document as a single record.
function recordsOf(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    if (Array.isArray(json.results)) return json.results;
    for (const v of Object.values(json)) if (Array.isArray(v)) return v;
  }
  return [json];
}

/** Resolve a dotted field path against a record, descending into arrays where a
 *  segment ends with "[]". Returns a flat list of matched values.
 *  e.g. "status" → [value]; "child_events[].via_reference_id" → [id, id, ...]. */
function resolvePath(value, segments) {
  if (!segments.length) return value === undefined ? [] : [value];
  const [seg, ...rest] = segments;
  const isArr = seg.endsWith("[]");
  const key = isArr ? seg.slice(0, -2) : seg;
  if (value == null || typeof value !== "object") return [];
  const next = key === "" ? value : value[key];
  if (isArr) return Array.isArray(next) ? next.flatMap((el) => resolvePath(el, rest)) : [];
  return next === undefined ? [] : resolvePath(next, rest);
}

/** Slim a record to just the requested dotted paths — so many more records fit
 *  per read_export call (fewer round-trips, fewer approval prompts). */
function projectRecord(rec, paths) {
  const out = {};
  for (const p of paths) {
    const vals = resolvePath(rec, p.split(".").filter(Boolean));
    out[p] = vals.length <= 1 ? vals[0] ?? null : vals;
  }
  return out;
}

// --- endpoint-guessing watchdog --------------------------------------------
// Track CONSECUTIVE wrong-path/bad-query failures so the model is told to stop
// guessing and ask the user once it has clearly lost the trail. Reset on any
// successful request.
const GUESS_FAILURE_LIMIT = 4;
let consecutiveGuessFailures = 0;

function isGuessFailure(status) {
  return status === 404 || status === 422;
}

const HTTP_HINTS = {
  401: "Unauthorized — credentials are wrong/expired. For OAuth run the zendesk_authorize tool; for legacy API tokens update the Keychain items.",
  403: "Forbidden — your Zendesk role (or OAuth scope) lacks access to this resource.",
  404: "Not found — wrong resource ID or endpoint URL. Check plural/singular and the API reference.",
  422: "Query syntax error — most common on /search. Check the query string.",
};

function augmentError(r) {
  const hint =
    r.status === 429
      ? `Rate limited — retry after ${r.retryAfter ?? "?"}s.`
      : HTTP_HINTS[r.status] ?? "";
  let msg = `HTTP ${r.status} on GET ${r.url.pathname}${r.url.search}. ${hint} Body: ${r.body.slice(0, 500)}`;
  if (isGuessFailure(r.status) && consecutiveGuessFailures >= GUESS_FAILURE_LIMIT) {
    consecutiveGuessFailures = 0; // reset so it prompts once, not on every later call
    msg +=
      `\n\n[${GUESS_FAILURE_LIMIT} endpoint attempts have now failed in a row. STOP guessing endpoints. ` +
      `Ask the user whether they know the specific Zendesk API endpoint/path (or a doc link) for what ` +
      `they want, then try that. Do not keep trying new paths blindly.]`;
  }
  return new Error(msg);
}

/** Single GET. `target` may be a relative path ("/tickets/1", "tickets/1",
 *  "/api/v2/tickets/1") or an absolute same-host URL (used when following
 *  pagination links). Returns the parsed response plus rate-limit headers. */
async function zdRequest(target, params = {}, subdomainSel) {
  const subdomain = resolveSubdomain(subdomainSel);

  let url;
  if (/^https?:\/\//i.test(target)) {
    url = new URL(target);
    // Absolute URLs come from pagination links — allow any Zendesk instance
    // (same shared token), but nothing off *.zendesk.com.
    if (!/^[a-z0-9][a-z0-9-]*\.zendesk\.com$/i.test(url.hostname)) {
      throw new Error(`Refusing to fetch off-host URL: ${url.hostname} (only *.zendesk.com allowed)`);
    }
  } else {
    let p = String(target).trim();
    if (!p.startsWith("/")) p = "/" + p;
    p = p.replace(/^\/api\/v2(?=\/|$)/, "");
    if (p.includes("..")) throw new Error(`Invalid path: ${target}`);
    url = new URL(`https://${subdomain}.zendesk.com/api/v2${p}`);
  }

  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: await getAuthHeader(), Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });

  const body = await res.text();
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    /* non-JSON body (rare) — leave json null */
  }

  const limit = Number(res.headers.get("x-rate-limit")) || 0;
  const remRaw = res.headers.get("x-rate-limit-remaining");
  return {
    ok: res.ok,
    status: res.status,
    url,
    body,
    json,
    limit,
    remaining: remRaw === null ? null : Number(remRaw),
    retryAfter: res.headers.get("retry-after"),
  };
}

/** True once we've burned ≥80% of this minute's request quota. */
function overRateBudget(r) {
  return r.limit > 0 && r.remaining !== null && r.remaining / r.limit <= 1 - RATE_BUDGET;
}

function rateNote(r) {
  if (overRateBudget(r)) {
    return `\n\n[rate-limit: ${r.remaining}/${r.limit} requests left this minute — ≥80% of the budget is used, slow down or narrow the query]`;
  }
  return "";
}

/** Warn when a single GET returned only the first of multiple pages — the most
 *  common cause of undercounting (using zendesk_get where zendesk_get_all was
 *  needed). Detected from the actual response, not guessed. */
function morePagesWarning(json) {
  if (!json || typeof json !== "object") return "";
  const more = json.end_of_stream === false || nextTarget(json) !== null;
  if (!more) return "";
  return (
    "\n\n⚠️ MORE PAGES EXIST — this is ONLY the first page of a larger result set. " +
    'For any count, total, ranking, "usage", or "all of X" question, switch to zendesk_get_all ' +
    "(it follows every page) or get_many — a single page will silently UNDERCOUNT."
  );
}

/** Format a single response for the model: inline if small, else spill the
 *  full body to a file and return a preview + path. */
function formatSingle(r, label = "zendesk_get") {
  const note = rateNote(r);
  const more = morePagesWarning(r.json);
  if (r.body.length > INLINE_MAX_CHARS) {
    const file = writeExport(label, r.body);
    return (
      `Response was ${r.body.length} chars — full JSON written to:\n${file}\n` +
      `Read it back in pages with read_export (file: "${path.basename(file)}") — works in Cowork too.${more}\n\n` +
      `Preview (first ${PREVIEW_CHARS} chars):\n${r.body.slice(0, PREVIEW_CHARS)}${note}`
    );
  }
  return r.body + more + note;
}

/** Assemble a record collection for return: inline if small, else spilled to a
 *  file with a preview + a read_export hint. Shared by zdGetAll and zdGetMany. */
function deliverCollection(label, items, key, meta = {}) {
  const payload = { count: items.length, ...meta, [key || "results"]: items };
  const text = JSON.stringify(payload, null, 2);
  const span =
    (meta.pages ? ` across ${meta.pages} page(s)` : "") +
    (meta.chunks ? ` in ${meta.chunks} batch call(s)` : "");
  const summary = `Fetched ${items.length} records${span}. ${meta.stop_reason ?? ""}`.trim();
  if (text.length > INLINE_MAX_CHARS) {
    const file = writeExport(label, text);
    const sample = items.slice(0, 2);
    return (
      `${summary}\nFull JSON (${text.length} chars) written to:\n${file}\n` +
      `Read all ${items.length} records in pages with read_export (file: "${path.basename(file)}") — works in Cowork too.\n\n` +
      `Preview (first ${sample.length} record(s)):\n${JSON.stringify(sample, null, 2).slice(0, PREVIEW_CHARS)}`
    );
  }
  return `${summary}\n\n${text}`;
}

/** Single GET used by the convenience tools and zendesk_get. */
async function zdGet(target, params = {}, label = "zendesk_get", subdomainSel) {
  const r = await zdRequest(target, params, subdomainSel);
  if (!r.ok) {
    if (isGuessFailure(r.status)) consecutiveGuessFailures++;
    throw augmentError(r);
  }
  consecutiveGuessFailures = 0;
  return formatSingle(r, label);
}

// --- auto-pagination --------------------------------------------------------

/** First top-level key whose value is an array (tickets, audits, comments,
 *  triggers, articles, results, ...). null if the body is itself an array. */
function collectionKey(json) {
  if (Array.isArray(json) || !json || typeof json !== "object") return null;
  for (const [k, v] of Object.entries(json)) if (Array.isArray(v)) return k;
  return null;
}

/** Next page URL across Zendesk's pagination styles, or null when done:
 *   - end_of_stream:true (incremental exports) → stop
 *   - cursor pagination: meta.has_more + links.next
 *   - offset (search, audits) & time-incremental: next_page (null at end)
 *   - cursor incremental: after_url */
function nextTarget(json) {
  if (!json || typeof json !== "object") return null;
  if (json.end_of_stream === true) return null;
  if (json.meta && json.links && json.meta.has_more && json.links.next) return json.links.next;
  if (json.next_page) return json.next_page;
  if (json.after_url) return json.after_url;
  return null;
}

/** Fetch every page of a list/export endpoint in one call. Loops server-side
 *  (one approval, no per-page prompts), pauses at 80% of the rate budget, and
 *  spills large aggregates to a file. */
async function zdGetAll(target, params = {}, { maxRecords = DEFAULT_MAX_RECORDS, label = "export" } = {}, subdomainSel) {
  let r = await zdRequest(target, params, subdomainSel);
  if (!r.ok) {
    if (isGuessFailure(r.status)) consecutiveGuessFailures++;
    throw augmentError(r);
  }
  consecutiveGuessFailures = 0;

  // Non-list response (e.g. a single object) — nothing to paginate.
  const firstKey = collectionKey(r.json);
  if (!Array.isArray(r.json) && firstKey === null) return formatSingle(r, label);

  const key = Array.isArray(r.json) ? null : firstKey;
  const items = [];
  let pages = 0;
  let stopReason = "complete (all pages fetched)";

  while (true) {
    pages++;
    const batch = Array.isArray(r.json) ? r.json : r.json[key] ?? [];
    items.push(...batch);

    if (items.length >= maxRecords) {
      stopReason = `stopped at max_records cap (${maxRecords}); more data remains`;
      break;
    }
    if (overRateBudget(r)) {
      stopReason = `paused at API rate budget (${r.remaining}/${r.limit} requests left this minute, ≥80% consumed); more data may remain`;
      break;
    }
    const next = nextTarget(r.json);
    if (!next) break;

    r = await zdRequest(next);
    if (!r.ok) {
      stopReason = `stopped after ${pages} page(s) on HTTP ${r.status}: ${HTTP_HINTS[r.status] ?? r.body.slice(0, 200)}`;
      break;
    }
    consecutiveGuessFailures = 0;
  }

  return deliverCollection(label, items, key, { pages, stop_reason: stopReason });
}

/** Fetch many records by ID via Zendesk's /{resource}/show_many batch endpoint,
 *  chunking the ID list into ≤100-id requests. One bulk pull instead of N single
 *  GETs — far fewer API calls. Rate-budget aware; spills large results to file. */
async function zdGetMany(resource, idsRaw, by = "ids", label, subdomainSel) {
  const res = String(resource).replace(/[^a-z_]/gi, "").toLowerCase();
  if (!res) throw new Error('Provide a resource, e.g. "tickets", "users", or "organizations".');
  const ids = String(idsRaw).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (!ids.length) throw new Error("Provide at least one id.");
  const field = by === "external_ids" ? "external_ids" : "ids";

  const items = [];
  let key = null;
  let chunks = 0;
  let stopReason = `complete (${ids.length} id(s) in ${Math.ceil(ids.length / 100)} batch(es))`;

  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const r = await zdRequest(`/${res}/show_many`, { [field]: chunk.join(",") }, subdomainSel);
    if (!r.ok) {
      if (isGuessFailure(r.status)) consecutiveGuessFailures++;
      if (chunks === 0) throw augmentError(r);
      stopReason = `stopped after ${chunks} batch(es) on HTTP ${r.status}: ${HTTP_HINTS[r.status] ?? r.body.slice(0, 200)}`;
      break;
    }
    consecutiveGuessFailures = 0;
    chunks++;
    key = key ?? collectionKey(r.json);
    const batch = Array.isArray(r.json) ? r.json : key ? r.json[key] ?? [] : [];
    items.push(...batch);
    if (overRateBudget(r) && i + 100 < ids.length) {
      stopReason = `paused at API rate budget after ${chunks} batch(es) (${i + chunk.length}/${ids.length} ids fetched); rerun with the remaining ids`;
      break;
    }
  }

  return deliverCollection(label || `${res}-show_many`, items, key, {
    requested_ids: ids.length,
    chunks,
    stop_reason: stopReason,
  });
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

const addSubFlag = process.argv.indexOf("--add-subdomain");
if (addSubFlag !== -1) {
  const spec = process.argv[addSubFlag + 1]; // "label=subdomain" or bare "subdomain"
  if (!spec) {
    console.error('Usage: node index.js --add-subdomain <label=subdomain>   (e.g. helpcenter=gygagent)');
    process.exit(1);
  }
  const [labelRaw, subRaw] = spec.includes("=") ? spec.split("=") : [spec, spec];
  const label = labelRaw.trim();
  const sub = (subRaw ?? labelRaw).trim();
  const reg = subdomainRegistry();
  reg.delete("default"); // never store the primary in the extras list
  reg.set(label, sub);
  const serialized = [...reg.entries()].map(([a, b]) => (a === b ? b : `${a}=${b}`)).join(",");
  kcSet(KC.subdomains, serialized);
  console.log(`Registered: ${label} → ${sub}. Configured extras: ${serialized}`);
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

const server = new McpServer({ name: "zendesk-read", version: "2.1.0" });

// --- Convenience tools (the 80% cases) -------------------------------------

server.registerTool(
  "search",
  {
    title: "Search Zendesk",
    description:
      "Search tickets, users, or organizations with Zendesk search syntax. " +
      'Examples: "type:ticket status:open assignee:me", "type:ticket created>2026-01-01 priority:high", ' +
      '"type:user email:alice@example.com", \'type:organization name:"Acme Corp"\'. ' +
      "Returns one page. For large result sets use zendesk_get_all with /search/export (cursor, no 1000 cap). " +
      "Note: /search has a much lower rate limit than other endpoints; avoid search-driven loops.",
    inputSchema: {
      query: z.string().describe("Zendesk search query (raw, not URL-encoded)"),
      page: z.number().int().min(1).optional().describe("Page number (default 1)"),
      per_page: z.number().int().min(1).max(100).optional().describe("Results per page, max 100"),
      sort_by: z.string().optional().describe("e.g. created_at, updated_at, priority, status"),
      sort_order: z.enum(["asc", "desc"]).optional(),
    },
  },
  async ({ query, ...params }) => run(() => zdGet("/search", { query, ...params }, "search"))
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
  async ({ id, include }) => run(() => zdGet(`/tickets/${id}`, { include }, `ticket-${id}`))
);

server.registerTool(
  "get_ticket_comments",
  {
    title: "Get ticket comments",
    description: "All public comments and internal notes on a ticket, including attachments metadata.",
    inputSchema: {
      id: z.number().int().describe("Ticket ID"),
      page_size: z.number().int().min(1).max(100).optional().describe("Results per page (maps to page[size])"),
    },
  },
  async ({ id, page_size }) =>
    run(() => zdGet(`/tickets/${id}/comments`, page_size ? { "page[size]": page_size } : {}, `ticket-${id}-comments`))
);

server.registerTool(
  "get_ticket_audits",
  {
    title: "Get ticket audits",
    description:
      "Full change history of a ticket: every status/assignee/field/tag change with timestamp and actor. " +
      "Use this for 'who closed it', 'why was it reopened', 'when did status flip', tag history, email headers. " +
      "For tickets with very long histories, use zendesk_get_all on /tickets/{id}/audits to get every page.",
    inputSchema: {
      id: z.number().int().describe("Ticket ID"),
      page_size: z.number().int().min(1).max(100).optional().describe("Results per page (maps to page[size])"),
    },
  },
  async ({ id, page_size }) =>
    run(() => zdGet(`/tickets/${id}/audits`, page_size ? { "page[size]": page_size } : {}, `ticket-${id}-audits`))
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
      if (id) return zdGet(`/users/${id}`, {}, `user-${id}`);
      if (email) return zdGet("/users/search", { query: email }, "user-search");
      throw new Error("Provide either id or email.");
    })
);

// --- Generic escape hatch (any documented GET endpoint) ---------------------

const ENDPOINT_MAP = `Endpoint quick map (path is relative to /api/v2):
- Bulk by ID — when you have a LIST of IDs to fetch, use the get_many tool (it batches via /{resource}/show_many, ≤100 ids/call). NEVER loop single GETs for many ids. Supports: /tickets/show_many?ids=, /users/show_many?ids=, /organizations/show_many?ids= (also ?external_ids=)
- Tickets: /tickets, /tickets/{id}, /tickets/show_many?ids=1,2,3, /tickets/recent, /tickets/{id}/incidents, /tickets/{id}/metrics, /ticket_fields, /ticket_forms
- Per-user tickets: /users/{uid}/tickets/requested|ccd|assigned
- Search: /search?query=... (1000-result cap), /search/count, /search/export (cursor-paginated, no cap — prefer for big pulls)
- Users: /users, /users/me, /users/{id}, /users/search?query=<email>, /users/{id}/identities, /users/{id}/groups, /users/{id}/organization_memberships
- Orgs: /organizations, /organizations/{id}, /organizations/{id}/users, /organizations/{id}/tickets, /organizations/search?name=...
- Views: /views, /views/{id}/tickets, /views/{id}/execute; Macros: /macros; Groups: /groups; Brands: /brands; CSAT: /satisfaction_ratings?ticket_id={id}
- Business rules (workflow/automation forensics): /triggers, /triggers/active, /triggers/{id}, /trigger_categories, /automations, /automations/active, /macros, /sla_policies, /routing/* (skills-based routing)
- Bulk/historical: /incremental/tickets/cursor.json?start_time=<unix> (cursor, page[size] up to 1000), /incremental/ticket_events.json?start_time=<unix>, /incremental/ticket_metric_events?start_time=<unix>, /incremental/users/cursor.json?start_time=<unix>, /incremental/organizations.json?start_time=<unix> — never paginate /tickets end-to-end
- Help Center / Guide (knowledge base): /help_center/articles, /help_center/articles/{id}, /help_center/articles/search?query=..., /help_center/{locale}/articles (e.g. en-us), /help_center/incremental/articles?start_time=<unix>, /help_center/sections, /help_center/sections/{id}/articles, /help_center/categories, /help_center/categories/{id}/sections, /help_center/articles/{id}/comments, /help_center/articles/{id}/votes, /help_center/user_segments, /help_center/permission_groups
  NOTE: a Help Center / Guide can live on a DIFFERENT brand subdomain than the main support instance. If articles 404 or look wrong, pass the "subdomain" argument to target that brand's instance (see below).`;

/** Built at startup from the configured instances, so the model sees which
 *  subdomains exist and when to pass the `subdomain` argument. */
const SUBDOMAIN_HINT = (() => {
  const reg = subdomainRegistry();
  if (reg.size <= 1) return "";
  const list = [...reg.entries()].map(([k, v]) => (k === v ? v : `${k} → ${v}`)).join("; ");
  return `\n\nMULTIPLE ZENDESK INSTANCES are configured (shared auth). Pass the optional "subdomain" argument — a label or a raw subdomain — to target one; omit it for the primary. Use the right instance for Help Center / brand-specific content. Available: ${list}. Default: ${reg.get("default") ?? "(primary)"}.`;
})();

server.registerTool(
  "zendesk_get",
  {
    title: "Zendesk GET (any endpoint)",
    description: `Call ANY documented Zendesk GET endpoint, ONE page. Use this whenever no specific tool fits — pick the endpoint yourself from the API reference: https://developer.zendesk.com/api-reference/ (Postman examples: https://www.postman.com/zendesk-redback/workspace/zendesk-public-api). Read-only: GET endpoints only, writes are impossible through this server. For endpoints that return many pages, prefer zendesk_get_all (it loops for you with a single approval).

${ENDPOINT_MAP}

Where ticket data lives (try related endpoints before reporting "not found"):
fields/tags/CCs → /tickets/{id} · comment bodies → /tickets/{id}/comments · change history/reopen reasons/email headers → /tickets/{id}/audits · SLA/first-reply times → /tickets/{id}/metrics · problem↔incident links → /tickets/{id}/incidents

Pagination: modern endpoints use cursor pages — params page[size] (max 100) + page[after] from meta.after_cursor, loop while meta.has_more. /search uses page/per_page with next_page URLs. Common 404 causes: plural vs singular, wrong noun (/incidents vs /problems). If unsure between endpoints, try the most likely one — a wrong guess is cheap and the error hints help. But if several guesses fail (404/422), the server will tell you to STOP and ask the user for the exact endpoint — do that rather than guessing on.${SUBDOMAIN_HINT}`,
    inputSchema: {
      path: z
        .string()
        .describe('Endpoint path relative to /api/v2, e.g. "/tickets/88421/audits" or "/views/123/execute"'),
      params: z
        .record(z.string())
        .optional()
        .describe('Query parameters as key/value strings, e.g. {"query": "type:ticket status:open", "page[size]": "100"}. Values are URL-encoded for you — pass them raw.'),
      subdomain: z
        .string()
        .optional()
        .describe('Optional: target a different Zendesk instance/brand by configured label or raw subdomain (e.g. "gygagent"). Use for Help Center / Guide content on another brand. Omit for the primary instance.'),
    },
  },
  async ({ path: p, params, subdomain }) => run(() => zdGet(p, params ?? {}, "zendesk_get", subdomain))
);

server.registerTool(
  "zendesk_get_all",
  {
    title: "Zendesk GET all pages (auto-paginate)",
    description: `Fetch ALL pages of a list or export endpoint in a SINGLE call. The server follows pagination internally — cursor, offset, and incremental styles — so you approve ONCE and it loops without further per-page prompts. It stops when the data is exhausted, when continuing would exceed 80% of the per-minute API rate budget (it reports where it paused), or at max_records. Large aggregates are written to a local JSON file and a preview + file path are returned; small results come back inline.

Use for bulk pulls: full ticket audit history (/tickets/{id}/audits), incremental exports (/incremental/tickets/cursor.json?start_time=, /incremental/ticket_events.json, /incremental/ticket_metric_events), all triggers/automations, every Help Center article (/help_center/articles or /help_center/incremental/articles), org/user listings, /search/export. For a single page, use zendesk_get instead.

${ENDPOINT_MAP}${SUBDOMAIN_HINT}`,
    inputSchema: {
      path: z
        .string()
        .describe('List/export endpoint relative to /api/v2, e.g. "/incremental/tickets/cursor.json", "/triggers", "/help_center/articles"'),
      params: z
        .record(z.string())
        .optional()
        .describe('Query params as strings, e.g. {"start_time": "1700000000", "page[size]": "100"}'),
      max_records: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(`Safety cap on total records (default ${DEFAULT_MAX_RECORDS})`),
      label: z
        .string()
        .optional()
        .describe('Short name used in the export filename, e.g. "inc-tickets" → inc-tickets-<timestamp>.json'),
      subdomain: z
        .string()
        .optional()
        .describe('Optional: target a different Zendesk instance/brand by configured label or raw subdomain (e.g. "gygagent"). Use for Help Center / Guide content on another brand. Omit for the primary instance.'),
    },
  },
  async ({ path: p, params, max_records, label, subdomain }) =>
    run(() => zdGetAll(p, params ?? {}, { maxRecords: max_records ?? DEFAULT_MAX_RECORDS, label: label ?? "export" }, subdomain))
);

server.registerTool(
  "get_many",
  {
    title: "Get many records by ID (bulk)",
    description:
      "Fetch MANY records by ID in one call using Zendesk's show_many batch endpoints — the server chunks the ID " +
      "list into ≤100-id requests automatically. STRONGLY prefer this over calling get_ticket/get_user/zendesk_get " +
      "repeatedly when you have a list of IDs: it is far fewer API calls and won't burn the per-minute rate budget " +
      "(e.g. 100 tickets = 1 call, not 100). Supports tickets, users, organizations (any resource with a " +
      "/{resource}/show_many endpoint). Rate-budget aware; large results spill to a file you read back with read_export.",
    inputSchema: {
      resource: z.string().describe('Resource with a show_many endpoint: "tickets", "users", or "organizations"'),
      ids: z.string().describe("IDs to fetch, comma- or space-separated (any count — chunked into 100s)"),
      by: z.enum(["ids", "external_ids"]).optional().describe("Match by Zendesk id (default) or external_ids"),
      label: z.string().optional().describe("Short name for the export filename if results spill to a file"),
      subdomain: z.string().optional().describe('Optional: target a different Zendesk instance/brand by configured label or raw subdomain. Omit for the primary instance.'),
    },
  },
  async ({ resource, ids, by, label, subdomain }) => run(() => zdGetMany(resource, ids, by ?? "ids", label, subdomain))
);

// --- Reading saved exports back (Cowork-safe: goes through the server) -------

server.registerTool(
  "list_exports",
  {
    title: "List saved Zendesk exports",
    description:
      "List the JSON export files this server has written (from large zendesk_get_all / zendesk_get results), " +
      "newest first, with sizes. Read one back with read_export. Works in Claude Cowork — the server reads its " +
      "own files on the host, so you don't need filesystem access to the export dir.",
    inputSchema: {},
  },
  async () =>
    run(async () => {
      const dir = exportDir();
      const files = fs
        .readdirSync(dir)
        .filter((n) => n.endsWith(".json"))
        .map((n) => {
          const st = fs.statSync(path.join(dir, n));
          return { name: n, bytes: st.size, mtimeMs: st.mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (!files.length) return `No exports in ${dir} yet.`;
      const lines = files.map((f) => `- ${f.name}  (${(f.bytes / 1024).toFixed(1)} KB)`);
      return `export dir: ${dir}\n${files.length} file(s):\n${lines.join("\n")}`;
    })
);

server.registerTool(
  "read_export",
  {
    title: "Read a saved Zendesk export",
    description:
      "Read records back from an export file this server wrote, paged so each call fits in context. Use this to " +
      "consume the full dataset after a large zendesk_get_all/zendesk_get spilled to a file — especially in Claude " +
      "Cowork, where you can't open the host file directly. Reads are local (no Zendesk API calls, no rate-limit cost). " +
      "Paging returns a WINDOW, not the whole file — keep calling with the offset it reports until it says END OF FILE " +
      "before counting or concluding. " +
      "To COUNT/AGGREGATE (e.g. trigger usage, tickets-by-status), do NOT page everything into context — pass count_by " +
      "with a field path and the server tallies ALL records at once. Only files inside the export dir are accessible.",
    inputSchema: {
      file: z.string().describe("Export filename (as shown by list_exports), e.g. inc-tickets-20260630-115819.json"),
      offset: z.number().int().min(0).optional().describe("Record index to start from (default 0)"),
      limit: z.number().int().min(1).optional().describe("Page mode: max records to return (auto-shrunk to fit context). count_by mode: max distinct values to list (default 100)"),
      count_by: z
        .string()
        .optional()
        .describe(
          'Aggregate mode: instead of returning records, tally ALL records by this dotted field path and return value counts (highest first). Descend into arrays with "[]". Examples: "status", "via.channel", "child_events[].via_reference_id". This is the correct way to answer count/usage/ranking questions — no paging required.'
        ),
      fields: z
        .string()
        .optional()
        .describe(
          'Comma-separated dotted field paths to keep from each record, e.g. "id,title,active" or "id,via.channel". Slims fat records so many more (often all) fit in one call — far fewer paging round-trips and approval prompts. Ignored in count_by mode.'
        ),
    },
  },
  async ({ file, offset, limit, count_by, fields }) =>
    run(async () => {
      const f = resolveExportFile(file);
      const recs = recordsOf(JSON.parse(fs.readFileSync(f, "utf8")));

      // Aggregate mode — tally over EVERY record server-side. No context flood,
      // no partial-window risk: the right way to answer count/usage questions.
      if (count_by) {
        const segments = String(count_by).split(".").filter(Boolean);
        const counts = new Map();
        let values = 0;
        for (const rec of recs) {
          for (const v of resolvePath(rec, segments)) {
            const k = v === null ? "null" : typeof v === "object" ? JSON.stringify(v) : String(v);
            counts.set(k, (counts.get(k) || 0) + 1);
            values++;
          }
        }
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit ?? 100);
        return (
          `✓ AGGREGATE over ALL ${recs.length} records in ${path.basename(f)} (field: ${count_by}).\n` +
          `${counts.size} distinct value(s), ${values} total occurrence(s). Top ${top.length} (count\tvalue):\n\n` +
          top.map(([k, n]) => `${n}\t${k}`).join("\n")
        );
      }

      const paths = fields ? String(fields).split(",").map((s) => s.trim()).filter(Boolean) : null;
      const pool = paths ? recs.map((r) => projectRecord(r, paths)) : recs;

      const start = Math.min(offset ?? 0, pool.length);
      let end = Math.min(start + (limit ?? pool.length), pool.length);
      let slice = pool.slice(start, end);
      let text = JSON.stringify(slice, null, 2);
      // Fit the window to the inline cap: estimate how many records fit, then
      // trim if still over. Keeps pages close to the cap (not half-empty), so
      // walking a file takes as few calls — and approval prompts — as possible.
      if (text.length > INLINE_MAX_CHARS && slice.length > 1) {
        const perRec = text.length / slice.length;
        const fit = Math.max(1, Math.floor(INLINE_MAX_CHARS / perRec));
        slice = pool.slice(start, start + fit);
        text = JSON.stringify(slice, null, 2);
        while (text.length > INLINE_MAX_CHARS && slice.length > 1) {
          slice = slice.slice(0, Math.max(1, slice.length - Math.ceil(slice.length * 0.1)));
          text = JSON.stringify(slice, null, 2);
        }
      }
      end = start + slice.length;
      const more = end < pool.length;
      const proj = paths ? ` (projected to: ${paths.join(", ")})` : "";
      const banner = more
        ? `⚠️ PARTIAL READ${proj} — records [${start}, ${end}) of ${pool.length}. You have NOT seen the other ${pool.length - end}. ` +
          `Call read_export again with offset=${end} and repeat until it says "END OF FILE" before counting, ranking, or concluding. ` +
          `${paths ? "" : "To fit more per call, pass fields=<comma-separated paths>; t"}${paths ? "T" : "t"}o tally the whole file in one call instead, pass count_by=<field>.`
        : `✓ END OF FILE${proj} — records [${start}, ${end}); you have now seen all ${pool.length}.`;
      return `file: ${path.basename(f)}\n${banner}\n\n${text}`;
    })
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
      "Show which Zendesk subdomain and auth mode (OAuth vs legacy API token) this server is using, list all " +
      "configured instances, and verify the API connection via /users/me. Pass subdomain to test the token against " +
      "a specific instance/brand.",
    inputSchema: {
      subdomain: z.string().optional().describe("Optional: verify the connection against a specific instance/brand (configured label or raw subdomain)"),
    },
  },
  async ({ subdomain: sel }) =>
    run(async () => {
      const target = resolveSubdomain(sel);
      const mode = kcGet(KC.clientId) ? "OAuth (authorization code + PKCE, scope: read)" : "legacy API token (EOL 2027-04-30 — migrate to OAuth)";
      const reg = subdomainRegistry();
      const known = [...reg.entries()].map(([k, v]) => (k === v ? v : `${k}=${v}`)).join(", ") || "(only default)";
      const me = await zdGet("/users/me", {}, "whoami", sel);
      return `subdomain: ${target}\nauth mode: ${mode}\nconfigured instances: ${known}\nexport dir: ${exportDir()}\n\n/users/me response:\n${me}`;
    })
);

// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
