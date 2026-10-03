/**
 * Calls the LIVE backend using the frontend's own oRPC client — the exact code
 * path a dashboard server component uses.
 *
 * Guessing the wire format by hand kept producing 404s, because oRPC's RPC
 * protocol encodes the procedure differently from a plain REST path. Using
 * RPCLink means this test cannot get the transport wrong, so any failure here
 * is a real backend problem.
 *
 * Run: GMW_BACKEND_URL=http://127.0.0.1:4001 bun tests/be-live-api.mjs
 */
const BASE = (process.env.GMW_BACKEND_URL || "http://127.0.0.1:4001").replace(
  /\/+$/,
  "",
);

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

try {
  // RPCLink ships from the /fetch entrypoint, not the package root — the
  // frontend imports it from @orpc/client/websocket because the browser uses
  // a WebSocket, but this test wants the same HTTP transport the server
  // components use.
  const { createORPCClient } = await import("@orpc/client");
  const { RPCLink } = await import("@orpc/client/fetch");

  const client = createORPCClient(
    new RPCLink({
      url: `${BASE}/trpc`,
      fetch(url, init) {
        return fetch(url, { ...init, cache: "no-store" });
      },
    }),
  );

  // ── moderation.stats — repointed off the frozen moderation_actions ─────
  const mod = await client.moderation.stats();
  check("moderation.stats returns a non-zero total", Number(mod?.total) > 0, `total=${mod?.total}`);
  check(
    "moderation.stats counts live verdicts",
    Number(mod?.executed) > 0,
    `executed=${mod?.executed} failed=${mod?.failed} pending=${mod?.pending}`,
  );

  // ── moderation.coverage — used to read the deleted ai_analysis_runs ────
  const cov = await client.moderation.coverage({ days: 30 });
  check(
    "moderation.coverage is non-zero (was permanently 0)",
    Number(cov?.total) > 0 && Number(cov?.completed) > 0,
    `total=${cov?.total} completed=${cov?.completed} rate=${cov?.coverage_rate}%`,
  );

  // ── dashboard.stats — the headline counters that were all zero ─────────
  const dash = await client.dashboard.stats();
  check("dashboard total_flagged is live", Number(dash?.total_flagged) > 0, `flagged=${dash?.total_flagged}`);
  check("dashboard total_clean is live", Number(dash?.total_clean) > 0, `clean=${dash?.total_clean}`);
  check("dashboard total_warned is live", Number(dash?.total_warned) > 0, `warn=${dash?.total_warned}`);
  check("dashboard total_messages is live", Number(dash?.total_messages) > 0, `messages=${dash?.total_messages}`);
  check(
    "dashboard exposes the new pipeline counters",
    ["total_pending", "total_claimed", "total_retry_wait", "total_dead"].every(
      (k) => typeof dash?.[k] === "number",
    ),
    `pending=${dash?.total_pending} claimed=${dash?.total_claimed} retry_wait=${dash?.total_retry_wait} dead=${dash?.total_dead}`,
  );

  // ── messages.review — the queue that used to return nothing ────────────
  // `review` returns { results, limit, cursor } — not `data`.
  const review = await client.messages.review({ limit: 10 });
  const reviewRows = review?.results ?? [];
  check(
    "review queue returns rows (was permanently empty)",
    Array.isArray(reviewRows) && reviewRows.length > 0,
    `${Array.isArray(reviewRows) ? reviewRows.length : "not-an-array"} rows`,
  );
  if (Array.isArray(reviewRows) && reviewRows.length > 0) {
    check(
      "review rows carry the joined verdict",
      reviewRows.every((m) => "verdict_status" in m),
      `first: verdict_status=${reviewRows[0].verdict_status} ai_status=${reviewRows[0].ai_status}`,
    );
  }

  // ── messages.list — verdict fields must reach the client ───────────────
  // Requires a scope: channelId or guildId. Take a real one so this exercises
  // the same path the dashboard uses rather than a synthetic id.
  const guilds = await client.messages.guilds();
  const guildList = guilds?.data ?? guilds ?? [];
  const guildId = guildList[0]?.guild_id ?? guildList[0]?.id;
  check("messages.guilds returns a scope to query", Boolean(guildId), String(guildId));

  const list = await client.messages.list({ guildId, limit: 5 });
  const rows = list?.data ?? [];
  check("messages.list returns rows", rows.length > 0, `${rows.length} rows`);
  if (rows.length > 0) {
    check(
      "message rows expose verdict_status",
      rows.every((m) => "verdict_status" in m),
    );
    check(
      "message rows expose retry bookkeeping (ai_attempts)",
      rows.every((m) => "ai_attempts" in m),
    );
  }

  // ── the new verdict/needsReview filters must work over the wire ────────
  const flaggedOnly = await client.messages.list({ guildId, verdict: "flagged", limit: 5 });
  const flaggedRows = flaggedOnly?.data ?? [];
  check(
    "verdict filter returns only flagged messages",
    flaggedRows.length > 0 && flaggedRows.every((m) => m.verdict_status === "flagged"),
    `${flaggedRows.length} rows, statuses=${[...new Set(flaggedRows.map((m) => m.verdict_status))].join(",") || "none"}`,
  );

  const reviewFiltered = await client.messages.list({ guildId, needsReview: true, limit: 5 });
  const reviewFilteredRows = reviewFiltered?.data ?? [];
  check(
    "needsReview filter returns only warn/flagged",
    reviewFilteredRows.every((m) => ["warn", "flagged", "error"].includes(m.verdict_status)),
    `${reviewFilteredRows.length} rows`,
  );

  // ── a message WITH a verdict, end to end ──────────────────────────────
  if (Array.isArray(reviewRows) && reviewRows[0]?.id) {
    const msg = await client.messages.detail({ id: reviewRows[0].id });
    check(
      "message detail returns the joined verdict",
      Boolean(msg?.verdict_status),
      `verdict_status=${msg?.verdict_status} action=${msg?.verdict_recommended_action}`,
    );
    check(
      "message detail returns attempt history",
      Array.isArray(msg?.analysis_attempts),
      `${msg?.analysis_attempts?.length ?? 0} attempts`,
    );
  }
} catch (e) {
  fail++;
  console.log(`FAIL  threw — ${e.message}`);
  console.log(String(e.stack).split("\n").slice(1, 4).join("\n"));
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
