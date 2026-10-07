#!/usr/bin/env node
// End-to-end check of the whole client path against a running server:
//   401 challenge -> resource metadata -> AS metadata -> DCR -> PKCE authorize (consent) -> token
//   -> MCP initialize -> tools/list -> tools/call list_folders -> refresh token.
// Requires ACCESS_DEV_BYPASS=true on the server (local dev), since there is no browser to pass Access.
// Usage: node scripts/e2e-oauth.mjs [http://localhost:8787]
import { createHash, randomBytes } from "node:crypto";

const base = (process.argv[2] ?? "http://localhost:8787").replace(/\/$/, "");
const log = (...a) => console.log(...a);
const fail = (msg) => {
  console.error("\nFAIL:", msg);
  process.exit(1);
};
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const form = { "content-type": "application/x-www-form-urlencoded" };

// 1. Discovery, exactly as an MCP client does it.
const probe = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
if (probe.status !== 401) fail(`expected 401 from unauthenticated /mcp, got ${probe.status}`);
const www = probe.headers.get("www-authenticate") ?? "";
const rmUrl = /resource_metadata="([^"]+)"/.exec(www)?.[1];
if (!rmUrl) fail(`no resource_metadata in WWW-Authenticate: ${www}`);
const rm = await (await fetch(rmUrl)).json();
const issuer = rm.authorization_servers?.[0];
if (!issuer) fail(`no authorization_servers in ${rmUrl}`);
const as = await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json();
if (!as.authorization_endpoint || !as.token_endpoint) fail("AS metadata incomplete");
log("discovery ok:", { resource: rm.resource, issuer, register: as.registration_endpoint ?? "(disabled)" });

// 2. Dynamic client registration (public client, PKCE).
const redirectUri = "http://localhost:9999/callback";
const reg = await fetch(as.registration_endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "yahoo-mcp e2e",
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }),
});
if (!reg.ok) fail(`DCR failed ${reg.status}: ${await reg.text()}`);
const client = await reg.json();
log("registered client:", client.client_id);

// 3. Authorization code + PKCE. With ACCESS_DEV_BYPASS the consent page renders directly.
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(8));
const authUrl = new URL(as.authorization_endpoint);
authUrl.search = new URLSearchParams({
  response_type: "code",
  client_id: client.client_id,
  redirect_uri: redirectUri,
  scope: "mail.read mail.organize",
  state,
  code_challenge: challenge,
  code_challenge_method: "S256",
  resource: rm.resource,
}).toString();
const consent = await fetch(authUrl, { redirect: "manual" });
const consentHtml = await consent.text();
if (consent.status !== 200) fail(`expected consent page 200, got ${consent.status}: ${consentHtml.slice(0, 300)}`);
if (!consentHtml.includes("yahoo-mcp e2e")) fail("consent page does not show the client name");
if (!consentHtml.includes("mail.read") || consentHtml.includes("mail.send")) {
  fail("consent page does not reflect requested scopes");
}
log("consent page ok");

const approve = await fetch(authUrl, {
  method: "POST",
  redirect: "manual",
  headers: { ...form, origin: new URL(base).origin, "sec-fetch-site": "same-origin" },
  body: "decision=approve",
});
if (approve.status !== 302) {
  fail(`expected 302 after approve, got ${approve.status}: ${(await approve.text()).slice(0, 300)}`);
}
const cb = new URL(approve.headers.get("location"));
if (cb.searchParams.get("state") !== state) fail("state mismatch on redirect");
const code = cb.searchParams.get("code");
if (!code) fail(`no code in redirect: ${cb}`);
log("authorization code ok, iss =", cb.searchParams.get("iss"));

// 3b. CSRF guard: a cross-site POST must be rejected.
const csrf = await fetch(authUrl, {
  method: "POST",
  redirect: "manual",
  headers: { ...form, origin: "https://evil.example", "sec-fetch-site": "cross-site" },
  body: "decision=approve",
});
if (csrf.status !== 403) fail(`cross-site consent POST should be 403, got ${csrf.status}`);
log("csrf guard ok");

