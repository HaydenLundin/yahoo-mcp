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
