import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { z } from "zod";
import { buildMessage } from "../../lib/compose";
import { ToolError } from "../../lib/errors";
import {
  resolveSpecialUse,
  withImap,
  withMailbox,
  withSpecialUse,
} from "../../lib/imap";
import { parseHeaderBlock, splitMessageIds } from "../../lib/mime";
import { DESTRUCTIVE_IDEMPOTENT, runTool, WRITE, type ToolDeps } from "../tool";

const MAX_BODY = 200_000;

const draftFields = {
  to: z
    .array(z.string().min(3))
    .min(1)
    .max(50)
    .describe('Recipients: "user@example.com" or "Name <user@example.com>"'),
  cc: z.array(z.string().min(3)).max(50).optional(),
  bcc: z.array(z.string().min(3)).max(50).optional(),
  subject: z.string().min(1).max(998),
  body_text: z.string().max(MAX_BODY).describe("Plain-text body"),
  body_html: z
    .string()
    .max(MAX_BODY)
    .optional()
    .describe("Optional HTML alternative of the same content"),
  in_reply_to_uid: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "uid of the message this draft replies to; sets In-Reply-To and References",
    ),
  in_reply_to_folder: z
    .string()
    .min(1)
    .default("INBOX")
    .describe("Folder of in_reply_to_uid"),
};

type DraftArgs = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body_text: string;
  body_html?: string;
  in_reply_to_uid?: number;
  in_reply_to_folder: string;
};

/** `mail.draft` tools (ARCHITECTURE.md section 5.2). Drafts live in Yahoo's Drafts folder, found by special-use flag. */
export function registerDraftTools(server: McpServer, deps: ToolDeps): void {
  const ctx = { env: deps.env, waitUntil: deps.waitUntil };

  server.registerTool(
    "create_draft",
    {
      title: "Create draft",
      description:
        "Save a new draft in the Yahoo Drafts folder. Nothing is sent. Pass in_reply_to_uid to thread it as a reply " +
        "(In-Reply-To and References are filled from the original). Returns the draft's uid and folder.",
      inputSchema: draftFields,
      annotations: WRITE,
    },
    (args) =>
      runTool(deps, { name: "create_draft", kind: "write", args }, async () =>
        withImap(ctx, async (client) => {
          const content = await composeDraft(client, deps.env.YAHOO_USER, args);
          const folder = await resolveSpecialUse(client, "\\Drafts");
          const uid = await appendDraft(client, folder, content);
          return { uid, folder, bytes: content.length };
        }),
      ),
  );

  server.registerTool(
    "update_draft",
    {
      title: "Update draft",
      description:
        "Replace an existing draft with new content (IMAP has no in-place edit, so a new draft is saved and the old " +
        "one removed). All fields are required, as for create_draft. Returns the new uid.",
      inputSchema: {
        uid: z
          .number()
          .int()
          .positive()
          .describe("uid of the draft to replace"),
        ...draftFields,
      },
      annotations: WRITE,
    },
    (args) =>
      runTool(
        deps,
        { name: "update_draft", kind: "write", args, uids: [args.uid] },
        async () =>
          withImap(ctx, async (client) => {
            const content = await composeDraft(
              client,
              deps.env.YAHOO_USER,
              args,
            );
            const folder = await resolveSpecialUse(client, "\\Drafts");
            const lock = await client.getMailboxLock(folder);
            try {
              const existing = await client.fetchOne(
                String(args.uid),
                { uid: true },
                { uid: true },
              );
              if (!existing)
                throw new ToolError(
                  "NOT_FOUND",
                  `No draft with uid ${args.uid} in ${folder}`,
                );
            } finally {
              lock.release();
            }
            const uid = await appendDraft(client, folder, content);
            const lock2 = await client.getMailboxLock(folder);
            try {
              await client.messageDelete(String(args.uid), { uid: true });
            } finally {
              lock2.release();
            }
            return { uid, folder, replaced_uid: args.uid };
          }),
      ),
  );

  server.registerTool(
    "delete_draft",
    {
      title: "Delete draft",
      description:
        "Permanently delete one draft from the Drafts folder. This is the only permanent delete in this server.",
      inputSchema: { uid: z.number().int().positive() },
      annotations: DESTRUCTIVE_IDEMPOTENT,
    },
    (args) =>
      runTool(
        deps,
        { name: "delete_draft", kind: "write", args, uids: [args.uid] },
        async () =>
          withSpecialUse(ctx, "\\Drafts", async (client, folder) => {
            const existing = await client.fetchOne(
              String(args.uid),
              { uid: true },
              { uid: true },
            );
            if (!existing)
              throw new ToolError(
                "NOT_FOUND",
                `No draft with uid ${args.uid} in ${folder}`,
              );
            const ok = await client.messageDelete(String(args.uid), {
              uid: true,
            });
            if (!ok)
              throw new ToolError(
                "IMAP_DELETE_FAILED",
                `Yahoo did not delete draft ${args.uid}`,
              );
            return { deleted: true, uid: args.uid, folder };
          }),
      ),
  );
}

/** Build the RFC 5322 text for a draft, threading it onto the original when replying. */
async function composeDraft(
  client: ImapFlow,
  from: string,
  args: DraftArgs,
): Promise<string> {
  let inReplyTo: string | undefined;
  let references: string[] | undefined;
  if (args.in_reply_to_uid) {
    const lock = await client.getMailboxLock(args.in_reply_to_folder);
    try {
      const original = await client.fetchOne(
        String(args.in_reply_to_uid),
        { uid: true, envelope: true, headers: ["message-id", "references"] },
        { uid: true },
      );
      if (!original) {
        throw new ToolError(
          "NOT_FOUND",
          `No message with uid ${args.in_reply_to_uid} in ${args.in_reply_to_folder}`,
        );
      }
      const headers = parseHeaderBlock(original.headers);
      const originalId = original.envelope?.messageId ?? headers["message-id"];
      if (originalId) {
        inReplyTo = originalId;
        references = [...splitMessageIds(headers.references), originalId];
      }
    } finally {
      lock.release();
    }
  }
  return buildMessage({
    from,
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject,
    text: args.body_text,
    html: args.body_html,
    inReplyTo,
    references,
  });
}

async function appendDraft(
  client: ImapFlow,
  folder: string,
  content: string,
): Promise<number> {
  const result = await client.append(folder, content, ["\\Draft", "\\Seen"]);
  if (!result)
    throw new ToolError(
      "IMAP_APPEND_FAILED",
      `Yahoo did not accept the draft in ${folder}`,
    );
  if (typeof result.uid !== "number") {
    throw new ToolError(
      "IMAP_APPEND_FAILED",
      "Yahoo saved the draft but did not report its uid (no APPENDUID)",
    );
  }
  return result.uid;
}

/** Exported for tests and for the send tools in milestone 5. */
export { withMailbox };
