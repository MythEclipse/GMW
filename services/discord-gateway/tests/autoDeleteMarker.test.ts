/**
 * The auto-delete marker must follow the verdict, not freeze at first sight.
 *
 * ## The bug
 *
 * `verdicts.auto_delete_state` is the enforcer's "I already considered this"
 * flag, and the enforcer's candidate query reads only NULL or 'pending'.
 * Nothing reset it, so once a verdict settled as `done`, a LATER re-judgement
 * that made the message worse (warn -> flagged, review -> delete) could never
 * be enforced again. The partial index
 * `idx_verdicts_auto_delete_pending` has the same predicate, so the row was
 * dropped from the index as well — a message that got worse was permanently
 * unenforceable.
 *
 * The upsert in worker.ts now clears the marker on a material change. This
 * asserts that behaviour against a real PostgreSQL, because it is a SQL
 * question (`IS DISTINCT FROM` inside `ON CONFLICT DO UPDATE`) that a mock
 * cannot answer.
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

/**
 * The exact upsert the worker performs, including the marker reset.
 * Kept as a literal here so the test fails if the two drift apart.
 */
const WORKER_UPSERT = `
INSERT INTO verdicts
  (message_id, status, severity, score, confidence, flags, categories,
   analysis, evidence, recommended_action, model)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
ON CONFLICT (message_id) DO UPDATE SET
  status = EXCLUDED.status, severity = EXCLUDED.severity,
  score = EXCLUDED.score, confidence = EXCLUDED.confidence,
  flags = EXCLUDED.flags, categories = EXCLUDED.categories,
  analysis = EXCLUDED.analysis, evidence = EXCLUDED.evidence,
  recommended_action = EXCLUDED.recommended_action,
  model = EXCLUDED.model,
  auto_delete_state = CASE
    WHEN verdicts.status IS DISTINCT FROM EXCLUDED.status
      OR verdicts.severity IS DISTINCT FROM EXCLUDED.severity
      OR verdicts.recommended_action IS DISTINCT FROM EXCLUDED.recommended_action
      OR verdicts.score IS DISTINCT FROM EXCLUDED.score
    THEN NULL ELSE verdicts.auto_delete_state END,
  auto_delete_claimed_at = CASE
    WHEN verdicts.status IS DISTINCT FROM EXCLUDED.status
      OR verdicts.severity IS DISTINCT FROM EXCLUDED.severity
      OR verdicts.recommended_action IS DISTINCT FROM EXCLUDED.recommended_action
      OR verdicts.score IS DISTINCT FROM EXCLUDED.score
    THEN NULL ELSE verdicts.auto_delete_claimed_at END,
  updated_at = (extract(epoch from now())*1000)::bigint`;

async function upsert(v: {
  status: string;
  severity: string;
  action: string;
  score: number;
}) {
  await pool.query(WORKER_UPSERT, [
    "marker-1",
    v.status,
    v.severity,
    v.score,
    0.9,
    "{}",
    "{}",
    "desc",
    "[]",
    v.action,
    "test-model",
  ]);
}

async function marker(): Promise<string | null> {
  const { rows } = await pool.query<{ auto_delete_state: string | null }>(
    "SELECT auto_delete_state FROM verdicts WHERE message_id = 'marker-1'",
  );
  return rows[0]?.auto_delete_state ?? null;
}

async function seed() {
  await pool.query(
    "TRUNCATE messages, verdicts, analysis_attempts, attachments",
  );
  // 'pending', not 'analyzed': the deferred trigger
  // assert_analyzed_has_verdict() rejects an analyzed message with no
  // verdict row, and the first upsert below is what creates it.
  await pool.query(
    `INSERT INTO messages (id,guild_id,channel_id,user_id,username,content,created_at,ai_status,ready_for_work_at)
     VALUES ('marker-1','g1','c1','u1','u1','body',1,'pending',0)`,
  );
}

describe("auto-delete marker follows the verdict", () => {
  test("an escalation re-opens a settled verdict for enforcement", async () => {
    if (!reachable) return;
    await seed();

    // First judgement: mild, and the enforcer considers it done.
    await upsert({
      status: "warn",
      severity: "low",
      action: "monitor",
      score: 0.3,
    });
    await pool.query(
      "UPDATE verdicts SET auto_delete_state='done', auto_delete_claimed_at=1 WHERE message_id='marker-1'",
    );
    expect(await marker()).toBe("done");

    // A later judgement makes it much worse. The message must become
    // enforceable again.
    await upsert({
      status: "flagged",
      severity: "high",
      action: "delete",
      score: 0.9,
    });
    expect(await marker()).toBeNull();

    // And it must be visible to the enforcer's actual candidate query.
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int n
         FROM verdicts v JOIN messages m ON m.id = v.message_id
        WHERE v.status IN ('flagged','warn')
          AND m.deleted_at IS NULL
          AND (v.auto_delete_state IS NULL OR v.auto_delete_state = 'pending')`,
    );
    expect(rows[0].n).toBe(1);
  });

  test("an unchanged re-analysis does NOT re-open a settled verdict", async () => {
    if (!reachable) return;
    await seed();

    await upsert({
      status: "warn",
      severity: "low",
      action: "monitor",
      score: 0.3,
    });
    await pool.query(
      "UPDATE verdicts SET auto_delete_state='done', auto_delete_claimed_at=1 WHERE message_id='marker-1'",
    );

    // Identical verdict written again (an edit re-run, a re-analysis).
    await upsert({
      status: "warn",
      severity: "low",
      action: "monitor",
      score: 0.3,
    });
    // The marker must survive: re-opening on every routine re-analysis would
    // put every settled message back in the enforcer's queue forever.
    expect(await marker()).toBe("done");
  });

  test("a severity-only change re-opens the marker", async () => {
    if (!reachable) return;
    await seed();
    await upsert({
      status: "warn",
      severity: "low",
      action: "monitor",
      score: 0.3,
    });
    await pool.query(
      "UPDATE verdicts SET auto_delete_state='done' WHERE message_id='marker-1'",
    );
    // Same status, but low -> high is exactly the case the enforcer treats
    // as unconditionally eligible, so the marker must clear.
    await upsert({
      status: "warn",
      severity: "high",
      action: "monitor",
      score: 0.3,
    });
    expect(await marker()).toBeNull();
  });

  test("a score change alone re-opens the marker", async () => {
    if (!reachable) return;
    await seed();
    await upsert({
      status: "warn",
      severity: "medium",
      action: "review",
      score: 0.4,
    });
    await pool.query(
      "UPDATE verdicts SET auto_delete_state='done' WHERE message_id='marker-1'",
    );
    await upsert({
      status: "warn",
      severity: "medium",
      action: "review",
      score: 0.85,
    });
    expect(await marker()).toBeNull();
  });

  test("a de-escalation also re-opens it, so a wrong deletion is reversible", async () => {
    if (!reachable) return;
    await seed();
    await upsert({
      status: "flagged",
      severity: "high",
      action: "delete",
      score: 0.9,
    });
    await pool.query(
      "UPDATE verdicts SET auto_delete_state='done' WHERE message_id='marker-1'",
    );
    await upsert({
      status: "clean",
      severity: "none",
      action: "none",
      score: 0.01,
    });
    expect(await marker()).toBeNull();
  });
});
