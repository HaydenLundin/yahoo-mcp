import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type {
  FetchMessageObject,
  ImapFlow,
  MessageAddressObject,
} from "imapflow";
import { z } from "zod";
import { buildMessage, parseAddress } from "../../lib/compose";
import { ToolError } from "../../lib/errors";
import { resolveSpecialUse, withImap, withMailbox } from "../../lib/imap";
import {
  formatAddress,
  listAttachments,
  parseHeaderBlock,
  splitMessageIds,
  toIsoDate,
} from "../../lib/mime";
import {
  createPending,
  deletePending,
  takePending,
  type PendingKind,
  type PendingPreview,
} from "../../lib/pending";
import { sendRaw } from "../../lib/smtp";
import { runTool, WRITE, WRITE_IDEMPOTENT, type ToolDeps } from "../tool";
import { readBody } from "./read";

const MAX_BODY = 200_000;
const FORWARD_BODY_LIMIT = 50_000;

/** confirm_send leaves the mailbox: destructive and open-world (ARCHITECTURE.md section 5.6). */
const CONFIRM: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

const NEXT_STEP =
  "Show this preview to the user and ask for confirmation. Only after they explicitly confirm in this turn, " +
  "call confirm_send with confirm_token. To discard, call cancel_send. The token expires in 5 minutes.";

const recipients = z
  .array(z.string().min(3))
  .max(50)
  .describe('"user@example.com" or "Name <user@example.com>"');

/**
 * `mail.send` tools (ARCHITECTURE.md section 5.4). Registered only when SEND_ENABLED is "true".
 * Phase one renders the full message, stores it with a single-use token, and returns a preview.
 * Phase two (confirm_send) is the only code path that touches SMTP.
 */
