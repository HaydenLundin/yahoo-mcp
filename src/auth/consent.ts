import { Hono } from "hono";
import { html, raw } from "hono/html";
import { secureHeaders } from "hono/secure-headers";
import type { AuthorizationError, AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";
import { requireOperator } from "./access";
import { CONNECTIONS_PATH, registerConnectionRoutes } from "./connections";
import { isSameOrigin, page } from "./ui";
import {
  SCOPES,
  SCOPE_TEXT,
  type Env,
  type GrantProps,
  type Scope,
} from "../types";

/**
 * Unprotected routes: landing page, health check, and the OAuth consent page.
 * Layer B of the auth design lives here: the operator (verified by Access) approves
 * an MCP client, and the provider mints that client its own tokens.
 */
export const authApp = new Hono<{ Bindings: Env }>();

// These pages render operator-trusted HTML only. No scripts anywhere, inline styles only.
// form-action and cross-origin-opener are deliberately NOT set: the consent POST redirects to
// the client's callback origin, and claude.ai completes OAuth in a popup that must keep its opener.
authApp.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      scriptSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
  }),
);

authApp.get("/", (c) =>
  c.html(
    page(
      "Yahoo Mail MCP",
      html`<h1>Yahoo Mail MCP</h1>
        <p>
          A remote MCP server for one Yahoo Mail account. Point an AI client at
          <code>${new URL(c.req.url).origin}/mcp</code>; it will be sent through
          OAuth.
        </p>
        <p class="muted">
          Read, draft, organize, and send-with-approval. No attachment
          downloads, no permanent delete.
        </p>
        <p class="muted">
          Operator: <a href="${CONNECTIONS_PATH}">manage connected clients</a>.
        </p>`,
    ),
  ),
);

authApp.get("/healthz", (c) => c.json({ ok: true }));

authApp.on(["GET", "POST"], "/authorize", async (c) => {
  const operator = await requireOperator(c.req.raw, c.env);
  if (operator instanceof Response) return operator;

  let authReq: AuthRequest;
  let client: ClientInfo | null;
  try {
    authReq = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
    client = await c.env.OAUTH_PROVIDER.lookupClient(authReq.clientId);
  } catch (err) {
    return authorizationErrorResponse(err);
  }
  if (!client) return c.text("Unknown OAuth client", 400);

  const granted = resolveScopes(authReq.scope);

  if (c.req.method === "GET") {
    return c.html(
      consentPage({
        client,
        authReq,
        granted,
        operator: operator.email,
        formAction: c.req.url,
        sendEnabled: c.env.SEND_ENABLED === "true",
      }),
    );
  }

  if (!isSameOrigin(c.req.raw))
    return c.text("Cross-site form submission rejected", 403);

  const form = await c.req.formData();
  if (form.get("decision") !== "approve") {
    const redirect = new URL(authReq.redirectUri);
    redirect.searchParams.set("error", "access_denied");
    redirect.searchParams.set(
      "error_description",
      "The operator declined the request",
    );
    if (authReq.state) redirect.searchParams.set("state", authReq.state);
    if (authReq.issuer) redirect.searchParams.set("iss", authReq.issuer);
    return c.redirect(redirect.toString(), 302);
  }

  const props: GrantProps = {
    clientId: client.clientId,
    clientName: client.clientName ?? client.clientId,
    scopes: granted,
    grantedAt: Date.now(),
    grantedBy: operator.email,
  };

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: authReq,
    userId: operator.email,
    metadata: {
      clientName: props.clientName,
      redirectUri: authReq.redirectUri,
      grantedAt: props.grantedAt,
    },
    scope: granted,
    props,
  });
  return c.redirect(redirectTo, 302);
});

registerConnectionRoutes(authApp);

/** Single operator, no per-scope toggles: grant what was asked (filtered to known scopes), or everything. */
function resolveScopes(requested: string[]): Scope[] {
  const known = requested.filter((s): s is Scope =>
    (SCOPES as readonly string[]).includes(s),
  );
  return known.length > 0 ? known : [...SCOPES];
}

/** Mirrors the provider README: render locally unless the client and redirect URI were validated. */
function authorizationErrorResponse(err: unknown): Response {
  if (isClientLookupError(err)) {
    console.warn("OAuth client lookup failed:", err.message);
    return new Response(
      "invalid_client: the client_id could not be resolved",
      { status: 400 },
    );
  }
  if (!isAuthorizationError(err)) throw err;
  if (!err.redirectUri)
    return new Response(`${err.code}: ${err.description}`, { status: 400 });
  const redirect = new URL(err.redirectUri);
  redirect.searchParams.set("error", err.code);
  redirect.searchParams.set("error_description", err.description);
  if (err.state) redirect.searchParams.set("state", err.state);
  if (err.issuer) redirect.searchParams.set("iss", err.issuer);
  // A plain Response rather than Response.redirect(): that one carries immutable headers,
  // and the security-headers middleware would throw while adding CSP, turning the OAuth
  // error into a 500.
  return new Response(null, {
    status: 302,
    headers: { location: redirect.toString() },
  });
}

/** The provider throws its own error class when a URL-shaped client_id cannot be fetched or parsed. */
function isClientLookupError(err: unknown): err is Error {
  return (
    err instanceof Error &&
    (err.name === "CimdFetchError" || "metadataUrl" in err)
  );
}

/**
 * Shape check instead of instanceof so this module has no runtime import of the provider
 * package (which imports `cloudflare:workers` at load time and cannot run under Node in tests).
 */
function isAuthorizationError(err: unknown): err is AuthorizationError {
  return (
    err instanceof Error &&
    typeof (err as { code?: unknown }).code === "string" &&
    typeof (err as { description?: unknown }).description === "string"
  );
}

interface ConsentView {
  client: ClientInfo;
  authReq: AuthRequest;
  granted: Scope[];
  operator: string;
  formAction: string;
  sendEnabled: boolean;
}

function consentPage({
  client,
  authReq,
  granted,
  operator,
  formAction,
  sendEnabled,
}: ConsentView) {
  const name = client.clientName ?? client.clientId;
  const redirectHost = new URL(authReq.redirectUri).host;
  const items = granted
    .map(
      (s) =>
        html`<li>
          <strong>${s}</strong><br /><span class="muted">${SCOPE_TEXT[s]}</span>
        </li>`,
    )
    .join("");
  const sendNote =
    granted.includes("mail.send") && !sendEnabled
      ? html`<p class="muted">
          Sending is switched off on this server (SEND_ENABLED is not "true"),
          so the send tools will not appear.
        </p>`
      : "";
  return page(
    `Allow ${name}?`,
    html`<h1>Allow <em>${name}</em> to use your Yahoo Mail?</h1>
      <p class="muted">
        Signed in as ${operator}. After approval the client is sent back to
        <code>${redirectHost}</code>.
      </p>
      <p>The client will be able to:</p>
      <ul>
        ${raw(items)}
      </ul>
      ${sendNote}
      <form method="post" action="${formAction}">
        <div class="actions">
          <button class="approve" name="decision" value="approve">Allow</button>
          <button class="deny" name="decision" value="deny">Deny</button>
        </div>
      </form>`,
  );
}
