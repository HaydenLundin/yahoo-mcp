import { Hono } from "hono";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import {
  AuthorizationError,
  type AuthRequest,
  type ClientInfo,
} from "@cloudflare/workers-oauth-provider";
import { requireOperator } from "./access";
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
        </p>`,
    ),
  ),
);

authApp.get("/healthz", (c) => c.json({ ok: true }));

authApp.on(["GET", "POST"], "/authorize", async (c) => {
  const operator = await requireOperator(c.req.raw, c.env);
  if (operator instanceof Response) return operator;

  let authReq: AuthRequest;
  try {
    authReq = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (err) {
    return authorizationErrorResponse(err);
  }

  const client = await c.env.OAUTH_PROVIDER.lookupClient(authReq.clientId);
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

/** Single operator, no per-scope toggles: grant what was asked (filtered to known scopes), or everything. */
function resolveScopes(requested: string[]): Scope[] {
  const known = requested.filter((s): s is Scope =>
    (SCOPES as readonly string[]).includes(s),
  );
  return known.length > 0 ? known : [...SCOPES];
}

/** CSRF guard for the consent form. Browsers always send Sec-Fetch-Site or Origin on POST. */
function isSameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = req.headers.get("origin");
  return !origin || origin === new URL(req.url).origin;
}

/** Mirrors the provider README: render locally unless the client and redirect URI were validated. */
function authorizationErrorResponse(err: unknown): Response {
  if (!(err instanceof AuthorizationError)) throw err;
  if (!err.redirectUri)
    return new Response(`${err.code}: ${err.description}`, { status: 400 });
  const redirect = new URL(err.redirectUri);
  redirect.searchParams.set("error", err.code);
  redirect.searchParams.set("error_description", err.description);
  if (err.state) redirect.searchParams.set("state", err.state);
  if (err.issuer) redirect.searchParams.set("iss", err.issuer);
  return Response.redirect(redirect.toString(), 302);
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

function page(
  title: string,
  body: HtmlEscapedString | Promise<HtmlEscapedString> | string,
) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <style>
          :root {
            color-scheme: light dark;
          }
          body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            font-family:
              system-ui,
              -apple-system,
              "Segoe UI",
              sans-serif;
            background: #f4f4f5;
            color: #18181b;
          }
          .card {
            background: #fff;
            border-radius: 12px;
            padding: 2rem;
            max-width: 32rem;
            width: calc(100% - 2rem);
            box-sizing: border-box;
            box-shadow: 0 1px 3px rgb(0 0 0 / 0.15);
          }
          h1 {
            font-size: 1.25rem;
            line-height: 1.4;
            margin: 0 0 1rem;
          }
          ul {
            padding-left: 1.2rem;
            margin: 0.5rem 0 0;
          }
          li {
            margin: 0.5rem 0;
          }
          .muted {
            opacity: 0.7;
            font-size: 0.9rem;
          }
          .actions {
            display: flex;
            gap: 0.75rem;
            margin-top: 1.5rem;
          }
          button {
            font: inherit;
            padding: 0.6rem 1.2rem;
            border-radius: 8px;
            border: 1px solid transparent;
            cursor: pointer;
          }
          .approve {
            background: #2563eb;
            color: #fff;
          }
          .deny {
            background: transparent;
            border-color: currentColor;
            color: inherit;
          }
          code {
            font-size: 0.9em;
          }
          @media (prefers-color-scheme: dark) {
            body {
              background: #18181b;
              color: #f4f4f5;
            }
            .card {
              background: #27272a;
            }
          }
        </style>
      </head>
      <body>
        <main class="card">${body}</main>
      </body>
    </html>`;
}
