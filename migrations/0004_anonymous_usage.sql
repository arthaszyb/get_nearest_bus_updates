-- Daily usage of the built-in free tier: requests without a token, counted per device.
CREATE TABLE IF NOT EXISTS anonymous_usage (
  device_key    TEXT PRIMARY KEY,   -- salted one-way hash of the device details the Shortcut sends; never the details
  usage_day     TEXT NOT NULL,      -- day usage_count belongs to (YYYY-MM-DD, Singapore time)
  usage_count   INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,   -- Unix epoch milliseconds
  last_used_at  INTEGER NOT NULL
);
