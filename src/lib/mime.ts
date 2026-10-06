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
  let s = html.replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // Source whitespace (newlines, indentation) is not layout in HTML; flatten it first so
  // the only line breaks in the output are the ones we add from structure.
  s = s.replace(/\s+/g, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  // Paragraph-level blocks end with a blank line, line-level blocks with a single break.
  s = s.replace(/<\/(p|h[1-6]|ul|ol|blockquote|pre|table)\s*>/gi, "\n\n");
  s = s.replace(/<\/(div|tr|section|article|header|footer|dd|dt)\s*>/gi, "\n");
  s = s.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, text: string) => {
      const label = text.replace(/<[^>]+>/g, "").trim();
      return label && label !== href ? `${label} (${href})` : href;
    },
  );
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/\r/g, "");
  s = s.replace(/[ \t ]+\n/g, "\n").replace(/\n[ \t ]+/g, "\n");
  s = s.replace(/[ \t ]{2,}/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
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

export function toIsoDate(d: Date | string | undefined): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
