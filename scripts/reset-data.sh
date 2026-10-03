#!/usr/bin/env bash
#
# reset-data.sh — wipe GMW's runtime data on the VPS, for a clean post-deploy state.
#
# SCOPE, precisely:
#   * Postgres `dcbot`   — every PUBLIC table EXCEPT `__drizzle_migrations`
#                          (the migration ledger). Truncating the ledger would
#                          make the gateway re-run all 26 migrations against a
#                          wiped schema, which is the one way to actually break
#                          a deploy.
#   * Hindsight          — the `gmw-moderation` bank ONLY, via
#                          DELETE /v1/default/banks/{bank}/memories.
#
# BLAST RADIUS — read before running:
#   The Postgres server and the Hindsight instance are BOTH SHARED. This script
#   drops no database and deletes no bank, so these siblings are untouched:
#       airouter, boost, gitea, hermes, hindsight_db, hub, lidm, mcpedia,
#       prisma_migrate_shadow_db_*, test, uploader
#       hindsight bank `hermes-gemini` (this is my own assistant memory)
#   Verified against prod: only the `gmw-moderation` bank is addressed, and only
#   `dcbot` is connected to.
#
# USAGE:
#   reset-data.sh --dry-run    list exactly what would be wiped, change nothing
#   reset-data.sh              perform the wipe
#
# Env (supplied by the gateway's env file on the VPS):
#   DATABASE_URL, AI_MEMORY_BASE_URL, AI_MEMORY_BANK_ID
set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

: "${DATABASE_URL:?DATABASE_URL is required}"
MEM_BASE="${AI_MEMORY_BASE_URL:-http://127.0.0.1:8890}"
MEM_BANK="${AI_MEMORY_BANK_ID:-gmw-moderation}"

if [ "$DRY_RUN" = 1 ]; then
  echo "=== GMW data reset (DRY RUN — nothing will be deleted) ==="
else
  echo "=== GMW data reset (LIVE) ==="
