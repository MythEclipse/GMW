#!/usr/bin/env bash
#
# reset-data.sh — wipe GMW's runtime data on the VPS, for a clean post-deploy state.
#
# SCOPE, precisely:
#   * Postgres `dcbot`   — the ENTIRE `public` schema, dropped and rebuilt.
#                          The migration history is a single baseline, so an
#                          empty database is the only supported starting point:
#                          the backend applies the whole schema on next boot.
#
# BLAST RADIUS — read before running:
#   The Postgres server is SHARED. This script drops no database, so these
#   siblings are untouched:
#       airouter, boost, gitea, hermes, hindsight_db, hub, lidm, mcpedia,
#       prisma_migrate_shadow_db_*, test, uploader
#   Verified against prod: only `dcbot` is connected to.
#
# USAGE:
#   reset-data.sh --dry-run    list exactly what would be wiped, change nothing
#   reset-data.sh              perform the wipe
#
# Env (supplied by the gateway's env file on the VPS):
#   DATABASE_URL
set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

: "${DATABASE_URL:?DATABASE_URL is required}"

if [ "$DRY_RUN" = 1 ]; then
  echo "=== GMW data reset (DRY RUN — nothing will be deleted) ==="
else
  echo "=== GMW data reset (LIVE) ==="
fi
echo "database : $(printf '%s' "$DATABASE_URL" | sed -E 's#://[^@]*@#://***@#')"

# ── 0. Stop the writers ────────────────────────────────────────────────────
# A verified requirement, not a precaution: with the gateway left running, a
# truncate is undone before the next statement. Measured on prod — wiping
# 916 messages / 895 verdicts and re-reading seconds later showed 8 messages
# and 4 verdicts already back, because the gateway re-captures live traffic
# immediately. The old build also holds its own DB pool and would keep
# inserting into tables this script is emptying.
#
# Units are matched BY NAME, never by binary path: two unrelated services on
# this host also run `bun run dist/index.js`.
#
# On success the units are deliberately LEFT DOWN — the deploy step restarts
# them right after this runs, and a reset that ends with the writers back up
# has restored what was just removed. If this script exits non-zero the trap
# below brings them back, so a failed reset can never leave prod dark.
WRITERS=(gmw-backend)
STOPPED=()