export function registerSendTools(server: McpServer, deps: ToolDeps): void {
  const ctx = { env: deps.env, waitUntil: deps.waitUntil };
  const self = deps.env.YAHOO_USER;

  server.registerTool(
    "send_message",
    {
      title: "Prepare a new message",
      description:
        "Prepare a new email for sending. Nothing is sent: this returns a preview and a confirm_token. " +
        NEXT_STEP,
      inputSchema: {
        to: recipients.pipe(z.array(z.string()).min(1)),
        cc: recipients.optional(),
        bcc: recipients.optional(),
        subject: z.string().min(1).max(998),
        body_text: z.string().min(1).max(MAX_BODY),
        body_html: z.string().max(MAX_BODY).optional(),
      },
      annotations: WRITE,
    },
    (args) =>
      runTool(deps, { name: "send_message", kind: "write", args }, async () => {
        const mime = buildMessage({
          from: self,
          to: args.to,
          cc: args.cc,
          bcc: args.bcc,
          subject: args.subject,
          text: args.body_text,
          html: args.body_html,
        });
        return stage(
          deps,
          "send",
          {
            to: args.to,
            cc: args.cc ?? [],
            bcc: args.bcc ?? [],
            subject: args.subject,
            body_text: args.body_text,
          },
          mime,
        );
      }),
  );

  server.registerTool(
    "reply_message",
    {
      title: "Prepare a reply",
      description:
        "Prepare a reply to a message. Recipients, subject, and threading headers come from the original; " +
        "reply_all also includes the original To and Cc (minus this account). Nothing is sent: returns a preview and a confirm_token. " +
        NEXT_STEP,
      inputSchema: {
        uid: z.number().int().positive(),
        folder: z.string().min(1).default("INBOX"),
        body_text: z.string().min(1).max(MAX_BODY),
        body_html: z.string().max(MAX_BODY).optional(),
        reply_all: z.boolean().default(false),
      },
      annotations: WRITE,
    },
    (args) =>
      runTool(
        deps,
        { name: "reply_message", kind: "write", args, uids: [args.uid] },
        async () =>
          withMailbox(ctx, args.folder, async (client) => {
            const original = await fetchOriginal(
              client,
              args.uid,
              args.folder,
              false,
            );
            const env = original.envelope ?? {};
            const { to, cc } = replyRecipients(env, self, args.reply_all);
            if (to.length === 0)
              throw new ToolError(
                "NO_RECIPIENT",
                "The original message has no address to reply to",
              );

            const headers = parseHeaderBlock(original.headers);
            const originalId = env.messageId ?? headers["message-id"];
            const subject = /^re:/i.test(env.subject ?? "")
              ? (env.subject as string)
              : `Re: ${env.subject ?? ""}`.trim();
            const mime = buildMessage({
              from: self,
              to,
              cc,
              subject,
              text: args.body_text,
              html: args.body_html,
              inReplyTo: originalId,
              references: originalId
                ? [...splitMessageIds(headers.references), originalId]
                : undefined,
            });
            return stage(
              deps,
              "reply",
              {
                to,
                cc,
                bcc: [],
                subject,
                body_text: args.body_text,
                in_reply_to_uid: args.uid,
              },
              mime,
            );
          }),
      ),
  );

  server.registerTool(
    "forward_message",
    {
      title: "Prepare a forward",
      description:
        "Prepare to forward a message's text to new recipients, with an optional note on top. Attachments are never " +
        "forwarded (their names are listed in the preview as attachments_omitted). Nothing is sent: returns a preview and a confirm_token. " +
        NEXT_STEP,
      inputSchema: {
        uid: z.number().int().positive(),
        folder: z.string().min(1).default("INBOX"),
        to: recipients.pipe(z.array(z.string()).min(1)),
        note: z
          .string()
          .max(MAX_BODY)
          .optional()
          .describe("Text to put above the forwarded message"),
      },
      annotations: WRITE,
    },
    (args) =>
      runTool(
        deps,
        { name: "forward_message", kind: "write", args, uids: [args.uid] },
        async () =>
          withMailbox(ctx, args.folder, async (client) => {
            const original = await fetchOriginal(
              client,
              args.uid,
              args.folder,
              true,
            );
            const env = original.envelope ?? {};
            const body = await readBody(
              client,
              original,
              "text",
              FORWARD_BODY_LIMIT,
            );
            const subject = /^fwd?:/i.test(env.subject ?? "")
              ? (env.subject as string)
              : `Fwd: ${env.subject ?? ""}`.trim();
            const header = [
              "---------- Forwarded message ----------",
              `From: ${(env.from ?? []).map(formatAddress).join(", ")}`,
              `Date: ${toIsoDate(env.date) ?? ""}`,
              `Subject: ${env.subject ?? ""}`,
              `To: ${(env.to ?? []).map(formatAddress).join(", ")}`,
            ].join("\n");
            const text = `${args.note ? `${args.note}\n\n` : ""}${header}\n\n${body.text}`;
            const omitted = listAttachments(original.bodyStructure).map(
              (a) => a.filename,
            );
            const mime = buildMessage({
              from: self,
              to: args.to,
              subject,
              text,
            });
            return stage(
              deps,
              "forward",
              {
                to: args.to,
                cc: [],
                bcc: [],
                subject,
                body_text: text,
                forwarded_uid: args.uid,
                attachments_omitted: omitted,
              },
              mime,
            );
          }),
      ),
  );

  server.registerTool(
    "confirm_send",
    {
      title: "Confirm and send",
      description:
        "Send a message previously prepared by send_message / reply_message / forward_message. ONLY call this after the " +
        "user has explicitly confirmed the preview in the current turn. Never call it speculatively.",
      inputSchema: { confirm_token: z.string().min(20).max(64) },
      annotations: CONFIRM,
    },
    (args) =>
      runTool(deps, { name: "confirm_send", kind: "write", args }, async () => {
        const taken = await takePending(
          deps.env,
          args.confirm_token,
          deps.props.clientId,
        );
        if (taken.status === "expired") {
          throw new ToolError(
            "CONFIRM_TOKEN_EXPIRED",
            "This preview expired (5 minutes). Prepare the message again and re-confirm.",
          );
        }
        if (taken.status !== "ok") {
          throw new ToolError(
            "CONFIRM_TOKEN_INVALID",
            "Unknown or already used confirm_token. Prepare the message again.",
          );
        }
        const { preview, mime } = taken.row;
        const rcpts = [...preview.to, ...preview.cc, ...preview.bcc].map(
          (a) => parseAddress(a).address,
        );
        const result = await sendRaw(deps.env, { from: self, to: rcpts }, mime);

        // Yahoo does not file SMTP sends into Sent on its own.
        let savedToSent = false;
        try {
          await withImap(ctx, async (client) => {
            const sent = await resolveSpecialUse(client, "\\Sent");
            const appended = await client.append(sent, mime, ["\\Seen"]);
            savedToSent = Boolean(appended);
          });
        } catch (err) {
          console.warn(
            "sent but could not file a copy in Sent",
            err instanceof Error ? err.message : err,
          );
        }
        return {
          sent: true,
          kind: preview.kind,
          to: preview.to,
          cc: preview.cc,
          bcc_count: preview.bcc.length,
          subject: preview.subject,
          message_id: result.messageId,
          accepted: result.accepted.length,
          rejected: result.rejected,
          saved_to_sent: savedToSent,
        };
      }),
  );

  server.registerTool(
    "cancel_send",
    {
      title: "Cancel a prepared message",
      description:
        "Discard a prepared message so its confirm_token can never be used.",
      inputSchema: { confirm_token: z.string().min(20).max(64) },
      annotations: WRITE_IDEMPOTENT,
    },
    (args) =>
      runTool(deps, { name: "cancel_send", kind: "write", args }, async () => ({
        cancelled: await deletePending(
          deps.env,
          args.confirm_token,
          deps.props.clientId,
        ),
      })),
  );
}

