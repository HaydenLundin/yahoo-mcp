import type { MessageAddressObject, MessageStructureObject } from "imapflow";
import iconv from "iconv-lite";
import { Buffer } from "node:buffer";

/** Hard cap on body text returned to a client (ARCHITECTURE.md section 6). */
export const BODY_LIMIT = 50_000;

export interface AttachmentMeta {
  filename: string;
  mime: string;
  size: number | null;
}

/** What downloadText needs to fetch and decode one body part. */
export interface BodyPart {
  /** IMAP part id ("1", "1.2"). A single-part message has no id in BODYSTRUCTURE; it is "1". */
  id: string;
  mime: string;
  encoding?: string;
  charset?: string;
  /** Transfer-encoded size from BODYSTRUCTURE when the server reported one. Yahoo's matches the bytes BODY[part] serves exactly. */
  size?: number;
}

export interface BodyParts {
  text?: BodyPart;
  html?: BodyPart;
}

/** Pick the parts worth downloading: the first non-attachment text/plain and text/html leaves. */
export function selectBodyParts(
  root: MessageStructureObject | undefined,
): BodyParts {
  const parts: BodyParts = {};
  if (!root) return parts;
  walkLeaves(root, (node) => {
    if (isAttachment(node)) return;
    const type = node.type.toLowerCase();
    if (type === "text/plain" && !parts.text) parts.text = toBodyPart(node);
    else if (type === "text/html" && !parts.html) parts.html = toBodyPart(node);
  });
  return parts;
}

function toBodyPart(node: MessageStructureObject): BodyPart {
  return {
    id: node.part ?? "1",
    mime: node.type.toLowerCase(),
    encoding: node.encoding?.toLowerCase(),
    charset: node.parameters?.charset?.toLowerCase(),
    size: typeof node.size === "number" ? node.size : undefined,
  };
}

/** Attachment names, types, and sizes. Content is never downloaded by this server. */
export function listAttachments(
  root: MessageStructureObject | undefined,
): AttachmentMeta[] {
  const out: AttachmentMeta[] = [];
  if (!root) return out;
  walkLeaves(root, (node) => {
    if (!isAttachment(node)) return;
    out.push({
      filename: attachmentName(node),
      mime: node.type.toLowerCase(),
      size: typeof node.size === "number" ? node.size : null,
    });
  });
  return out;
}

function walkLeaves(
  node: MessageStructureObject,
  visit: (leaf: MessageStructureObject) => void,
): void {
  // An attached message (message/rfc822) is a leaf here: its inner parts belong to another
  // message and must never be served as this one's body or hidden from the attachment list.
  if (node.type.toLowerCase() === "message/rfc822") {
    visit(node);
    return;
  }
  if (node.childNodes && node.childNodes.length > 0) {
    for (const child of node.childNodes) walkLeaves(child, visit);
    return;
  }
  visit(node);
}

function isAttachment(node: MessageStructureObject): boolean {
  const type = node.type.toLowerCase();
  if (type.startsWith("multipart/")) return false;
  if (node.disposition?.toLowerCase() === "attachment") return true;
  if (node.dispositionParameters?.filename || node.parameters?.name)
    return true;
  return !type.startsWith("text/");
}

function attachmentName(node: MessageStructureObject): string {
  return (
    node.dispositionParameters?.filename ||
    node.parameters?.name ||
    (node.type.toLowerCase() === "message/rfc822" ? "message.eml" : "unnamed")
  );
}

/** Transfer-decode then charset-decode raw part bytes as fetched from the server. */
export function decodeBody(
  raw: Uint8Array,
  part: Pick<BodyPart, "encoding" | "charset">,
): string {
  return decodeCharset(decodeTransfer(raw, part.encoding), part.charset);
}

export function decodeTransfer(raw: Uint8Array, encoding?: string): Uint8Array {
  switch ((encoding ?? "").toLowerCase()) {
    case "base64": {
      const text = Buffer.from(raw)
        .toString("latin1")
        .replace(/[^A-Za-z0-9+/=]/g, "");
      return new Uint8Array(Buffer.from(text, "base64"));
    }
    case "quoted-printable":
      return decodeQuotedPrintable(raw);
    default:
      return raw;
  }
}

