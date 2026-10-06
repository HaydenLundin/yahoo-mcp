import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../../src/mcp/server";
import type { Env, GrantProps } from "../../src/types";

export interface AuditRow {
  ts: number;
  client_id: string;
  client_name: string;
  tool: string;
  args_digest: string;
  uids: string | null;
  outcome: string;
}

/** Minimal D1 stand-in that records every INSERT into audit_log. */
export class FakeD1 {
  rows: AuditRow[] = [];
  failNext = false;

  prepare(sql: string) {
    return {
      bind: (...values: unknown[]) => ({
        run: async () => {
          if (this.failNext) {
            this.failNext = false;
            throw new Error("D1_ERROR: simulated failure");
          }
          if (sql.includes("INSERT INTO audit_log")) {
            const [
              ts,
              client_id,
              client_name,
              tool,
              args_digest,
              uids,
              outcome,
            ] = values as [
              number,
              string,
              string,
              string,
              string,
              string | null,
              string,
            ];
            this.rows.push({
              ts,
              client_id,
              client_name,
              tool,
              args_digest,
              uids,
              outcome,
            });
          }
          return { success: true };
        },
      }),
    };
  }
}

export const PROPS: GrantProps = {
  clientId: "client-1",
  clientName: "Test Client",
  scopes: ["mail.read", "mail.draft", "mail.organize", "mail.send"],
  grantedAt: 0,
  grantedBy: "operator@example.com",
};

export function makeEnv(db: FakeD1, overrides: Partial<Env> = {}): Env {
  return {
    OAUTH_KV: {} as KVNamespace,
    DB: db as unknown as D1Database,
    OAUTH_PROVIDER: {} as Env["OAUTH_PROVIDER"],
    YAHOO_USER: "user@example.com",
    YAHOO_APP_PASSWORD: "app-password",
    SEND_ENABLED: "false",
    ...overrides,
  };
}

export interface Harness {
  client: Client;
  db: FakeD1;
  background: Promise<unknown>[];
  call: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<{ raw: CallToolResult; data: unknown }>;
  close: () => Promise<void>;
}

/** Wire a fresh server to an in-memory MCP client, exactly as a real client would see it. */
export async function startHarness(
  envOverrides: Partial<Env> = {},
): Promise<Harness> {
  const db = new FakeD1();
  const background: Promise<unknown>[] = [];
  const server = buildServer({
    env: makeEnv(db, envOverrides),
    props: PROPS,
    waitUntil: (p) => {
      background.push(p);
    },
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);

  return {
    client,
    db,
    background,
    async call(name, args = {}) {
      const raw = (await client.callTool({
        name,
        arguments: args,
      })) as CallToolResult;
      const text = raw.content[0]?.type === "text" ? raw.content[0].text : "";
      const data = raw.isError ? text : JSON.parse(text);
      return { raw, data };
    },
    async close() {
      await Promise.allSettled(background);
      await client.close();
      await server.close();
    },
  };
}
