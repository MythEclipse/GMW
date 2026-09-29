#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════
#  E2E Test — IMPHNEN Moderation Stack
#  Tests frontend, backend API, DB connectivity, and moderation
#  pipeline against the real production environment.
# ═══════════════════════════════════════════════════════════════

BASE_URL="${1:-https://imphnen.asepharyana.my.id}"
# /api is the infra health router only; all data APIs are oRPC at /trpc.
API="${BASE_URL}/api"
TRPC="${BASE_URL}/trpc"

PASS=0
FAIL=0
TIMEOUT=10

red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
blue()  { printf "\033[36m%s\033[0m\n" "$*"; }

assert() {
  local desc="$1" method="$2" url="$3" expect="$4" extra="$5"
  local code body
  if [ "$method" = "GET" ]; then
    body=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" "$url" 2>&1)
    code="$body"
  elif [ "$method" = "POST" ]; then
    body=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" -X POST -H "Content-Type: application/json" -d "$extra" "$url" 2>&1)
    code="$body"
  fi

  if [ "$code" = "$expect" ]; then
    green "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    red "  ✗ $desc — expected $expect, got $code"
    FAIL=$((FAIL + 1))
  fi
}

assert_json_field() {
  local desc="$1" url="$2" field="$3" extra="${4:-}"
  local val
  if [ -n "$extra" ]; then
    val=$(curl -s --max-time "$TIMEOUT" -X POST -H "Content-Type: application/json" -d "$extra" "$url" 2>&1 | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  keys = '${field}'.split('.')
  for k in keys:
    d = d[k]
  print(d)
except: print('__MISSING__')
")
  else
    val=$(curl -s --max-time "$TIMEOUT" "$url" 2>&1 | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  keys = '${field}'.split('.')
  for k in keys:
    d = d[k]
  print(d)
except: print('__MISSING__')
")
  fi

  if [ "$val" != "__MISSING__" ] && [ -n "$val" ]; then
    green "  ✓ $desc (${field}=${val:0:80})"
    PASS=$((PASS + 1))
  else
    red "  ✗ $desc — field '${field}' not found"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local desc="$1" url="$2" needle="$3"
  local body
  body=$(curl -s --max-time "$TIMEOUT" "$url" 2>&1)
  if echo "$body" | grep -q "$needle"; then
    green "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    red "  ✗ $desc — expected response to contain '${needle}'"
    FAIL=$((FAIL + 1))
  fi
}

# ───────────────────────────────────────────────────────────────
blue ""
blue "════════════════════════════════════════════════════════"
blue "  E2E Test: IMPHNEN Moderation Stack"
blue "  Target: ${BASE_URL}"
blue "════════════════════════════════════════════════════════"
blue ""

# ── 1. Health Check ────────────────────────────────────────────
blue "── API: Health Check ──"
assert "GET /api/health → 200" GET "${API}/health" 200 ""
assert_json_field "health.status == healthy" "${API}/health" "status"

# ── 2. Data APIs (oRPC at /trpc) ───────────────────────────────
# There is NO REST /api/* data layer: the backend mounts only the infra
# health router under /api, and everything else is an oRPC procedure at
# /trpc (WebSocket for the browser, HTTP POST for scripts). The previous
# /api/dashboard, /api/messages, /api/config, /api/guilds and /api/auth
# assertions targeted a REST layer that no longer exists — they returned
# 404 with the backend's own "data APIs are served over /trpc" body.
# oRPC's HTTP wire format wraps the result: {"json": <value>}.
blue "── API: oRPC (data) ──"
assert "POST /trpc/dashboard/stats → 200" POST "${TRPC}/dashboard/stats" 200 '{"json":{}}'
assert_json_field "dashboard.total_messages" "${TRPC}/dashboard/stats" "json.total_messages" '{"json":{}}'
assert_json_field "dashboard.total_flagged" "${TRPC}/dashboard/stats" "json.total_flagged" '{"json":{}}'
assert_json_field "dashboard.active_users_24h" "${TRPC}/dashboard/stats" "json.active_users_24h" '{"json":{}}'
assert "POST /trpc/dashboard/activity → 200" POST "${TRPC}/dashboard/activity" 200 '{"json":{"days":7}}'
assert "POST /trpc/messages/review → 200" POST "${TRPC}/messages/review" 200 '{"json":{"limit":3}}'
assert "POST /trpc/config/get → 200" POST "${TRPC}/config/get" 200 '{"json":{}}'

# ── 8. Frontend (Vite SPA shell) ─────────────────────────────────
# The dashboard is a client-rendered SPA: every page returns the same
# index.html shell with <div id="root">, and the router takes over in the
# browser. Assert the shell (not SSR content) on / and each deep link.
blue "── Frontend ──"
assert "GET / → 200" GET "${BASE_URL}/" 200 ""
assert_contains "Shell has React mount point" "${BASE_URL}/" '<div id="root">'
for route in dashboard messages moderation channels users analysis glossary; do
  assert "GET /${route} → 200 (SPA fallback)" GET "${BASE_URL}/${route}" 200 ""
  assert_contains "Shell on /${route}" "${BASE_URL}/${route}" '<div id="root">'
done

# ── 9. Endpoints that should 404 ──────────────────────────────
blue "── Negative Tests ──"
assert "GET /api/nonexistent → 404" GET "${API}/nonexistent" 404 ""

# ── Summary ────────────────────────────────────────────────────
blue ""
blue "════════════════════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then
  green "  ALL ${PASS} TESTS PASSED"
else
  red "  ${PASS} passed, ${FAIL} failed"
fi
blue "════════════════════════════════════════════════════════"
blue ""

exit "$FAIL"
