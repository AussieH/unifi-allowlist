-- unifi-allowlist :: D1 schema
--
-- Apply with:
--   wrangler d1 execute unifi-allowlist --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS players (
  slug        TEXT PRIMARY KEY,          -- URL-safe short name, e.g. "steve"
  name        TEXT NOT NULL,             -- display name shown on the claim page
  token_hash  TEXT UNIQUE,               -- sha256(secret link token); NULL for Discord-only players
  discord_id  TEXT UNIQUE,               -- Discord user snowflake; NULL for link-only players
  ip4         TEXT,                      -- last verified IPv4 address
  ip4_seen    INTEGER,                   -- unix seconds
  ip6         TEXT,                      -- last verified IPv6 address (only when ALLOW_IPV6)
  ip6_seen    INTEGER,
  note        TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_players_token   ON players (token_hash);
CREATE INDEX IF NOT EXISTS idx_players_discord ON players (discord_id);
CREATE INDEX IF NOT EXISTS idx_players_ip4seen ON players (ip4_seen);

-- Append-only record of every claim, rotation and admin change.
CREATE TABLE IF NOT EXISTS audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  slug    TEXT,
  event   TEXT NOT NULL,   -- claim | claim_rejected | created | rotated | enabled | disabled | deleted
  old_ip  TEXT,
  new_ip  TEXT,
  country TEXT,
  ua      TEXT,
  via     TEXT             -- which auth provider or surface the change came through
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit (ts);