// 4. Token exchange.
const tokenRes = await fetch(as.token_endpoint, {
  method: "POST",
  headers: form,
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: client.client_id,
    code_verifier: verifier,
    resource: rm.resource,
  }),
});
if (!tokenRes.ok) fail(`token exchange failed ${tokenRes.status}: ${await tokenRes.text()}`);
const tokens = await tokenRes.json();
log("tokens ok:", { scope: tokens.scope, expires_in: tokens.expires_in, refresh: Boolean(tokens.refresh_token) });

// 5. MCP over Streamable HTTP (stateless, JSON responses).
const mcpHeaders = {
  authorization: `Bearer ${tokens.access_token}`,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "mcp-protocol-version": "2025-06-18",
};
let id = 0;
async function rpc(method, params) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: mcpHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await res.text();
  if (!res.ok) fail(`${method} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("text/event-stream")
    ? JSON.parse(
        text
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .at(-1),
      )
    : JSON.parse(text);
  if (body.error) fail(`${method} -> JSON-RPC error ${JSON.stringify(body.error)}`);
  return body.result;
}
const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "yahoo-mcp e2e", version: "0" },
});
log("initialize ok:", init.serverInfo, "protocol", init.protocolVersion);
const note = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: mcpHeaders,
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
});
if (note.status !== 202 && note.status !== 200) fail(`notifications/initialized -> ${note.status}`);
const tools = await rpc("tools/list", {});
log("tools:", tools.tools.map((t) => `${t.name}${t.annotations?.readOnlyHint ? " [read-only]" : ""}`).join(", "));
const t0 = Date.now();
const call = await rpc("tools/call", { name: "list_folders", arguments: {} });
if (call.isError) fail(`list_folders returned error: ${call.content?.[0]?.text}`);
const { folders } = JSON.parse(call.content[0].text);
log(
  `list_folders ok in ${Date.now() - t0} ms: ${folders.length} folders; special-use:`,
  folders
    .filter((f) => f.special_use)
    .map((f) => `${f.path}=${f.special_use}`)
    .join(", "),
);

// 5b. Read tools against the real mailbox. Counts and lengths only; never print mail content.
async function tool(name, args) {
  const started = Date.now();
  const res = await rpc("tools/call", { name, arguments: args });
  if (res.isError) fail(`${name} returned error: ${res.content?.[0]?.text}`);
  return { data: JSON.parse(res.content[0].text), ms: Date.now() - started };
}

const search = await tool("search_messages", { limit: 3 });
if (!Array.isArray(search.data.messages) || (search.data.total !== null && search.data.total < search.data.messages.length)) {
  fail("search_messages shape");
}
for (const m of search.data.messages) if ("body" in m) fail("search_messages leaked a body");
log(`search_messages ok in ${search.ms} ms: ${search.data.messages.length} of ${search.data.total ?? "unknown"} in ${search.data.folder}, has_more=${search.data.has_more}`);

const unread = await tool("search_messages", { unread_only: true, limit: 1 });
log(`search_messages(unread_only) ok in ${unread.ms} ms: total ${unread.data.total}`);

if (search.data.messages.length) {
  const uid = search.data.messages[0].uid;
  const msg = await tool("get_message", { uid });
  if (msg.data.uid !== uid || typeof msg.data.body !== "string" || !Array.isArray(msg.data.attachments)) {
    fail("get_message shape");
  }
  log(
    `get_message ok in ${msg.ms} ms: body_format=${msg.data.body_format} body_chars=${msg.data.body.length} ` +
      `truncated=${msg.data.truncated} attachments=${msg.data.attachments.length} references=${msg.data.references.length}`,
  );

  const thread = await tool("get_thread", { uid });
  if (!thread.data.messages.some((m) => m.uid === uid)) fail("get_thread does not include the requested message");
  log(
    `get_thread ok in ${thread.ms} ms: ${thread.data.messages.length} message(s), matched_by=${thread.data.matched_by}, ` +
      `thread_id=${thread.data.thread_id ? "yes" : "no"}`,
  );
}

const drafts = await tool("list_drafts", { limit: 5 });
log(`list_drafts ok in ${drafts.ms} ms: ${drafts.data.messages.length} of ${drafts.data.total} in ${drafts.data.folder}`);

// 5c. Write tools, self-cleaning: a draft is created, updated, listed, and deleted; the newest
// message gets flagged and unflagged and its read state toggled and restored. Nothing is moved.
const stamp = `yahoo-mcp e2e ${new Date().toISOString()}`;
const created = await tool("create_draft", { to: ["e2e@example.com"], subject: stamp, body_text: "Draft written by the e2e test. Safe to delete." });
if (typeof created.data.uid !== "number") fail("create_draft shape");
log(`create_draft ok in ${created.ms} ms: uid ${created.data.uid} in ${created.data.folder}`);

const updated = await tool("update_draft", { uid: created.data.uid, to: ["e2e@example.com"], subject: `${stamp} (v2)`, body_text: "Updated by the e2e test.", body_html: "<p>Updated by the e2e test.</p>" });
if (updated.data.replaced_uid !== created.data.uid || typeof updated.data.uid !== "number") fail("update_draft shape");
log(`update_draft ok in ${updated.ms} ms: ${created.data.uid} -> ${updated.data.uid}`);

const listed = await tool("list_drafts", { limit: 5 });
if (!listed.data.messages.some((m) => m.uid === updated.data.uid)) fail("updated draft not in list_drafts");
if (listed.data.messages.some((m) => m.uid === created.data.uid)) fail("old draft still listed after update");
log(`list_drafts ok in ${listed.ms} ms: new draft present, old one gone`);

const deleted = await tool("delete_draft", { uid: updated.data.uid });
if (deleted.data.deleted !== true) fail("delete_draft shape");
log(`delete_draft ok in ${deleted.ms} ms`);

if (search.data.messages.length) {
  const target = search.data.messages[0];
  const flagged = await tool("flag_messages", { uids: [target.uid] });
  const unflagged = await tool("unflag_messages", { uids: [target.uid] });
  if (flagged.data.updated !== 1 || unflagged.data.updated !== 1) fail("flag tools shape");
  log(`flag/unflag ok in ${flagged.ms}+${unflagged.ms} ms`);
  const wasUnread = target.unread;
  const first = await tool(wasUnread ? "mark_read" : "mark_unread", { uids: [target.uid] });
  const restore = await tool(wasUnread ? "mark_unread" : "mark_read", { uids: [target.uid] });
  if (first.data.updated !== 1 || restore.data.updated !== 1) fail("mark tools shape");
  log(`mark read/unread toggled and restored in ${first.ms}+${restore.ms} ms`);
}

// 5d. Send tools, phase one only. Every prepared message is cancelled; nothing is ever sent by this script.
const toolNames = tools.tools.map((t) => t.name);
if (toolNames.includes("send_message")) {
  const prepared = await tool("send_message", { to: ["e2e@example.com"], subject: `${stamp} send`, body_text: "Never sent: the e2e cancels this." });
  if (!/^[A-Za-z0-9_-]{43}$/.test(prepared.data.confirm_token) || prepared.data.preview.kind !== "send") fail("send_message shape");
  log(`send_message ok in ${prepared.ms} ms: token issued, expires ${prepared.data.expires_at}`);
  const cancelled = await tool("cancel_send", { confirm_token: prepared.data.confirm_token });
  if (cancelled.data.cancelled !== true) fail("cancel_send did not cancel");
  const stale = await rpc("tools/call", { name: "confirm_send", arguments: { confirm_token: prepared.data.confirm_token } });
  if (!stale.isError || !String(stale.content?.[0]?.text).startsWith("CONFIRM_TOKEN_INVALID")) fail("cancelled token was accepted by confirm_send");
  log(`cancel_send ok in ${cancelled.ms} ms; confirm after cancel correctly refused`);

  if (search.data.messages.length) {
    const uid = search.data.messages[0].uid;
    const reply = await tool("reply_message", { uid, body_text: "Never sent: e2e reply preview." });
    if (reply.data.preview.kind !== "reply" || !Array.isArray(reply.data.preview.to)) fail("reply_message shape");
    await tool("cancel_send", { confirm_token: reply.data.confirm_token });
    log(`reply_message ok in ${reply.ms} ms: ${reply.data.preview.to.length} recipient(s), subject starts with Re: ${/^Re:/i.test(reply.data.preview.subject)}`);
    const fwd = await tool("forward_message", { uid, to: ["e2e@example.com"], note: "e2e" });
    if (fwd.data.preview.kind !== "forward") fail("forward_message shape");
    await tool("cancel_send", { confirm_token: fwd.data.confirm_token });
    log(`forward_message ok in ${fwd.ms} ms: body ${fwd.data.preview.body_text.length} chars, attachments omitted ${fwd.data.preview.attachments_omitted.length}`);
  }
} else {
  log("send tools absent (SEND_ENABLED is not true on this server); skipping phase-one checks");
}

// 5e. OPT-IN real send to self. Runs only with E2E_SEND_SELF=1 and only against a server whose
// YAHOO_USER we can read from .dev.vars. Sends exactly one message, from the account to itself.
if (process.env.E2E_SEND_SELF === "1" && toolNames.includes("send_message")) {
  const { readFileSync } = await import("node:fs");
  const selfAddr = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split(/\r?\n/)
    .map((l) => /^YAHOO_USER=(.+)$/.exec(l)?.[1]?.trim())
    .find(Boolean);
  if (!selfAddr) fail("YAHOO_USER not found in .dev.vars");
  const subject = `yahoo-mcp test send ${stamp}`;
  const prepared = await tool("send_message", {
    to: [selfAddr],
    subject,
    body_text: "This is a one-time test send from yahoo-mcp (milestone 5). Safe to delete.",
  });
  const confirmed = await tool("confirm_send", { confirm_token: prepared.data.confirm_token });
  if (confirmed.data.sent !== true || confirmed.data.accepted !== 1) fail(`confirm_send shape: ${JSON.stringify(confirmed.data)}`);
  log(`confirm_send ok in ${confirmed.ms} ms: accepted=${confirmed.data.accepted} rejected=${confirmed.data.rejected.length} saved_to_sent=${confirmed.data.saved_to_sent} message_id=${confirmed.data.message_id ? "yes" : "no"}`);

  let arrived = null;
  for (let i = 0; i < 12 && !arrived; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const found = await tool("search_messages", { subject, limit: 5 });
    arrived = found.data.messages[0] ?? null;
  }
  if (!arrived) fail("test message did not arrive in INBOX within 60 s");
  log(`arrived in INBOX as uid ${arrived.uid}, unread=${arrived.unread}`);

  const sentFolder = folders.find((f) => f.special_use === "sent")?.path;
  if (!sentFolder) fail("no Sent folder");
  const inSent = await tool("search_messages", { subject, folder: sentFolder, limit: 5 });
  if (inSent.data.messages.length < 1) fail("no copy of the test message in Sent");
  log(`copy filed in ${sentFolder} as uid ${inSent.data.messages[0].uid}`);
}

// 6. Refresh token rotation.
const refresh = await fetch(as.token_endpoint, {
  method: "POST",
  headers: form,
  body: new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: client.client_id,
  }),
});
if (!refresh.ok) fail(`refresh failed ${refresh.status}: ${await refresh.text()}`);
const refreshed = await refresh.json();
if (!refreshed.access_token || refreshed.access_token === tokens.access_token) {
  fail("refresh did not issue a new access token");
}
log("refresh ok");

// 7. Garbage token must be rejected.
const bad = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { ...mcpHeaders, authorization: "Bearer not-a-token" },
  body: "{}",
});
if (bad.status !== 401) fail(`garbage bearer should be 401, got ${bad.status}`);
log("bad token rejected ok");

log("\nE2E PASS");
