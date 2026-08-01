-- Device tokens. The token itself is never stored — only its SHA-256 hex.
CREATE TABLE IF NOT EXISTS devices (
  token_hash   TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT
);

-- Exactly one row, enforced by the CHECK. Holds the opaque encrypted blob and
-- the version used for compare-and-swap. The server never reads inside `blob`.
CREATE TABLE IF NOT EXISTS data (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  version    INTEGER NOT NULL,
  blob       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Seed so GET /data always has a row and the first PUT is version 0 -> 1.
INSERT OR IGNORE INTO data (id, version, blob, updated_at)
VALUES (1, 0, '', '1970-01-01T00:00:00.000Z');