function decodeQuotedPrintable(raw: Uint8Array): Uint8Array {
  // Soft line breaks ("=" at end of line) join lines; "=XX" is a hex-encoded byte.
  const s = Buffer.from(raw)
    .toString("latin1")
    .replace(/=\r?\n/g, "");
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (
      c === 0x3d &&
      i + 2 < s.length &&
      /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))
    ) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(c);
    }
  }
  return Uint8Array.from(out);
}

export function decodeCharset(bytes: Uint8Array, charset?: string): string {
  const label = (charset ?? "utf-8").toLowerCase().replace(/^x-/, "");
  if (["utf-8", "utf8", "us-ascii", "ascii"].includes(label))
    return new TextDecoder("utf-8").decode(bytes);
  if (iconv.encodingExists(label))
    return iconv.decode(Buffer.from(bytes), label);
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Enough HTML-to-text for a model to read an email: structure kept, markup and scripts gone. */
export function htmlToText(html: string): string {
  let s = stripComments(stripElements(html, DROPPED_ELEMENTS));
  // Source whitespace (newlines, indentation) is not layout in HTML; flatten it first so
  // the only line breaks in the output are the ones we add from structure.
  s = s.replace(/\s+/g, " ");
  s = replaceTags(linkifyAnchors(s));
  s = decodeEntities(s);
  s = s.replace(/\r/g, "");
  s = s.replace(/[ \t ]+\n/g, "\n").replace(/\n[ \t ]+/g, "\n");
  s = s.replace(/[ \t ]{2,}/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

const DROPPED_ELEMENTS = ["script", "style", "head", "title"] as const;

/**
 * Remove `<tag ...>...</tag>` blocks for the given tags in one forward scan; an unclosed block
 * runs to the end. Regexes with lazy bodies and backreferences went cubic on crafted HTML made
 * of unclosed openers (20 KB took seconds), and the Worker's CPU budget is milliseconds.
 */
export function stripElements(html: string, tags: readonly string[]): string {
  const lower = html.toLowerCase();
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    const open = nextOpener(lower, i, tags);
    if (!open) {
      parts.push(html.slice(i));
      break;
    }
    parts.push(html.slice(i, open.index));
    const close = lower.indexOf(`</${open.tag}`, open.index + open.tag.length + 1);
    if (close === -1) break;
    const end = lower.indexOf(">", close);
    if (end === -1) break;
    i = end + 1;
  }
  return parts.join("");
}

/** The earliest `<tag` followed by whitespace, `>`, `/` or the end of input. */
function nextOpener(
  lower: string,
  from: number,
  tags: readonly string[],
): { index: number; tag: string } | null {
  let best: { index: number; tag: string } | null = null;
  for (const tag of tags) {
    let idx = lower.indexOf(`<${tag}`, from);
    while (idx !== -1 && (best === null || idx < best.index)) {
      const after = lower.charAt(idx + tag.length + 1);
      if (after === "" || after === ">" || after === "/" || /\s/.test(after)) {
        best = { index: idx, tag };
        break;
      }
      idx = lower.indexOf(`<${tag}`, idx + 1);
    }
  }
  return best;
}

/** Closing these ends a paragraph (blank line); closing the LINE_END set ends a line. */
const PARAGRAPH_END = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "blockquote", "pre", "table"]);
const LINE_END = new Set(["div", "tr", "section", "article", "header", "footer", "dd", "dt"]);

/**
 * One forward scan over the remaining tags: structure becomes line breaks, every other tag
 * disappears. A `<` that never closes swallows the rest, as a browser would. The regex it
 * replaces (`<[^>]+>`) rescanned to the end of input for every unclosed `<`.
 */
function replaceTags(s: string): string {
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    const lt = s.indexOf("<", i);
    if (lt === -1) {
      parts.push(s.slice(i));
      break;
    }
    parts.push(s.slice(i, lt));
    const gt = s.indexOf(">", lt + 1);
    if (gt === -1) break;
    parts.push(tagBreak(s.slice(lt + 1, gt)));
    i = gt + 1;
  }
  return parts.join("");
}

