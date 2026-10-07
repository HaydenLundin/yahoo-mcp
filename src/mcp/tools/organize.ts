import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { z } from "zod";
import { ToolError } from "../../lib/errors";
import {
  resolveSpecialUse,
  withImap,
  withMailbox,
  type SpecialUse,
} from "../../lib/imap";
import { runTool, WRITE_IDEMPOTENT, type ToolDeps } from "../tool";

const MAX_UIDS = 200;
const uidList = z
  .array(z.number().int().positive())
  .min(1)
  .max(MAX_UIDS)
  .describe("Message uids in `from_folder`");

/**
 * `mail.organize` tools (ARCHITECTURE.md section 5.3). Yahoo has no labels: folders plus the
 * \Flagged flag (Gmail's star) are the whole vocabulary. Trash means "move to the Trash folder";
 * there is no permanent delete here.
 */
export function registerOrganizeTools(server: McpServer, deps: ToolDeps): void {
  const ctx = { env: deps.env, waitUntil: deps.waitUntil };

  server.registerTool(
    "move_messages",
    {
      title: "Move messages",
      description:
        "Move messages to another folder (paths from list_folders). Returns the new uids in the destination. " +
        "Use archive_messages or trash_messages for those special folders so Yahoo's own names are respected.",
      inputSchema: {
        uids: uidList,
        to_folder: z.string().min(1),
        from_folder: z.string().min(1).default("INBOX"),
      },
      annotations: WRITE_IDEMPOTENT,
    },
    (args) =>
      runTool(
        deps,
        { name: "move_messages", kind: "write", args, uids: args.uids },
        async () =>
          withMailbox(ctx, args.from_folder, (client) =>
            moveUids(client, args.uids, args.from_folder, args.to_folder),
          ),
      ),
  );

  server.registerTool(
    "archive_messages",
    {
      title: "Archive messages",
      description:
        "Move messages out of a folder into Yahoo's Archive folder (located by its special-use flag).",
      inputSchema: {
        uids: uidList,
        from_folder: z.string().min(1).default("INBOX"),
      },
      annotations: WRITE_IDEMPOTENT,
    },
    (args) =>
      runTool(
        deps,
        { name: "archive_messages", kind: "write", args, uids: args.uids },
        async () =>
          moveToSpecialUse(ctx, "\\Archive", args.uids, args.from_folder),
      ),
  );

  server.registerTool(
    "trash_messages",
    {
      title: "Trash messages",
      description:
        "Move messages to Yahoo's Trash folder (located by its special-use flag). Recoverable from Trash; " +
        "this server has no permanent delete for mail.",
      inputSchema: {
        uids: uidList,
        from_folder: z.string().min(1).default("INBOX"),
      },
      annotations: WRITE_IDEMPOTENT,
    },
    (args) =>
      runTool(
        deps,
        { name: "trash_messages", kind: "write", args, uids: args.uids },
        async () =>
          moveToSpecialUse(ctx, "\\Trash", args.uids, args.from_folder),
      ),
  );

  const flagTool = (
    name: string,
    title: string,
    description: string,
    flag: string,
    add: boolean,
  ) =>
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: {
          uids: uidList,
          folder: z.string().min(1).default("INBOX"),
        },
        annotations: WRITE_IDEMPOTENT,
      },
      (args) =>
        runTool(
          deps,
          { name, kind: "write", args, uids: args.uids },
          async () =>
            withMailbox(ctx, args.folder, async (client) => {
              const ok = add
                ? await client.messageFlagsAdd(args.uids, [flag], { uid: true })
                : await client.messageFlagsRemove(args.uids, [flag], {
                    uid: true,
                  });
              if (!ok)
                throw new ToolError(
                  "IMAP_STORE_FAILED",
                  `Yahoo rejected the flag change in ${args.folder}`,
                );
              return {
                updated: args.uids.length,
                folder: args.folder,
                flag,
                set: add,
              };
            }),
        ),
    );

  flagTool(
    "mark_read",
    "Mark as read",
    "Mark messages as read (sets \\Seen).",
    "\\Seen",
    true,
  );
  flagTool(
    "mark_unread",
    "Mark as unread",
    "Mark messages as unread (clears \\Seen).",
    "\\Seen",
    false,
  );
  flagTool(
    "flag_messages",
    "Flag messages",
    "Flag (star) messages. Yahoo's flag is the analogue of Gmail's star.",
    "\\Flagged",
    true,
  );
  flagTool(
    "unflag_messages",
    "Unflag messages",
    "Remove the flag (star) from messages.",
    "\\Flagged",
    false,
  );
}

async function moveToSpecialUse(
  ctx: { env: ToolDeps["env"]; waitUntil: ToolDeps["waitUntil"] },
  specialUse: SpecialUse,
  uids: number[],
  fromFolder: string,
) {
  return withImap(ctx, async (client) => {
    const destination = await resolveSpecialUse(client, specialUse);
    if (destination === fromFolder) {
      return {
        moved: 0,
        from_folder: fromFolder,
        to_folder: destination,
        uid_map: {},
        note: "already there",
      };
    }
    const lock = await client.getMailboxLock(fromFolder);
    try {
      return await moveUids(client, uids, fromFolder, destination);
    } finally {
      lock.release();
    }
  });
}

async function moveUids(
  client: ImapFlow,
  uids: number[],
  fromFolder: string,
  toFolder: string,
) {
  const result = await client.messageMove(uids, toFolder, { uid: true });
  if (!result)
    throw new ToolError(
      "IMAP_MOVE_FAILED",
      `Yahoo did not move the messages from ${fromFolder} to ${toFolder}`,
    );
  const uidMap: Record<string, number> = {};
  for (const [from, to] of result.uidMap ?? new Map<number, number>())
    uidMap[String(from)] = to;
  return {
    moved: uids.length,
    from_folder: fromFolder,
    to_folder: toFolder,
    uid_map: uidMap,
  };
}
