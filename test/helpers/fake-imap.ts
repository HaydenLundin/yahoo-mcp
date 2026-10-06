import type {
  FetchMessageObject,
  FetchQueryObject,
  ListResponse,
  MessageEnvelopeObject,
  MessageStructureObject,
  SearchObject,
} from "imapflow";

/**
 * In-memory stand-in for imapflow's ImapFlow. Supports exactly the subset the tools use:
 * on, list, getMailboxLock, mailbox, search (including seq windows), fetchAll, fetchOne
 * (including ranged bodyParts), logout, close. Fixtures are static so `vi.mock("imapflow")`
 * can swap the class in.
 */
export interface FakeMessage {
  uid: number;
  flags?: string[];
  size?: number;
  threadId?: string;
  envelope: MessageEnvelopeObject;
  structure: MessageStructureObject;
  /** Raw header block returned for `headers:` fetches. */
  headers?: string;
  /**
   * Raw part bytes by part id ("1", "1.2", ...) exactly as the server would send them, i.e.
   * still transfer-encoded and in the part's charset. Strings are stored as UTF-8 bytes.
   */
  parts?: Record<string, string | Uint8Array>;
  internalDate?: Date;
}

export interface FakeFolder {
  path: string;
  specialUse?: string;
  delimiter?: string;
  listed?: boolean;
  messages: FakeMessage[];
}

interface BodyPartQuery {
  key: string;
  start?: number;
  maxLength?: number;
}

export class FakeImapFlow {
  static folders: FakeFolder[] = [];
  static calls: string[] = [];
  static failConnect: unknown = null;
  static rejectThreadIdSearch = false;

  static reset(folders: FakeFolder[]): void {
    FakeImapFlow.folders = folders;
    FakeImapFlow.calls = [];
    FakeImapFlow.failConnect = null;
    FakeImapFlow.rejectThreadIdSearch = false;
  }

  readonly options: unknown;
  readonly listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  /** Mirrors imapflow: the selected mailbox object, or false before SELECT. */
  mailbox: { path: string; exists: number; uidNext: number } | false = false;
  private selected: FakeFolder | null = null;

  constructor(options: unknown) {
    this.options = options;
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    (this.listeners[event] ??= []).push(handler);
    return this;
  }

  async connect(): Promise<void> {
    FakeImapFlow.calls.push("connect");
    if (FakeImapFlow.failConnect) throw FakeImapFlow.failConnect;
  }

  async logout(): Promise<void> {
    FakeImapFlow.calls.push("logout");
  }

  close(): void {
    FakeImapFlow.calls.push("close");
  }

  async list(): Promise<ListResponse[]> {
    FakeImapFlow.calls.push("list");
    return FakeImapFlow.folders.map((f) => ({
      path: f.path,
      pathAsListed: f.path,
      name: f.path.split(f.delimiter ?? "/").pop() ?? f.path,
      delimiter: f.delimiter ?? "/",
      parent: [],
      parentPath: "",
      flags: new Set<string>(),
      specialUse: f.specialUse,
      listed: f.listed ?? true,
      subscribed: true,
    }));
  }

  async getMailboxLock(
    path: string,
  ): Promise<{ path: string; release: () => void }> {
    FakeImapFlow.calls.push(`lock:${path}`);
    const folder = FakeImapFlow.folders.find((f) => f.path === path);
    if (!folder) {
      throw Object.assign(new Error("Command failed"), {
        serverResponseCode: "NONEXISTENT",
        responseText: `Mailbox doesn't exist: ${path}`,
      });
    }
    this.selected = folder;
    const uids = folder.messages.map((m) => m.uid);
    this.mailbox = {
      path,
      exists: folder.messages.length,
      uidNext: (uids.length ? Math.max(...uids) : 0) + 1,
    };
    return { path, release: () => FakeImapFlow.calls.push(`release:${path}`) };
  }

  /** Messages in sequence order (ascending uid), with their 1-based sequence numbers. */
  private sequenced(): Array<{ seq: number; m: FakeMessage }> {
    return (this.selected?.messages ?? [])
      .slice()
      .sort((a, b) => a.uid - b.uid)
      .map((m, i) => ({ seq: i + 1, m }));
  }

  async search(query: SearchObject): Promise<number[] | false> {
    FakeImapFlow.calls.push(`search:${JSON.stringify(query)}`);
    if (query.threadId !== undefined && FakeImapFlow.rejectThreadIdSearch)
      throw new Error("BAD search");
    return this.sequenced()
      .filter(({ seq, m }) => inSeqRange(seq, query.seq) && matches(m, query))
      .map(({ m }) => m.uid)
      .sort((a, b) => a - b);
  }