function tagBreak(inner: string): string {
  const m = /^(\/?)([a-z][a-z0-9]*)/i.exec(inner);
  if (!m) return "";
  const closing = m[1] === "/";
  const name = m[2].toLowerCase();
  if (!closing && name === "br") return "\n";
  if (!closing && name === "li") return "\n- ";
  if (closing && PARAGRAPH_END.has(name)) return "\n\n";
  if (closing && LINE_END.has(name)) return "\n";
  return "";
}

function stripComments(html: string): string {
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    const start = html.indexOf("<!--", i);
    if (start === -1) {
      parts.push(html.slice(i));
      break;
    }
    parts.push(html.slice(i, start));
    const end = html.indexOf("-->", start + 4);
    if (end === -1) break;
    i = end + 3;
  }
  return parts.join("");
}

/** `<a href="x">label</a>` becomes `label (x)`; an anchor with no closing tag is left for the generic tag strip. */
function linkifyAnchors(s: string): string {
  const lower = s.toLowerCase();
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    const open = nextOpener(lower, i, ["a"]);
    const tagEnd = open ? s.indexOf(">", open.index) : -1;
    const close = tagEnd === -1 ? -1 : lower.indexOf("</a", tagEnd);
    const closeEnd = close === -1 ? -1 : lower.indexOf(">", close);
    if (!open || tagEnd === -1 || close === -1 || closeEnd === -1) {
      parts.push(s.slice(i));
      break;
    }
    parts.push(s.slice(i, open.index));
    const href = /href=["']([^"']+)["']/i.exec(s.slice(open.index, tagEnd))?.[1];
    const label = replaceTags(s.slice(tagEnd + 1, close)).trim();
    if (href) parts.push(label && label !== href ? `${label} (${href})` : href);
    else parts.push(s.slice(open.index, closeEnd + 1));
    i = closeEnd + 1;
  }
  return parts.join("");
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1].toLowerCase() === "x"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

export function truncateText(
  text: string,
  limit = BODY_LIMIT,
): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return {
    text: `${text.slice(0, limit)}\n[... truncated at ${limit} characters]`,
    truncated: true,
  };
}

export function formatAddress(a: MessageAddressObject): string {
  const addr = a.address ?? "";
  // Group syntax ("undisclosed-recipients:;") and malformed entries have a name but no
  // mailbox; nothing can be sent there, so yield nothing rather than "name <>".
  if (!addr) return "";
  return a.name && a.name !== addr ? `${a.name} <${addr}>` : addr;
}

export function formatAddresses(
  list: MessageAddressObject[] | undefined,
): string[] {
  return (list ?? []).map(formatAddress).filter(Boolean);
}

/** Parse a raw RFC 5322 header block (as returned by imapflow `headers`) into lowercase name -> value. */
export function parseHeaderBlock(
  raw: Uint8Array | string | undefined,
): Record<string, string> {
  if (!raw) return {};
  const text =
    typeof raw === "string" ? raw : new TextDecoder("utf-8").decode(raw);
  const unfolded = text.replace(/\r?\n[ \t]+/g, " ");
  const out: Record<string, string> = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    out[name] = out[name] ? `${out[name]} ${value}` : value;
  }
  return out;
}

/** Split a References / In-Reply-To header into message ids, angle brackets kept. */
export function splitMessageIds(value: string | undefined): string[] {
  if (!value) return [];
  return value.match(/<[^>]+>/g) ?? [];
}

/**
 * In-Reply-To and References for a reply to `original`, from its ENVELOPE and raw headers.
 * RFC 5322 section 3.6.4: the parent's References, or its In-Reply-To when it has none,
 * followed by the parent's own id. Shared by reply_message and reply drafts.
 */
export function replyThreading(original: {
  envelope?: { messageId?: string };
  headers?: Uint8Array | string;
}): { inReplyTo?: string; references?: string[] } {
  const headers = parseHeaderBlock(original.headers);
  const parentId = original.envelope?.messageId ?? headers["message-id"];
  if (!parentId) return {};
  const chain = splitMessageIds(headers.references);
  const parents = chain.length ? chain : splitMessageIds(headers["in-reply-to"]);
  return { inReplyTo: parentId, references: [...parents, parentId] };
}

export function toIsoDate(d: Date | string | undefined): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
