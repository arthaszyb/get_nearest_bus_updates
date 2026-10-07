-- Lets free passes be rate-limited per network without storing IP addresses.
ALTER TABLE tokens ADD COLUMN signup_key TEXT;  -- one-way hash of (day, IP); set only on self-serve free passes

CREATE INDEX IF NOT EXISTS tokens_signup_key ON tokens (signup_key);
