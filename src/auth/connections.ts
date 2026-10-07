import type { Hono } from "hono";
import { html, raw } from "hono/html";
import type { Env } from "../types";
import { requireOperator } from "./access";
import { isSameOrigin, page } from "./ui";

/**
 * Operator console for revoking a client. It lives under /authorize on purpose: the Cloudflare
 * Access application that guards the consent page protects that path and everything beneath
 * it, so no second Access application is needed. Only the operator can reach it.
 */
export const CONNECTIONS_PATH = "/authorize/connections";

interface Activity {
  lastTs: number;
  calls: number;
}

export function registerConnectionRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get(CONNECTIONS_PATH, async (c) => {
    const operator = await requireOperator(c.req.raw, c.env);
    if (operator instanceof Response) return operator;

    const { items } = await c.env.OAUTH_PROVIDER.listUserGrants(
      operator.email,
      { limit: 100 },
    );
    const activity = await lastActivity(c.env);
    const rows = items
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((g) => {
        const meta = (g.metadata ?? {}) as { clientName?: string };
        const act = activity.get(g.clientId);
        return html`<tr>
          <td>
            <strong>${meta.clientName ?? g.clientId}</strong><br /><span
              class="muted"
              >${g.clientId}</span
            >
          </td>
          <td>${g.scope.join(" ")}</td>
          <td>${fmtDate(g.createdAt)}</td>
          <td>
            ${act ? `${fmtDate(act.lastTs)} (${act.calls} calls)` : "never"}
          </td>
          <td>
            <form method="post" action="${CONNECTIONS_PATH}/revoke">
              <input type="hidden" name="grant_id" value="${g.id}" />
              <button class="deny">Revoke</button>
            </form>
          </td>
        </tr>`;
      })
      .join("");

    const notice = c.req.query("revoked")
      ? html`<p class="notice">
          Access revoked. That client must go through sign-in and consent again
          to reconnect.
        </p>`
      : "";
    const table = items.length
      ? html`<table>
          <thead>
            <tr>
              <th>Client</th>
              <th>Scopes</th>
              <th>Granted</th>
              <th>Last activity</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${raw(rows)}
          </tbody>
        </table>`
      : html`<p>No clients are connected.</p>`;

    return c.html(
      page(
        "Connected clients",
        html`<h1>Connected clients</h1>
          <p class="muted">
            Signed in as ${operator.email}. Each row is one OAuth grant: an AI
            client allowed to use this mailbox. Revoking invalidates its access
            and refresh tokens immediately. Activity counts come from the audit
            log.
          </p>
          ${notice} ${table}`,
      ),
    );
  });

  app.post(`${CONNECTIONS_PATH}/revoke`, async (c) => {
    const operator = await requireOperator(c.req.raw, c.env);
    if (operator instanceof Response) return operator;
    if (!isSameOrigin(c.req.raw))
      return c.text("Cross-site form submission rejected", 403);

    const form = await c.req.formData();
    const grantId = String(form.get("grant_id") ?? "").trim();
    if (!grantId) return c.text("grant_id is required", 400);

    await c.env.OAUTH_PROVIDER.revokeGrant(grantId, operator.email);
    return c.redirect(`${CONNECTIONS_PATH}?revoked=1`, 303);
  });
}

async function lastActivity(env: Env): Promise<Map<string, Activity>> {
  const map = new Map<string, Activity>();
  try {
    const { results } = await env.DB.prepare(
      "SELECT client_id, MAX(ts) AS last_ts, COUNT(*) AS calls FROM audit_log GROUP BY client_id",
    ).all<{ client_id: string; last_ts: number; calls: number }>();
    for (const r of results ?? [])
      map.set(r.client_id, { lastTs: r.last_ts, calls: r.calls });
  } catch (err) {
    console.warn(
      "audit activity query failed",
      err instanceof Error ? err.message : err,
    );
  }
  return map;
}

function fmtDate(ts: number): string {
  return `${new Date(ts).toISOString().replace("T", " ").slice(0, 16)} UTC`;
}
