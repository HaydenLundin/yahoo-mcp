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

export interface PendingRowRecord {
  token: string;
  client_id: string;
  kind: string;
  preview: string;
  mime: Uint8Array;
  created_at: number;
  expires_at: number;
}

/**
 * Minimal D1 stand-in. Understands exactly the statements the code issues: audit_log inserts,
 * and insert / select-by-token / delete / purge on pending_sends.
 */
export class FakeD1 {
  rows: AuditRow[] = [];
  pending = new Map<string, PendingRowRecord>();
  failNext = false;

  prepare(sql: string) {
    const exec = async (values: unknown[]) => {
      if (this.failNext) {
        this.failNext = false;
        throw new Error("D1_ERROR: simulated failure");
      }
      if (sql.startsWith("INSERT INTO audit_log")) {
        const [ts, client_id, client_name, tool, args_digest, uids, outcome] =
          values as [
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
        return { changes: 1, first: null };
      }
      if (sql.startsWith("INSERT INTO pending_sends")) {
        const [token, client_id, kind, preview, mime, created_at, expires_at] =
          values as [
            string,
            string,
            string,
            string,
            Uint8Array,
            number,
            number,
          ];
        this.pending.set(token, {
          token,
          client_id,
          kind,
          preview,
          mime,
          created_at,
          expires_at,
        });
        return { changes: 1, first: null };
      }
      if (
        sql.startsWith("SELECT") &&
        sql.includes("FROM pending_sends WHERE token = ?1")
      ) {
        const row = this.pending.get(values[0] as string) ?? null;
        return {
          changes: 0,
          first: row
            ? {
                ...row,
                mime: row.mime.buffer.slice(
                  row.mime.byteOffset,
                  row.mime.byteOffset + row.mime.byteLength,
                ),
              }
            : null,
        };
      }
      if (
        sql.startsWith(
          "DELETE FROM pending_sends WHERE token = ?1 AND client_id = ?2",
        )
      ) {
        const row = this.pending.get(values[0] as string);
        if (row && row.client_id === values[1]) {
          this.pending.delete(row.token);
          return { changes: 1, first: null };
        }
        return { changes: 0, first: null };
      }
      if (sql.startsWith("DELETE FROM pending_sends WHERE token = ?1")) {
        return {
          changes: this.pending.delete(values[0] as string) ? 1 : 0,
          first: null,
        };
      }
      if (sql.startsWith("DELETE FROM pending_sends WHERE expires_at < ?1")) {
        let n = 0;
        for (const [k, v] of this.pending) {
          if (v.expires_at < (values[0] as number)) {
            this.pending.delete(k);
            n++;
          }
        }
        return { changes: n, first: null };
      }
      throw new Error(`FakeD1: unsupported SQL: ${sql}`);
    };
    return {
      bind: (...values: unknown[]) => ({
        run: async () => {
          const r = await exec(values);
          return { success: true, meta: { changes: r.changes } };
        },
        first: async <T>() => (await exec(values)).first as T | null,
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
  env: Env;
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
  props: GrantProps = PROPS,
): Promise<Harness> {
  const db = new FakeD1();
  const env = makeEnv(db, envOverrides);
  const background: Promise<unknown>[] = [];
  const server = buildServer({
    env,
    props,
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
    env,
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
