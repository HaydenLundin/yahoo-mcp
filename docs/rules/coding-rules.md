# Coding rules

Project-specific conventions. General style follows the global instructions.

## Tools

- One `server.registerTool(...)` per tool, grouped by scope in `src/mcp/tools/{read,draft,organize,send}.ts`.
- Names and parameters are snake_case and match the manifest in `ARCHITECTURE.md` section 5 exactly.
- Every tool declares all four MCP annotations. Use the presets in `src/mcp/tool.ts`; add a preset rather than inlining a new combination.
- The handler body runs inside `runTool(deps, meta, body)`. The wrapper owns error mapping and auditing. Tools never `try/catch` IMAP errors and never touch D1 directly.
- `meta.kind` is `"read"` for `mail.read` tools (audited at tool level only) and `"write"` for everything else (args digest recorded). Pass `uids` whenever the tool acts on specific messages.
- Return plain JSON-serialisable objects from the body; `runTool` renders them as text content.
- Descriptions are written for the model: say what the tool returns, what it never does, and which other tool to use next.

## IMAP

- Go through `withImap` or `withMailbox` in `src/lib/imap.ts`. Pass `waitUntil` so LOGOUT completes after the response.
- UID everywhere (`uid: true` on fetch, search, move, flags). Never sequence numbers.
- Resolve special folders by special-use flag via `list()`; never hardcode `Sent`, `Draft`, `Trash`, `Archive`, `Bulk`.
- Cap bodies at 50 KB in responses and say when truncated. Prefer `text/plain`; sanitise HTML to text when that is all there is.
- Never run a regex with a lazy body (`[\s\S]*?`), a backreference, or an unbounded negated class over message HTML; crafted input makes those quadratic or worse. Use the forward scanners in `src/lib/mime.ts` (`stripElements`, `replaceTags`, `linkifyAnchors`) and add a timing test for new ones.
- Outgoing headers go through `buildMessage`, which folds them and filters threading ids; never append a header line by hand.

## Data and logs

- Message bodies never reach `console.*`, the audit table, or error messages. `digestArgs` strips `body_text`, `body_html`, `note`.
- The audit row's `detail` (filled through the `note()` callback `runTool` passes to a tool body) holds counts, folder names, recipient domains, and message ids only.
- New D1 tables and columns go in a new numbered file under `migrations/`. Never edit an applied migration.

## Auth

- `/authorize` is the only route that trusts a human. It must call `requireOperator` before anything else.
- Never add a second bypass. `ACCESS_DEV_BYPASS` is the one dev escape hatch and it already refuses non-localhost hosts.
- Scopes gate tool registration in `buildServer`; never register a tool outside its scope group, and the send group also needs `mail.read`.
- Nothing expunges. A tool that "deletes" moves the message to Trash; never add `messageDelete` or EXPUNGE to a tool.

## Types and schemas

- `strict` TypeScript, no `any` outside the two documented casts (`ctx.props`, imapflow error shapes).
- Tool input schemas use zod v4 raw shapes (`{ uid: z.number().int().positive() }`), not `z.object`, so the SDK can derive JSON Schema.
