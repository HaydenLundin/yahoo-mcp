import { Buffer } from "node:buffer";
import { ToolError } from "./errors";

/** Builds RFC 5322 messages for drafts (milestone 4) and, later, for sending (milestone 5). */

export interface Address {
  name?: string;
  address: string;
}

export interface MessageInput {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  /** Message-ID of the message being replied to, angle brackets included. */
  inReplyTo?: string;
  /** Full References chain for a reply, angle brackets included, oldest first. */
  references?: string[];
  date?: Date;
  messageId?: string;
}

const ADDRESS_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/** Accepts "user@example.com" or "Display Name <user@example.com>". */
export function parseAddress(input: string): Address {
  const s = input.trim();
  const m = /^(.*?)\s*<([^<>]+)>$/.exec(s);
  const address = (m ? m[2] : s).trim();
  if (!ADDRESS_RE.test(address)) {
    throw new ToolError(
      "INVALID_ARGUMENT",
      `Not a valid email address: ${input}`,
    );
  }
  const name = m ? m[1].trim().replace(/^"(.*)"$/, "$1") : undefined;
  return name ? { name, address } : { address };
}

export function parseAddresses(list: string[] | undefined): Address[] {
  return (list ?? []).map(parseAddress);
}

/** Render a complete message with CRLF line endings, ready for IMAP APPEND or SMTP. */
export function buildMessage(input: MessageInput): string {
  const from = parseAddress(input.from);
  const to = parseAddresses(input.to);
  if (to.length === 0)
    throw new ToolError(
      "INVALID_ARGUMENT",
      "At least one recipient is required",
    );
  const cc = parseAddresses(input.cc);
  const bcc = parseAddresses(input.bcc);
  const date = input.date ?? new Date();
  const messageId =
    input.messageId ?? `<${crypto.randomUUID()}@${from.address.split("@")[1]}>`;

  const headers: Array<[string, string]> = [
    ["From", formatAddressList([from])],
    ["To", formatAddressList(to)],
  ];
  if (cc.length) headers.push(["Cc", formatAddressList(cc)]);
  if (bcc.length) headers.push(["Bcc", formatAddressList(bcc)]);
  headers.push(["Subject", encodeHeaderText(input.subject)]);
  headers.push(["Date", formatDate(date)]);
  headers.push(["Message-ID", messageId]);
  if (input.inReplyTo) headers.push(["In-Reply-To", input.inReplyTo]);
  if (input.references?.length)
    headers.push(["References", input.references.join(" ")]);
  headers.push(["MIME-Version", "1.0"]);
  headers.push(["X-Mailer", "yahoo-mcp"]);

  const textPart = [
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    qpEncode(input.text),
  ];

  let body: string[];
  if (input.html) {
    const boundary = `=_yahoo-mcp_${crypto.randomUUID().replace(/-/g, "")}`;
    headers.push([
      "Content-Type",
      `multipart/alternative; boundary="${boundary}"`,
    ]);
    body = [
      "This is a multi-part message in MIME format.",
      `--${boundary}`,
      ...textPart,
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      qpEncode(input.html),
      `--${boundary}--`,
    ];
  } else {
    headers.push(["Content-Type", textPart[0].slice("Content-Type: ".length)]);
    headers.push(["Content-Transfer-Encoding", "quoted-printable"]);
    body = [qpEncode(input.text)];
  }

  const head = headers.map(([k, v]) => `${k}: ${v}`).join("\r\n");
  return `${head}\r\n\r\n${body.join("\r\n")}\r\n`;
}

export function formatAddressList(list: Address[]): string {
  return list
    .map((a) => {
      if (!a.name) return a.address;
      const name = /^[\x20-\x7e]*$/.test(a.name)
        ? quoteIfNeeded(a.name)
        : encodeWord(a.name);
      return `${name} <${a.address}>`;
    })
    .join(", ");
}

function quoteIfNeeded(name: string): string {
  return /[()<>[\]:;@\\,."]/.test(name)
    ? `"${name.replace(/(["\\])/g, "\\$1")}"`
    : name;
}

/** Plain ASCII stays as-is; anything else becomes RFC 2047 encoded words. */
export function encodeHeaderText(text: string): string {
  return /^[\x20-\x7e]*$/.test(text) ? text : encodeWord(text);
}

function encodeWord(text: string): string {
  // 45 input bytes -> 60 base64 chars, keeping each encoded word under 76 characters.
  const bytes = Buffer.from(text, "utf8");
  const words: string[] = [];
  for (let i = 0; i < bytes.length; i += 45) {
    words.push(`=?UTF-8?B?${bytes.subarray(i, i + 45).toString("base64")}?=`);
  }
  return words.join(" ");
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function formatDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]}, ${p(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

/**
 * RFC 2045 quoted-printable: UTF-8 bytes, printable ASCII kept, everything else as =XX,
 * soft line breaks so no encoded line exceeds 76 characters, CRLF line endings.
 */
export function qpEncode(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const bytes = Buffer.from(line, "utf8");
    let encoded = "";
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      const last = i === bytes.length - 1;
      const printable =
        (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last);
      encoded += printable
        ? String.fromCharCode(b)
        : `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    while (encoded.length > 76) {
      let cut = 75;
      if (encoded[cut - 1] === "=") cut -= 1;
      else if (encoded[cut - 2] === "=") cut -= 2;
      out.push(`${encoded.slice(0, cut)}=`);
      encoded = encoded.slice(cut);
    }
    out.push(encoded);
  }
  return out.join("\r\n");
}
