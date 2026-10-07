import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ToolError } from "../../lib/errors";
import { pagedSearch, withMailbox } from "../../lib/imap";
import { BODY_LIMIT, listAttachments } from "../../lib/mime";
import { READ_ONLY, runTool, type ToolDeps } from "../tool";
import {
  fetchSummaries,
  readBody,
  toSummary,
  type MessageSummary,
} from "./read";

/**
 * ChatGPT's connector framework historically required two tools named exactly `search` and
 * `fetch` with fixed result shapes (ARCHITECTURE.md section 2.1). They are thin aliases over
 * search_messages and get_message, cost nothing for other clients, and are read-only.
 */
const SEARCH_LIMIT = 10;
const ID_RE = /^([^:]+):(\d+)$/;

export function registerCompatTools(server: McpServer, deps: ToolDeps): void {
  const ctx = { env: deps.env, waitUntil: deps.waitUntil };

  server.registerTool(
    "search",
    {
      title: "Search (connector alias)",
      description:
        "Free-text search of the inbox, newest first, in the result shape ChatGPT connectors expect: " +
        "{results: [{id, title, url}]}. Each id is 'FOLDER:uid' for fetch. Prefer search_messages when you can pass structured filters.",
      inputSchema: { query: z.string().min(1).max(500) },
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(deps, { name: "search", kind: "read" }, async () =>
        withMailbox(ctx, "INBOX", async (client) => {
          const page = await pagedSearch(
            client,
            { text: args.query },
            { offset: 0, limit: SEARCH_LIMIT },
          );
          const summaries = await fetchSummaries(client, page.uids, "INBOX");
          return {
            results: summaries.map((m) => ({
              id: `INBOX:${m.uid}`,
              title: titleOf(m),
              url: urlOf(m),
            })),
          };
        }),
      ),
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch (connector alias)",
      description:
        "Fetch one search result by id ('FOLDER:uid') in the shape ChatGPT connectors expect: " +
        "{id, title, text, url, metadata}. Same content as get_message. Attachment contents are never included.",
      inputSchema: {
        id: z.string().regex(ID_RE, "id must look like FOLDER:uid"),
      },
      annotations: READ_ONLY,
    },
    (args) =>
      runTool(deps, { name: "fetch", kind: "read" }, async () => {
        const m = ID_RE.exec(args.id);
        if (!m)
          throw new ToolError(
            "INVALID_ARGUMENT",
            "id must look like FOLDER:uid",
          );
        const folder = m[1];
        const uid = Number(m[2]);
        return withMailbox(ctx, folder, async (client) => {
          const msg = await client.fetchOne(
            String(uid),
            {
              uid: true,
              envelope: true,
              flags: true,
              size: true,
              bodyStructure: true,
              internalDate: true,
            },
            { uid: true },
          );
          if (!msg)
            throw new ToolError(
              "NOT_FOUND",
              `No message with uid ${uid} in ${folder}`,
            );
          const summary = toSummary(msg, folder);
          const body = await readBody(client, msg, "text", BODY_LIMIT);
          return {
            id: args.id,
            title: titleOf(summary),
            text: body.text,
            url: urlOf(summary),
            metadata: {
              folder,
              uid,
              from: summary.from,
              to: summary.to,
              cc: summary.cc,
              date: summary.date,
              unread: summary.unread,
              flagged: summary.flagged,
              truncated: body.truncated,
              attachments: listAttachments(msg.bodyStructure).map(
                (a) => a.filename,
              ),
            },
          };
        });
      }),
  );
}

function titleOf(m: MessageSummary): string {
  const who = m.from[0] ?? "unknown sender";
  const when = m.date ? m.date.slice(0, 10) : "";
  return `${m.subject ?? "(no subject)"} — ${who}${when ? ` — ${when}` : ""}`;
}

/** Yahoo Mail has no stable per-message web link; a keyword search deep link finds the message. */
function urlOf(m: MessageSummary): string {
  return m.subject
    ? `https://mail.yahoo.com/d/search/keyword=${encodeURIComponent(m.subject)}`
    : "https://mail.yahoo.com/d/folders/1";
}