restore_writers() {
  # No-op on the success path: WIPE_OK=1 is set before the final exit, so the
  # units are meant to stay down for the deploy step's restart. Only a real
  # failure (WIPE_OK still 0) brings them back, so a failed reset can never
  # leave prod dark.
  [ "$WIPE_OK" = "1" ] && return 0
  [ ${#STOPPED[@]} -eq 0 ] && return 0
  echo "--- restoring writers after a FAILED reset ---"
  for u in "${STOPPED[@]}"; do
    systemctl start "$u" 2>/dev/null && echo "  started $u"
  done
}

# Set to 1 only on the success path (final line of the script).
WIPE_OK=0

if [ "$DRY_RUN" = 0 ]; then
  for u in "${WRITERS[@]}"; do
    if systemctl cat "$u" >/dev/null 2>&1; then
      systemctl stop "$u" && STOPPED+=("$u")
    else
      echo "note: $u not present on this host; skipping"
    fi
  done
  if [ ${#STOPPED[@]} -gt 0 ]; then
    echo "--- stopped writers: ${STOPPED[*]} ---"
    # Confirm they are actually down. A unit that reports "stopping" is still
    # holding a DB pool, and the wipe would race it.
    #
    # `is-active` prints "inactive" with a trailing NEWLINE for a stopped unit,
    # so the value is trimmed before comparing — the untrimmed string never
    # matches and every unit falsely reads as "not stopped".
    #
    # `failed` IS accepted: observed on prod for gmw-backend, which lands in
    # `failed` rather than `inactive` when stopped (stop-timeout kills it after
    # its shutdown hook overruns). A failed unit has already torn down its
    # process, so it holds no DB pool and cannot race the wipe. The service is
    # started again by the deploy step regardless.
    for u in "${STOPPED[@]}"; do
      state=$(systemctl is-active "$u" 2>/dev/null | tr -d '[:space:]' || true)
      [ -n "$state" ] || state="inactive"
      case "$state" in
        inactive|failed) ;;
        *) echo "FATAL: $u is '$state', not stopped" >&2; restore_writers; exit 1 ;;
      esac
    done
    trap restore_writers EXIT
  fi
fi

# ── 1. Postgres ────────────────────────────────────────────────────────────
# Discover the table list from the catalog rather than hardcoding it. The
# checked-in scripts/truncate-all.sql is stale: it names `user_reputations` and
# `mascot_chat_messages`, which no longer exist (so it errors on a fresh deploy),
# and it omits the seven tables that actually hold rows — including `verdicts`
# and `analysis_attempts`. A hardcoded list is how that drift stayed invisible.
#
# Everything in `public` goes, __drizzle_migrations included — it is part of the
# schema, not data, and keeping it would make Drizzle skip the rebuild.
TABLES=$(psql "$DATABASE_URL" -tA -c "
  SELECT tablename FROM pg_tables
  WHERE schemaname='public'
  ORDER BY tablename;")

if [ -z "$TABLES" ]; then
  echo "FATAL: found no tables in public schema — refusing to continue." >&2
  exit 1
fi

echo
echo "--- tables to drop ---"
# n_live_tup is an estimate; good enough to show the operator what they are
# about to lose, and it costs nothing.
psql "$DATABASE_URL" -tA -F'|' -c "
  SELECT c.relname, COALESCE(s.n_live_tup,0)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
  LEFT JOIN pg_stat_user_tables s ON s.relid=c.oid
  WHERE c.relkind='r'
  ORDER BY c.relname;" | while IFS='|' read -r t n; do
  printf '  %-26s ~%s rows\n' "$t" "$n"
done

if [ "$DRY_RUN" = 1 ]; then
  echo
  echo "DRY RUN — nothing was deleted."
  exit 0
fi

# DROP the schema, not TRUNCATE the rows.
#
# The migration history was squashed to a single baseline, which is a BREAKING
# change: applying it to a database that already has the old tables fails with
# "relation already exists". There is no incremental path from the old chain to
# the baseline, by design — so a reset has to rebuild the schema rather than
# empty it and hope.
#
# DROP ... CASCADE removes the tables AND the __drizzle_migrations ledger in one
# step, so the next boot sees an empty database and applies the baseline whole.
# This is also why the ledger-exclusion and ledger-preservation assertions below
# no longer exist: there is no ledger left to protect. The writers are stopped
# above, so nothing can be mid-transaction against these tables.
echo
echo "--- dropping and rebuilding the Postgres schema ---"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "DROP SCHEMA public CASCADE;"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "CREATE SCHEMA public;"
echo "Postgres schema dropped (the backend rebuilds it from the baseline on next boot)"

# ── 2. Verify ──────────────────────────────────────────────────────────────
# Counts must actually be zero, not merely "the command exited 0". A wipe that
# silently failed is worse than one that was never attempted: the ledger is
# intact and the next deploy would re-migrate against stale data.
echo
echo "--- verification ---"
FAIL=0
# Exact counts, NEVER pg_stat_user_tables.n_live_tup. That column is a
# running estimate maintained by the collector and is only refreshed on
# ANALYZE/VACUUM: after a wipe it kept reporting 93 rows across the database
# while exact count(*) showed 1 (a message the restarted gateway had already
# re-captured). Asserting emptiness on an estimate fails a correct wipe, which
# in CI means a red deploy for a reset that actually worked.
#
# The schema is DROPPED rather than emptied, so the pass condition is strict and
# simple: zero tables remain in `public`. There is no "rows re-captured by the
# restarted gateway are expected" leniency any more — that clause belonged to the
# TRUNCATE era, when leaving the tables in place meant a re-captured row was
# harmless. With the schema gone, any survivor means the DROP did not work.
echo "  postgres rows remaining:"
# NB: pg_tables.tablename (not pg_class.relname) — the catalog view used here
# names the column `tablename`. Getting this wrong aborts the verification under
# `set -e` and reports a correct wipe as a failed one.
# Counts every remaining table. After a schema DROP there should be NONE, so an
# empty result is the PASS condition and any survivor is a real failure.
NONEMPTY=$(psql "$DATABASE_URL" -tA -F'|' -c "
  SELECT tablename, (xpath('/row/c/text()', query_to_xml(
    format('SELECT count(*) AS c FROM %I', tablename), false, true, '')))[1]::text::int
  FROM pg_tables
  WHERE schemaname='public'
  ORDER BY tablename;" | awk -F'|' '$2+0 > 0')

SURVIVING_TABLES=$(psql "$DATABASE_URL" -tA -c "
  SELECT count(*) FROM pg_tables WHERE schemaname='public';" 2>/dev/null || echo "err")

if [ "$SURVIVING_TABLES" = "0" ]; then
  echo "    (public schema is empty — rebuilt from the baseline on next boot)"
else
  echo "    x $SURVIVING_TABLES table(s) survived the DROP SCHEMA"
  [ -n "$NONEMPTY" ] && echo "$NONEMPTY" | while IFS='|' read -r t c; do printf '      %-26s %s\n' "$t" "$c"; done
  FAIL=1
fi

# The ledger must be GONE, not preserved: the whole schema was dropped so the
# next boot applies the baseline from scratch. If it survived, Drizzle would see
# the baseline as already applied and boot against an empty database.
NOW_LEDGER=$(psql "$DATABASE_URL" -tA -c "
  SELECT count(*) FROM information_schema.tables
   WHERE table_schema='public' AND table_name='__drizzle_migrations';" 2>/dev/null || echo "err")
echo "  migration ledger cleared      : $NOW_LEDGER rows of schema remain"
[ "$NOW_LEDGER" = "0" ] || { echo "  x SCHEMA NOT FULLY DROPPED" >&2; FAIL=1; }

if [ "$FAIL" = 0 ]; then
  WIPE_OK=1
  echo "=== reset complete (writers left down for the deploy restart) ==="
else
  echo "=== reset FAILED (writers restored) ===" >&2
fi

# The reset succeeding says nothing about prod being up. The caller's next
# step is the restart, so the one thing worth reporting from here is that the
# writers ARE down — if any is still active, the wipe raced it and its result
# is not to be trusted.
if [ "$DRY_RUN" = 0 ]; then
  echo "--- writers (must be down; the deploy step restarts them) ---"
  for u in "${WRITERS[@]}"; do
    state=$(systemctl is-active "$u" 2>/dev/null | tr -d '[:space:]' || true)
    [ -n "$state" ] || state="unknown"
    echo "  $u -> $state"
  done
fi
exit "$FAIL"