async function stage(
  deps: ToolDeps,
  kind: PendingKind,
  preview: Omit<PendingPreview, "kind">,
  mime: string,
) {
  const full: PendingPreview = { kind, ...preview };
  const { token, expiresAt } = await createPending(
    deps.env,
    deps.props.clientId,
    full,
    mime,
  );
  return {
    confirm_token: token,
    expires_at: new Date(expiresAt).toISOString(),
    preview: full,
    next_step: NEXT_STEP,
  };
}

async function fetchOriginal(
  client: ImapFlow,
  uid: number,
  folder: string,
  withStructure: boolean,
): Promise<FetchMessageObject> {
  const msg = await client.fetchOne(
    String(uid),
    {
      uid: true,
      envelope: true,
      bodyStructure: withStructure,
      headers: ["message-id", "references"],
    },
    { uid: true },
  );
  if (!msg)
    throw new ToolError("NOT_FOUND", `No message with uid ${uid} in ${folder}`);
  return msg;
}

interface EnvelopeLike {
  from?: MessageAddressObject[];
  replyTo?: MessageAddressObject[];
  to?: MessageAddressObject[];
  cc?: MessageAddressObject[];
}

/**
 * Who a reply goes to. Reply-To wins over From. This account is never a recipient of its own
 * reply; replying to a message we sent ourselves goes to its original recipients instead, and a
 * message from us to us (a note to self) is answered to ourselves.
 */
function replyRecipients(
  env: EnvelopeLike,
  self: string,
  replyAll: boolean,
): { to: string[]; cc: string[] } {
  const fmt = (list?: MessageAddressObject[]) =>
    (list ?? []).map(formatAddress).filter(Boolean);
  const notSelf = (a: string) => !sameAddress(a, self);
  const dedupe = (list: string[]) =>
    list.filter((a, i) => list.findIndex((b) => sameAddress(a, b)) === i);

  let to = dedupe(
    fmt(env.replyTo?.length ? env.replyTo : env.from).filter(notSelf),
  );
  if (to.length === 0) to = dedupe(fmt(env.to).filter(notSelf));
  // A note to self has no one else on it: reply to the only participant, ourselves.
  if (to.length === 0) to = dedupe(fmt(env.replyTo?.length ? env.replyTo : env.from));
  const cc = replyAll
    ? dedupe(
        [...fmt(env.to), ...fmt(env.cc)]
          .filter(notSelf)
          .filter((a) => !to.some((t) => sameAddress(t, a))),
      )
    : [];
  return { to, cc };
}

function sameAddress(a: string, b: string): boolean {
  try {
    return (
      parseAddress(a).address.toLowerCase() ===
      parseAddress(b).address.toLowerCase()
    );
  } catch {
    return false;
  }
}
