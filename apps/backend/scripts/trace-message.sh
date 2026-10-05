#!/usr/bin/env bash
#
# Follow one message through the moderation pipeline.
#
# Every stage line carries the same `trace` id, so this prints the whole life
# of a message — captured, claimed, model call, parse, verdict — with timings.
#
#   scripts/trace-message.sh                      # most recent activity
#   scripts/trace-message.sh <message-id>          # one message, all stages
#   scripts/trace-message.sh <message-id> --wide   # + raw model request/response
#
# SINCE=  changes the journal window (default -30min).
# UNIT=  overrides the worker unit name.
set -uo pipefail

TAIL_LINES=400
WIDE=0
SINCE="${SINCE:--30min}"
UNIT="${UNIT:-gmw-backend}"
# The capture and the worker are both inside gmw-backend now, so the old
# two-unit split has collapsed to one journal to read.
GATEWAY_UNIT="${GATEWAY_UNIT:-gmw-backend}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORMATTER="$SCRIPT_DIR/format-trace.py"

if [[ "${1:-}" == "--wide" ]]; then
  WIDE=1
  shift
fi

journal() {
  # -o cat is REQUIRED: without it journalctl prefixes every line with
  # "Sep 27 17:38:41 host systemd[1]:" so the JSON no longer starts with "{"
  # and the formatter silently drops every line.
  sudo -n journalctl -u "$UNIT" -u "$GATEWAY_UNIT" --since "$SINCE" --no-pager -o cat 2>/dev/null
}

if [[ -z "${1:-}" ]]; then
  echo "=== most recent pipeline activity (last $TAIL_LINES lines) ==="
  journal | tail -n "$TAIL_LINES" | python3 "$FORMATTER"
  exit 0
fi

TRACE_ID="$1"
# Discord snowflakes are long; the trace id is the last 12 characters.
SHORT="${TRACE_ID: -12}"
[[ ${#TRACE_ID} -le 12 ]] && SHORT="$TRACE_ID"

echo "=== trace for message $TRACE_ID (trace=$SHORT) ==="
if [[ $WIDE -eq 1 ]]; then
  journal | grep -- "$SHORT" | python3 "$FORMATTER"
else
  journal | grep -- "$SHORT" | grep -v '"stage":"llm-raw"' | python3 "$FORMATTER"
  echo
  echo "(re-run with --wide to include the raw model request/response)"
fi

echo
echo "=== database state ==="
DSN=$(sudo -n /usr/local/bin/bws-exec gmw env 2>/dev/null | grep '^DATABASE_URL=' | head -1 | cut -d= -f2-)
if [[ -z "$DSN" ]]; then
  echo "  (could not read DATABASE_URL from the secret store)"
  exit 0
fi

SERVICE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SERVICE_DIR" || exit 0
DSN="$DSN" MESSAGE_ID="$TRACE_ID" node -e '
const pg = require("pg");
(async () => {
  const p = new pg.Pool({ connectionString: process.env.DSN, max: 1 });
  const id = process.env.MESSAGE_ID;
  const m = await p.query(
    "SELECT id, ai_status, attempts, worker_id, lease_until, ready_for_work_at, deleted_at FROM messages WHERE id = $1",
    [id],
  );
  console.log("  message :", JSON.stringify(m.rows[0] ?? null));
  const v = await p.query(
    "SELECT status, severity, score, recommended_action, model, updated_at FROM verdicts WHERE message_id = $1",
    [id],
  );
  console.log("  verdict :", JSON.stringify(v.rows[0] ?? null));
  const a = await p.query(
    "SELECT attempt, outcome, error_code, error_message FROM analysis_attempts WHERE message_id = $1 ORDER BY id",
    [id],
  );
  for (const r of a.rows) console.log("  attempt :", JSON.stringify(r));
  await p.end();
})().catch((e) => console.error("  ERR", e.message));
'
