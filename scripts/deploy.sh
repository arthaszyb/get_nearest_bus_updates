#!/usr/bin/env bash
# Tests, applies pending D1 migrations, then deploys the Worker.
#
# Needs CLOUDFLARE_API_TOKEN (permissions: Workers Scripts Edit, D1 Edit, Workers KV Storage Edit)
# and CLOUDFLARE_ACCOUNT_ID in the environment, and wrangler.toml filled in: `name` matching your
# existing Worker, plus the KV and D1 bindings. A binding missing from wrangler.toml is removed
# from the Worker on deploy; secrets are kept, and so are dashboard variables (keep_vars).
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
db=$(sed -n 's/^database_name *= *"\(.*\)"/\1/p' wrangler.toml)
[ -n "$db" ] || { echo "Uncomment and fill in [[d1_databases]] in wrangler.toml first" >&2; exit 1; }

node --no-warnings --test
npx --yes wrangler@4 d1 migrations apply "$db" --remote
npx --yes wrangler@4 deploy
