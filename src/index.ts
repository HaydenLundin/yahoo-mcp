import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { authApp } from "./auth/consent";
import { mcpApp } from "./mcp/handler";
import { SCOPES, type Env } from "./types";

/**
 * One Worker, three responsibilities (ARCHITECTURE.md section 3):
 *  - OAuth 2.1 authorization server for MCP clients (this wrapper; state in OAUTH_KV)
 *  - MCP endpoint at /mcp (mcpApp; bearer-protected by the wrapper)
 *  - consent UI at /authorize (authApp; guarded by Cloudflare Access)
 * Resource metadata (RFC 9728) is derived from the request, so the same code serves
 * localhost during development and the workers.dev hostname in production.
 */
const provider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: { fetch: (request, env, ctx) => mcpApp.fetch(request, env, ctx) },
  defaultHandler: {
    fetch: (request, env, ctx) => authApp.fetch(request, env, ctx),
  },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  // DCR stays on for client compatibility; CIMD is the MCP 2026-07-28 preferred path.
  clientRegistrationEndpoint: "/register",
  clientIdMetadataDocumentEnabled: true,
  scopesSupported: [...SCOPES],
  resourceMetadata: {
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Yahoo Mail MCP",
  },
});

export default {
  fetch: (request, env, ctx) => provider.fetch(request, env, ctx),
  scheduled: (_event, env, ctx) => {
    ctx.waitUntil(provider.purgeExpiredData(env, { batchSize: 100 }));
    // Milestone 5: purge expired pending_sends here too.
  },
} satisfies ExportedHandler<Env>;
