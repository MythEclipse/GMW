#!/usr/bin/env bash
#
# Migration drift gate (skill §5).
#
# WHAT IT ENFORCES
#   A PR must not change `src/shared/database/schema.ts` without also changing
#   `drizzle/migrations/`. That is the whole rule: schema and migrations move
#   together, or CI fails.
#
# WHY IT IS A SHELL SCRIPT AND NOT `drizzle-kit generate` + `git diff --exit-code`
#   The obvious implementation is broken in this repo, and the reason is worth
#   recording because it will bite the next person who tries it.
#
#   `drizzle-kit generate` diffs `schema.ts` against the newest migration's
#   *snapshot* (`meta/NNNN_snapshot.json`) — it does not read the .sql files.
#   This repo's `meta/` contains only `_journal.json`; there is no
#   `0000_snapshot.json`. The baseline migration was produced by applying the
#   old 28-file chain to an empty database and capturing it with
#   `pg_dump --schema-only`, so no drizzle snapshot was ever produced for it.
#
#   With no snapshot to diff against, drizzle concludes the schema is entirely
#   new and emits a migration that re-CREATEs all 20 tables. That is not drift,
#   it is a destructive artifact. Verified: on 2026-10-05 `drizzle-kit generate`
#   produced `0001_heavy_molly_hayes.sql`, 325 lines of `CREATE TABLE` for every
#   table in the schema, plus every index and the attachments foreign key.
#
#   The snapshot cannot simply be synthesised. `schema.ts` declares 0 `check()`
#   constraints and 0 SQL functions; the deployed baseline carries 6 CHECK
#   constraints and 2 functions. A snapshot generated from `schema.ts` today
#   would record the invariants as absent, and the next real `generate` would
#   then emit DROP statements for them. Making that safe means first porting the
#   6 CHECKs and 2 functions into `schema.ts` — tracked separately, and gated
#   here rather than papered over.
#
# EXIT CODES
#   0  no drift
#   1  drift: schema changed without a matching migration
#   2  cannot evaluate (missing baseline snapshot) — fails loudly by design

set -euo pipefail

cd "$(dirname "$0")/.."

SCHEMA="src/shared/database/schema.ts"
MIGRATIONS="drizzle/migrations"
BASELINE_SNAPSHOT="$MIGRATIONS/meta/0000_snapshot.json"

fail() {
	echo "" >&2
	echo "✗ $1" >&2
	echo "" >&2
}

# ── Guard 1: the baseline snapshot must exist before we can reason about drift ──
if [ ! -f "$BASELINE_SNAPSHOT" ]; then
	fail "migration drift gate cannot run: $BASELINE_SNAPSHOT is missing.

The baseline migration was captured with pg_dump, so drizzle-kit has no
snapshot to diff schema.ts against. Until one exists, drizzle-kit generate
emits a migration that re-CREATEs all 20 tables.

To fix properly: port the 6 CHECK constraints and 2 SQL functions that
0000_baseline.sql carries but schema.ts does not declare, then regenerate
the snapshot.

See apps/backend/scripts/check-migration-drift.sh for the full rationale."
	exit 2
fi

# ── Guard 2: schema and migrations must move together ──
#
# Compared against the merge base rather than the working tree so that this
# works the same locally (dirty tree, staged edits) and in CI (clean checkout,
# feature branch merged).
if git rev-parse --verify HEAD >/dev/null 2>&1 && \
	git rev-parse --verify "$(git merge-base HEAD origin/main 2>/dev/null || echo HEAD)" >/dev/null 2>&1; then
	BASE="$(git merge-base HEAD origin/main 2>/dev/null || echo HEAD)"
else
	BASE="HEAD"
fi

SCHEMA_CHANGED=false
MIGRATIONS_CHANGED=false

if ! git diff --quiet "$BASE" -- "$SCHEMA" 2>/dev/null; then
	SCHEMA_CHANGED=true
fi
if ! git diff --quiet "$BASE" -- "$MIGRATIONS" 2>/dev/null; then
	MIGRATIONS_CHANGED=true
fi

if [ "$SCHEMA_CHANGED" = true ] && [ "$MIGRATIONS_CHANGED" = false ]; then
	fail "migration drift: $SCHEMA changed but $MIGRATIONS did not.

Run 'pnpm db:generate' and commit the generated SQL."
	exit 1
fi

echo "✓ no migration drift (schema changed: $SCHEMA_CHANGED, migrations changed: $MIGRATIONS_CHANGED)"