  async fetchAll(
    range: number[] | string,
    query: FetchQueryObject,
  ): Promise<FetchMessageObject[]> {
    FakeImapFlow.calls.push(
      `fetchAll:${Array.isArray(range) ? range.length : range}`,
    );
    const wanted = new Set(
      Array.isArray(range) ? range : String(range).split(",").map(Number),
    );
    return (this.selected?.messages ?? [])
      .filter((m) => wanted.has(m.uid))
      .sort((a, b) => a.uid - b.uid)
      .map((m) => this.project(m, query));
  }

  async fetchOne(
    seq: string | number,
    query: FetchQueryObject,
  ): Promise<FetchMessageObject | false> {
    FakeImapFlow.calls.push(`fetchOne:${seq}`);
    const m = (this.selected?.messages ?? []).find(
      (x) => x.uid === Number(seq),
    );
    return m ? this.project(m, query) : false;
  }

  private project(m: FakeMessage, query: FetchQueryObject): FetchMessageObject {
    const out: FetchMessageObject = { seq: m.uid, uid: m.uid };
    if (query.flags) out.flags = new Set(m.flags ?? []);
    if (query.size) out.size = m.size;
    if (query.envelope) out.envelope = m.envelope;
    if (query.bodyStructure) out.bodyStructure = m.structure;
    if (query.threadId) out.threadId = m.threadId;
    if (query.internalDate) out.internalDate = m.internalDate;
    if (query.headers) out.headers = Buffer.from(m.headers ?? "", "utf8");
    if (query.bodyParts) {
      out.bodyParts = new Map();
      for (const q of query.bodyParts as Array<string | BodyPartQuery>) {
        const {
          key,
          start = 0,
          maxLength = Number.POSITIVE_INFINITY,
        } = typeof q === "string" ? { key: q } : q;
        const raw = m.parts?.[key];
        if (raw === undefined) continue;
        const bytes =
          typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
        FakeImapFlow.calls.push(
          `bodyPart:${m.uid}:${key}:${start}:${maxLength}`,
        );
        out.bodyParts.set(
          key,
          bytes.subarray(start, Math.min(bytes.length, start + maxLength)),
        );
      }
    }
    return out;
  }
}

/** IMAP sequence set subset: "lo:hi", "n", or "n:*". */
function inSeqRange(seq: number, range: SearchObject["seq"]): boolean {
  if (range === undefined) return true;
  const text = String(range);
  const [loText, hiText] = text.includes(":") ? text.split(":") : [text, text];
  const lo = Number(loText);
  const hi = hiText === "*" ? Number.POSITIVE_INFINITY : Number(hiText);
  return seq >= lo && seq <= hi;
}

function matches(m: FakeMessage, q: SearchObject): boolean {
  if (q.or) return q.or.some((sub) => matches(m, sub));
  const flags = new Set(m.flags ?? []);
  if (q.seen === false && flags.has("\\Seen")) return false;
  if (q.seen === true && !flags.has("\\Seen")) return false;
  if (q.flagged === true && !flags.has("\\Flagged")) return false;
  if (q.threadId !== undefined && m.threadId !== q.threadId) return false;
  const text = (s: string | undefined) => (s ?? "").toLowerCase();
  if (q.from && !addrText(m.envelope.from).includes(text(q.from))) return false;
  if (q.to && !addrText(m.envelope.to).includes(text(q.to))) return false;
  if (q.subject && !text(m.envelope.subject).includes(text(q.subject)))
    return false;
  if (q.text) {
    const bodies = Object.values(m.parts ?? {})
      .map((p) =>
        typeof p === "string" ? p : Buffer.from(p).toString("latin1"),
      )
      .join(" ");
    const hay = `${text(m.envelope.subject)} ${bodies.toLowerCase()}`;
    if (!hay.includes(text(q.text))) return false;
  }
  const when = m.internalDate ?? new Date(m.envelope.date ?? 0);
  if (q.since && when < new Date(q.since)) return false;
  if (q.before && when >= new Date(q.before)) return false;
  if (q.header) {
    const lines = (m.headers ?? "").toLowerCase().split(/\r?\n/);
    for (const [name, value] of Object.entries(q.header)) {
      if (typeof value !== "string") continue;
      const line =
        lines.find((l) => l.startsWith(`${name.toLowerCase()}:`)) ?? "";
      if (!line.includes(value.toLowerCase())) return false;
    }
  }
  return true;
}

function addrText(list: MessageEnvelopeObject["from"]): string {
  return (list ?? [])
    .map((a) => `${a.name ?? ""} ${a.address ?? ""}`.toLowerCase())
    .join(" ");
}
