-- Links tokens to the Stripe purchases that created them (see README > Selling with Stripe).
ALTER TABLE tokens ADD COLUMN stripe_checkout_session TEXT;  -- cs_..., one token per Checkout session
ALTER TABLE tokens ADD COLUMN stripe_subscription TEXT;      -- sub_..., set for subscription purchases

CREATE UNIQUE INDEX IF NOT EXISTS tokens_stripe_checkout_session ON tokens (stripe_checkout_session);
CREATE INDEX IF NOT EXISTS tokens_stripe_subscription ON tokens (stripe_subscription);
