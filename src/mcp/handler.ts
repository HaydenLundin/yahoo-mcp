import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { buildServer } from "./server";
import type { Env, GrantProps } from "../types";

/**
 * Protected route. The OAuth provider has already validated the bearer token and
 * placed the grant's props on the execution context before this app sees a request.
 */
export const mcpApp = new Hono<{ Bindings: Env }>();

mcpApp.all("/mcp", async (c) => {
  const origin = c.req.header("origin");
  if (origin && !isAllowedOrigin(origin, c.req.url, c.env)) {
    return c.text("Origin not allowed", 403);
  }

  const ctx = c.executionCtx as ExecutionContext & { props?: GrantProps };
  if (!ctx.props) return c.text("Unauthorized", 401);

  const server = buildServer({
    env: c.env,
    props: ctx.props,
    waitUntil: (p) => ctx.waitUntil(p),
  });
  const transport = new StreamableHTTPTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const res = await transport.handleRequest(c);
  return res ?? c.notFound();
});

/**
 * DNS-rebinding guard. Server-side MCP clients (claude.ai, ChatGPT) send no Origin at all;
 * browser-based ones must match our origin or an explicit allowlist.
 */
function isAllowedOrigin(
  origin: string,
  requestUrl: string,
  env: Env,
): boolean {
  if (origin === new URL(requestUrl).origin) return true;
  const extra = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return extra.includes(origin);
}
