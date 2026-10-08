-- One-off purchases that extended an existing pass instead of issuing a new token
-- (a Payment Link opened with ?client_reference_id=<token id>). The primary key makes each
-- Checkout session count once however often Stripe retries the webhook.
CREATE TABLE IF NOT EXISTS topups (
  stripe_checkout_session TEXT PRIMARY KEY,  -- cs_...
  token_id TEXT NOT NULL,                    -- tk_..., the pass that was extended
  created_at INTEGER NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0         -- 1 once the pass's expiry has been extended
);
