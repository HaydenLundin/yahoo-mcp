import type {
  CallToolResult,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { digestArgs, writeAudit } from "../lib/audit";
import { normalizeError } from "../lib/errors";
import type { Env, GrantProps } from "../types";

/** Everything a tool handler needs from the request that invoked it. */
export interface ToolDeps {
  env: Env;
  props: GrantProps;
  waitUntil: (p: Promise<unknown>) => void;
}

/** Annotation presets from ARCHITECTURE.md section 5.6. */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export interface RunToolMeta {
  name: string;
  /** Read tools are audited at tool level only; write tools also record an args digest. */
  kind: "read" | "write";
  args?: unknown;
  uids?: number[];
}

/**
 * Runs a tool body with the two cross-cutting behaviours every tool shares:
 * errors become `CODE: message` tool errors (never thrown into the transport), and
 * an audit row is written with the outcome. The audit write is awaited, not deferred,
 * so a row exists before the client ever sees the result.
 */
export async function runTool(
  deps: ToolDeps,
  meta: RunToolMeta,
  body: () => Promise<unknown>,
): Promise<CallToolResult> {
  const argsDigest =
    meta.kind === "write" ? await digestArgs(meta.args ?? {}) : "";
  try {
    const data = await body();
    await writeAudit(deps.env, deps.props, {
      tool: meta.name,
      argsDigest,
      uids: meta.uids,
      outcome: "ok",
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    const e = normalizeError(err);
    await writeAudit(deps.env, deps.props, {
      tool: meta.name,
      argsDigest,
      uids: meta.uids,
      outcome: "error",
    });
    return {
      content: [{ type: "text", text: `${e.code}: ${e.message}` }],
      isError: true,
    };
  }
}