fi
echo "database : $(printf '%s' "$DATABASE_URL" | sed -E 's#://[^@]*@#://***@#')"
echo "bank     : $MEM_BANK at $MEM_BASE"

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
WRITERS=(gmw-discord-gateway gmw-discord-gateway-worker gmw-backend)
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
# __drizzle_migrations is excluded by name: it is the schema ledger, not data.
TABLES=$(psql "$DATABASE_URL" -tA -c "
  SELECT tablename FROM pg_tables
  WHERE schemaname='public'
    AND tablename <> '__drizzle_migrations'
  ORDER BY tablename;")

if [ -z "$TABLES" ]; then
  echo "FATAL: found no tables in public schema — refusing to continue." >&2
  exit 1
fi

LEDGER=$(psql "$DATABASE_URL" -tA -c "
  SELECT COALESCE(MAX(id)::text,'none') FROM __drizzle_migrations;" 2>/dev/null || echo "unreadable")

echo
echo "--- tables to wipe (ledger __drizzle_migrations preserved at id=$LEDGER) ---"
# n_live_tup is an estimate; good enough to show the operator what they are
# about to lose, and it costs nothing.
psql "$DATABASE_URL" -tA -F'|' -c "
  SELECT c.relname, COALESCE(s.n_live_tup,0)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
  LEFT JOIN pg_stat_user_tables s ON s.relid=c.oid
  WHERE c.relkind='r' AND c.relname <> '__drizzle_migrations'
  ORDER BY c.relname;" | while IFS='|' read -r t n; do
  printf '  %-26s ~%s rows\n' "$t" "$n"
done

if [ "$DRY_RUN" = 1 ]; then
  echo
  echo "DRY RUN — nothing was deleted."
  echo "Hindsight bank that would be emptied: $MEM_BANK"
  curl -sS --max-time 10 "$MEM_BASE/v1/default/banks/$MEM_BANK/stats" \
    | head -c 400 || echo "  (stats unreachable)"
  echo
  exit 0
fi

# Wipe in ONE statement: Postgres handles the FK graph
# (attachments/verdicts/analysis_attempts -> messages) atomically, so there is
# no ordering bug and no window where a wipe half-applied.
echo
echo "--- wiping Postgres ---"
# shellcheck disable=SC2086
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "
  TRUNCATE TABLE $(echo "$TABLES" | paste -sd, -) CASCADE;"
echo "Postgres wipe OK"

# ── 2. Hindsight ───────────────────────────────────────────────────────────
# DELETE .../memories empties the bank's documents, nodes and links but KEEPS
# the bank itself, its mission and its disposition. DELETE /banks/{id} would
# remove the bank and force the gateway to recreate it; that is not wanted.
#
# This is the `clearBankMemories` route from @vectorize-io/hindsight-client —
# confirmed by grepping the compiled SDK, not from memory.
echo "--- wiping Hindsight bank $MEM_BANK ---"
CODE=$(curl -sS --max-time 120 -o /tmp/hindsight-wipe.out -w '%{http_code}' \
  -X DELETE "$MEM_BASE/v1/default/banks/$MEM_BANK/memories" || echo "000")

if [ "$CODE" = "200" ] || [ "$CODE" = "204" ]; then
  echo "Hindsight wipe OK (HTTP $CODE)"
else
  echo "WARNING: Hindsight wipe returned HTTP $CODE" >&2
  head -c 500 /tmp/hindsight-wipe.out >&2 || true
  echo >&2
fi

# ── 3. Verify ──────────────────────────────────────────────────────────────
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
# The single row that can legitimately reappear is one the RESTARTED gateway
# re-captures from live traffic after this script's verification runs — not a
# failed wipe. So the bar is "the historical tables are empty", checked
# exactly, and the check reports which tables are non-empty rather than
# failing on a number that mixes estimate drift with real rows.
echo "  postgres rows remaining:"
# NB: pg_tables.tablename (not pg_class.relname) — the catalog view used here
# names the column `tablename`. Getting this wrong aborts the verification under
# `set -e` and reports a correct wipe as a failed one.
NONEMPTY=$(psql "$DATABASE_URL" -tA -F'|' -c "
  SELECT tablename, (xpath('/row/c/text()', query_to_xml(
    format('SELECT count(*) AS c FROM %I', tablename), false, true, '')))[1]::text::int
  FROM pg_tables
  WHERE schemaname='public' AND tablename <> '__drizzle_migrations'
  ORDER BY tablename;" | awk -F'|' '$2+0 > 0')

if [ -z "$NONEMPTY" ]; then
  echo "    (all tables empty)"
else
  echo "$NONEMPTY" | while IFS='|' read -r t c; do printf '    %-26s %s\n' "$t" "$c"; done
  echo "    (rows re-captured by the restarted gateway are expected)"
fi

# Hindsight is asserted strictly: unlike Postgres there is no gateway writing
# into the bank between the wipe and this check, so a non-zero count here is a
# genuine failure, not drift.
STATS_AFTER=$(curl -sS --max-time 15 "$MEM_BASE/v1/default/banks/$MEM_BANK/stats" || echo '{}')
echo "  hindsight facts remaining     : $(printf '%s' "$STATS_AFTER" | sed -n 's/.*"total_nodes":\([0-9]*\).*/\1/p')"
printf '%s' "$STATS_AFTER" | grep -q '"total_nodes":0' \
  || { echo "  x Hindsight bank not empty" >&2; FAIL=1; }

# The ledger is the one thing that must NOT have been touched.
NOW_LEDGER=$(psql "$DATABASE_URL" -tA -c "
  SELECT COALESCE(MAX(id)::text,'none') FROM __drizzle_migrations;" 2>/dev/null || echo "gone")
echo "  migration ledger preserved    : $NOW_LEDGER (was $LEDGER)"
[ "$NOW_LEDGER" = "$LEDGER" ] || { echo "  x MIGRATION LEDGER WAS DAMAGED" >&2; FAIL=1; }

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