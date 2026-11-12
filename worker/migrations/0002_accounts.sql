CREATE TABLE accounts (
  id                     INTEGER PRIMARY KEY,
  email                  TEXT UNIQUE COLLATE NOCASE,   -- NULL only for legacy account 1 before upgrade
  kdf_salt               TEXT,
  kdf_iters              INTEGER,
  auth_mac               TEXT,
  rec_auth_mac           TEXT,
  wrapped_dek_pw_sealed  TEXT,
  wrapped_dek_rec_sealed TEXT,
  dek_check              TEXT,
  invite_hash            TEXT UNIQUE,                  -- NULL for legacy account 1
  recovery_confirmed_at  TEXT,
  created_at             TEXT NOT NULL,
  disabled_at            TEXT,
  failed_logins          INTEGER NOT NULL DEFAULT 0,
  locked_until           TEXT
);
INSERT INTO accounts (id, created_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- devices: rebuilt (ADD COLUMN … NOT NULL REFERENCES is illegal with FKs on).
CREATE TABLE devices_v2 (
  token_hash   TEXT PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT
);
INSERT INTO devices_v2 (token_hash, account_id, name, created_at, last_seen_at)
  SELECT token_hash, 1, name, created_at, last_seen_at FROM devices;
DROP TABLE devices;
ALTER TABLE devices_v2 RENAME TO devices;

-- data: rebuilt to drop CHECK (id = 1). The key column KEEPS the name `id`
-- (= account id) so the deployed Worker's `WHERE id = 1` keeps working for
-- Alex until the new Worker ships.
CREATE TABLE data_v2 (
  id         INTEGER PRIMARY KEY REFERENCES accounts(id),
  version    INTEGER NOT NULL,
  blob       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO data_v2 (id, version, blob, updated_at) SELECT id, version, blob, updated_at FROM data;
DROP TABLE data;
ALTER TABLE data_v2 RENAME TO data;

CREATE TABLE invites (hash TEXT PRIMARY KEY, note TEXT, created_at TEXT NOT NULL, used_at TEXT, revoked_at TEXT);
CREATE TABLE usage (
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  day TEXT NOT NULL, calls INTEGER NOT NULL, in_tok INTEGER NOT NULL DEFAULT 0, out_tok INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day)
);
CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- 'key-check' written on first use
