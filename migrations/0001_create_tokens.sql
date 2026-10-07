-- Customer access tokens. Apply with:
--   wrangler d1 migrations apply sg-bus-nearest --remote
-- or paste this file into the D1 database's Console tab in the Cloudflare dashboard.
CREATE TABLE IF NOT EXISTS tokens (
  id            TEXT PRIMARY KEY,                -- short public id (tk_...), safe to use in support and logs
  token_hash    TEXT NOT NULL UNIQUE,            -- SHA-256 of the token; the token itself is never stored
  plan          TEXT NOT NULL,                   -- trial | monthly | yearly | lifetime
  status        TEXT NOT NULL DEFAULT 'active',  -- active | revoked
  created_at    INTEGER NOT NULL,                -- all times are Unix epoch milliseconds
  first_used_at INTEGER,
  expires_at    INTEGER,                         -- NULL = never expires, or not started yet (see pending_days)
  pending_days  INTEGER,                         -- validity that starts counting on first use, then moves into expires_at
  daily_limit   INTEGER,                         -- max requests per Singapore calendar day; NULL = unlimited
  usage_day     TEXT,                            -- day usage_count belongs to (YYYY-MM-DD, Singapore time)
  usage_count   INTEGER NOT NULL DEFAULT 0,
  total_count   INTEGER NOT NULL DEFAULT 0,      -- every request made with the token, rejected ones included
  last_used_at  INTEGER,
  customer      TEXT,                            -- email or payment-provider customer id, for support and renewals
  note          TEXT
);

CREATE INDEX IF NOT EXISTS tokens_customer ON tokens (customer);
