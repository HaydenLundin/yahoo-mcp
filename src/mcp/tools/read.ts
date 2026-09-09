import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ListResponse } from "imapflow";
import { withImap } from "../../lib/imap";
import { READ_ONLY, runTool, type ToolDeps } from "../tool";

/** `mail.read` tools (ARCHITECTURE.md section 5.1). Milestone 2 ships list_folders; the rest arrive in milestone 3. */
export function registerReadTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_folders",
    {
      title: "List folders",
      description:
        "List every folder in the Yahoo mailbox with its path, hierarchy delimiter, and special-use role " +
        "(inbox, sent, drafts, trash, archive, junk) when Yahoo reports one. Use these paths as the `folder` argument of other tools.",
      annotations: READ_ONLY,
    },
    () =>
      runTool(deps, { name: "list_folders", kind: "read" }, async () => {
        const folders = await withImap(
          { env: deps.env, waitUntil: deps.waitUntil },
          (client) => client.list(),
        );
        return {
          folders: folders
            .filter((f) => f.listed)
            .map((f) => ({
              path: f.path,
              delimiter: f.delimiter,
              special_use: specialUseName(f),
            })),
        };
      }),
  );
}

/** `\Sent` becomes "sent"; INBOX is special-use by definition even though IMAP has no flag for it. */
function specialUseName(f: ListResponse): string | null {
  if (f.path.toUpperCase() === "INBOX") return "inbox";
  return f.specialUse ? f.specialUse.replace(/^\\/, "").toLowerCase() : null;
}
