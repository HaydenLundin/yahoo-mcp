import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { z } from "zod";
import { buildMessage } from "../../lib/compose";
import { ToolError } from "../../lib/errors";
import { locked, resolveSpecialUse, withImap } from "../../lib/imap";
import { replyThreading } from "../../lib/mime";
import { runTool, WRITE, WRITE_IDEMPOTENT, type ToolDeps } from "../tool";

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

/**
 * `mail.draft` tools (ARCHITECTURE.md section 5.2). Drafts live in Yahoo's Drafts folder, found by
 * special-use flag. Nothing here expunges: a deleted or superseded draft is moved to Trash.
 */
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
        "version is moved to Trash). All fields are required, as for create_draft. Returns the new uid.",
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
            const trash = await resolveSpecialUse(client, "\\Trash");
            await locked(client, folder, (c) => requireDraft(c, args.uid, folder));
            const uid = await appendDraft(client, folder, content);
            const moved = await locked(client, folder, (c) =>
              c.messageMove(String(args.uid), trash, { uid: true }),
            );
            if (!moved)
              throw new ToolError(
                "IMAP_MOVE_FAILED",
                `Saved the new draft as uid ${uid} in ${folder}, but Yahoo did not move the old draft ${args.uid} to ${trash}. Move it with trash_messages.`,
              );
            return {
              uid,
              folder,
              replaced_uid: args.uid,
              old_version_in: trash,
            };
          }),
      ),
  );

  server.registerTool(
    "delete_draft",
    {
      title: "Delete draft",
      description:
        "Move one draft from the Drafts folder to Trash, where it stays recoverable. Nothing is permanently " +
        "deleted by this server.",
      inputSchema: { uid: z.number().int().positive() },
      annotations: WRITE_IDEMPOTENT,
    },
    (args) =>
      runTool(
        deps,
        { name: "delete_draft", kind: "write", args, uids: [args.uid] },
        async () =>
          withImap(ctx, async (client) => {
            const folder = await resolveSpecialUse(client, "\\Drafts");
            const trash = await resolveSpecialUse(client, "\\Trash");
            const result = await locked(client, folder, async (c) => {
              await requireDraft(c, args.uid, folder);
              return c.messageMove(String(args.uid), trash, { uid: true });
            });
            if (!result)
              throw new ToolError(
                "IMAP_MOVE_FAILED",
                `Yahoo did not move draft ${args.uid} from ${folder} to ${trash}`,
              );
            return {
              trashed: true,
              uid: args.uid,
              folder,
              trash_folder: trash,
              trash_uid: result.uidMap?.get(args.uid) ?? null,
            };
          }),
      ),
  );
}

/**
 * The uid must exist in the Drafts folder. The \\Draft flag is deliberately not required: Yahoo
 * does not keep it on an APPENDed draft (seen live 2026-10-12), and since both draft tools only
 * ever move to Trash, a message that merely sits in Drafts loses nothing by qualifying.
 */
async function requireDraft(
  client: ImapFlow,
  uid: number,
  folder: string,
): Promise<void> {
  const existing = await client.fetchOne(
    String(uid),
    { uid: true },
    { uid: true },
  );
  if (!existing)
    throw new ToolError("NOT_FOUND", `No draft with uid ${uid} in ${folder}`);
}

/** Build the RFC 5322 text for a draft, threading it onto the original when replying. */
async function composeDraft(
  client: ImapFlow,
  from: string,
  args: DraftArgs,
): Promise<string> {
  const threading = args.in_reply_to_uid
    ? await locked(client, args.in_reply_to_folder, async (c) => {
        const original = await c.fetchOne(
          String(args.in_reply_to_uid),
          {
            uid: true,
            envelope: true,
            headers: ["message-id", "references", "in-reply-to"],
          },
          { uid: true },
        );
        if (!original) {
          throw new ToolError(
            "NOT_FOUND",
            `No message with uid ${args.in_reply_to_uid} in ${args.in_reply_to_folder}`,
          );
        }
        return replyThreading(original);
      })
    : {};
  return buildMessage({
    from,
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject,
    text: args.body_text,
    html: args.body_html,
    ...threading,
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
