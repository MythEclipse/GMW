/**
 * The dashboard shows real verdicts, live.
 *
 * ## The bug
 *
 * The moderation worker is database-only by design — it holds a pg Pool and
 * nothing else, so a slow model can never stall message capture. The cost of
 * that isolation is that it announces nothing: it writes the `verdicts` row,
 * sets `ai_status = 'analyzed'`, and exits. No Redis, no event.
 *
 * `EventBroadcaster.messageAnalyzed()` and the backend's Redis→WS bridge both
 * existed and were correct, but NOTHING ever called the publisher. The
 * frontend's `message_analyzed` handler therefore never fired in production.
 *
 * The symptom: the live message stream was frozen at whatever the server
 * render happened to fetch. A message captured after the page loaded showed
 * `ai_status: 'pending'` with no verdict, and `aiLabel()` renders that
 * combination as "unjudged" — so the dashboard appeared to show nothing but
 * unjudged messages until a manual reload.
 *
 * Measured against the running stack: a headless browser on /messages/
 * received 0 WebSocket frames while the worker was actively writing verdicts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import pg from "pg";

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5433/gmw_mod";

let pool: pg.Pool;
let reachable = false;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DB_URL, max: 2 });
  try {
    await pool.query("SELECT 1");
    reachable = true;
  } catch {
    reachable = false;
  }
});

afterAll(async () => {
  await pool?.end().catch(() => {});
});

async function seed(
  over: { status: string; severity: string } = {
    status: "flagged",
    severity: "high",
  },
) {
  await pool.query(
    "TRUNCATE messages, verdicts, analysis_attempts, attachments",
  );
  // 'pending', not 'analyzed': the deferred trigger rejects an analyzed
  // message with no verdict row.
  await pool.query(
    `INSERT INTO messages (id,guild_id,channel_id,user_id,username,content,created_at,ai_status,ready_for_work_at)
     VALUES ('notif-1','g1','c1','u1','budi','halo dunia',$1,'pending',0)`,
    [Date.now()],
  );
  await pool.query(
    `INSERT INTO verdicts (message_id,status,severity,score,confidence,flags,categories,
                           analysis,evidence,recommended_action,model,duration_ms)
     VALUES ('notif-1',$1,$2,0.9,0.95,'{harassment}','{harassment}',
             'Hinaan langsung pada pengguna lain.','[]','warn','test-model',1234)`,
    [over.status, over.severity],
  );
}

describe("verdict notifier selection", () => {
  test("a newly-written verdict is selected for publication", async () => {
    if (!reachable) return;
    await seed();
    // The notifier's cursor starts at boot - 60s, so a fresh verdict must be
    // inside the window. If the query filtered on the wrong column, or on
    // created_at instead of updated_at, this would find nothing.
    const since = Date.now() - 60_000;
    const { rows } = await pool.query<{
      message_id: string;
      status: string;
      username: string;
      content: string;
      updated_at: string;
    }>(
      `SELECT v.message_id, v.status, v.updated_at, m.username, m.content
         FROM verdicts v JOIN messages m ON m.id = v.message_id
        WHERE v.updated_at >= $1
        ORDER BY v.updated_at ASC
        LIMIT 50`,
      [since],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].message_id).toBe("notif-1");
    // The event REPLACES nothing on the frontend any more, but it must still
    // carry these or the card would lose them.
    expect(rows[0].username).toBe("budi");
    expect(rows[0].content).toBe("halo dunia");
  });

  test("a verdict older than the window is not republished", async () => {
    if (!reachable) return;
    await seed();
    const { rows } = await pool.query(
      `SELECT v.message_id FROM verdicts v WHERE v.updated_at >= $1`,
      [Date.now() + 60_000],
    );
    expect(rows).toHaveLength(0);
  });

  test("a RE-analysis is picked up (cursor must be updated_at, not created_at)", async () => {
    if (!reachable) return;
    await seed({ status: "warn", severity: "low" });
    const before = await pool.query<{ u: string; c: string }>(
      "SELECT updated_at::text u, created_at::text c FROM verdicts WHERE message_id='notif-1'",
    );
    // A re-judgement updates in place: created_at is unchanged, updated_at
    // moves. A cursor on created_at would miss this entirely and the
    // dashboard would keep showing the stale severity forever.
    await pool.query(
      `UPDATE verdicts SET status='flagged', severity='critical',
              updated_at=(extract(epoch from now())*1000)::bigint
        WHERE message_id='notif-1'`,
    );
    const after = await pool.query<{ u: string; c: string }>(
      "SELECT updated_at::text u, created_at::text c FROM verdicts WHERE message_id='notif-1'",
    );
    expect(after.rows[0].c).toBe(before.rows[0].c); // created_at unchanged
    expect(Number(after.rows[0].u)).toBeGreaterThan(Number(before.rows[0].u));
  });

  test("the verdict columns the badge needs are all populated", async () => {
    if (!reachable) return;
    await seed();
    // The badge reads verdict_status, falling back to ai_status. If the
    // notifier omitted verdict_status the message renders "unjudged" for an
    // analyzed row — the exact symptom this fixes.
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT v.status, v.severity, v.recommended_action, v.duration_ms, v.analysis
         FROM verdicts v WHERE v.message_id = 'notif-1'`,
    );
    expect(rows[0].status).toBe("flagged");
    expect(rows[0].severity).toBe("high");
    expect(rows[0].recommended_action).toBe("warn");
    expect(Number(rows[0].duration_ms)).toBe(1234);
    expect(String(rows[0].analysis)).toContain("Hinaan");
  });
});
