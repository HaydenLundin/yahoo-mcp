-- ARCHITECTURE.md section 7. Two tables: pending two-phase sends and the write audit log.
CREATE TABLE IF NOT EXISTS pending_sends (
  token       TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('send','reply','forward')),
  preview     TEXT NOT NULL,          -- JSON shown to the user
  mime        BLOB NOT NULL,          -- fully rendered message, sent verbatim on confirm
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_sends_expires_at ON pending_sends (expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  client_id   TEXT NOT NULL,
  client_name TEXT,
  tool        TEXT NOT NULL,
  args_digest TEXT NOT NULL,          -- sha256 of canonical args (no bodies); "" for read tools
  uids        TEXT,                   -- JSON array when applicable
  outcome     TEXT NOT NULL CHECK (outcome IN ('ok','error','denied'))
);
CREATE INDEX IF NOT EXISTS audit_log_ts ON audit_log (ts);
