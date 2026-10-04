/**
 * Proves the pipeline trace is actually FOLLOWABLE — not just present.
 *
 * The claim being tested is narrow and falsifiable: given a message id, the
 * logs must contain every stage of that message's life, in order, with
 * timings. If a stage is missing, out of order, or untimed, this fails.
 *
 * Run: LOG_LEVEL=debug bun tests/trace-e2e.mjs
 */
import pg from "pg";
import { ModerationWorker } from "../src/modules/ai-moderation/worker.ts";

const DB =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5433/gmw_mod";

// Capture everything pino writes while the pipeline runs.
const lines = [];
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  const s = typeof chunk === "string" ? chunk : chunk?.toString?.() ?? "";
  for (const l of s.split("\n")) {
    if (l.trim().startsWith("{")) {
      try {
        lines.push(JSON.parse(l));
      } catch {
        /* not JSON, ignore */
      }
    }
  }
  return realWrite(chunk, ...rest);
};

const pool = new pg.Pool({ connectionString: DB, max: 6 });

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const stageOf = (trace) =>
  lines.filter((l) => l.trace === trace && l.stage).map((l) => l.stage);

async function seed(n, prefix) {
  await pool.query("TRUNCATE messages, verdicts, analysis_attempts, attachments");
  await pool.query(
    `INSERT INTO messages (id,guild_id,channel_id,user_id,username,content,created_at,ai_status,ready_for_work_at)
     SELECT $2||g,'g1','c1','u1','penguji','pesan uji '||g,
            (extract(epoch from now())*1000)::bigint - 5000,'pending',0
       FROM generate_series(1,$1) g`,
    [n, prefix],
  );
}

const cfg = {
  leaseMs: 60_000,
  llmTimeoutMs: 10_000,
  idlePollMs: 10,
  claimBatchSize: 25,
  maxAttempts: 3,
};

const stub = {
  modelLabel: "stub-model",
  async complete(req) {
    const ids = [...req.user.matchAll(/<message id="([^"]+)"/g)].map((m) => m[1]);
    return JSON.stringify({
      results: ids.map((id) => ({
        message_id: id,
        status: "clean",
        flags: [],
        analysis: "Aman.",
        score: 0.01,
        confidence: 0.9,
        evidence: [],
      })),
    });
  },
};

// ── happy path: every stage present, in order, timed ───────────────────────
console.log("\n[1] a completed message produces a full, ordered, timed trace");
await seed(3, "tr-");
lines.length = 0;
await new ModerationWorker(pool, stub, cfg).runOnce();

const trace = "tr-1".padEnd(12, "0").slice(-12) === "tr-1" ? "tr-1" : "tr-1";
const stages = stageOf("tr-1");
check("claimed stage logged", stages.includes("claimed"), stages.join(" → "));
check("llm stage logged", stages.includes("llm"));
check("parsed stage logged", stages.includes("parsed"));
check("verdict stage logged", stages.includes("verdict"));
check("cycle stage logged", stages.includes("cycle"));
check(
  "stages in pipeline order",
  JSON.stringify(stages) ===
    JSON.stringify(["claimed", "llm", "llm-raw", "parsed", "verdict", "cycle"]),
  stages.join(" → "),
);

const llm = lines.find((l) => l.stage === "llm" && l.trace === "tr-1");
check("llm stage is timed", typeof llm?.durationMs === "number", `${llm?.durationMs}ms`);
check("llm stage names the model", llm?.model === "stub-model", String(llm?.model));
check("llm stage reports prompt size", llm?.promptChars > 0, `${llm?.promptChars} chars`);

const claimed = lines.find((l) => l.stage === "claimed" && l.trace === "tr-1");
check("claim stage reports queue wait", typeof claimed?.waitMs === "number", `${claimed?.waitMs}ms`);
check(
  "claim stage is human-readable",
  /\d+(ms|s|m)/.test(claimed?.waitHuman ?? ""),
  String(claimed?.waitHuman),
);

const verdict = lines.find((l) => l.stage === "verdict" && l.trace === "tr-1");
check("verdict stage reports the outcome", verdict?.status === "clean", String(verdict?.status));
check(
  "verdict stage reports end-to-end elapsed",
  typeof verdict?.elapsedMs === "number" && /\d/.test(verdict?.elapsedHuman ?? ""),
  String(verdict?.elapsedHuman),
);
check("verdict stage carries the real attempt number", verdict?.attempts === 1, `attempts=${verdict?.attempts}`);

const batch = lines.find((l) => l.stage === "claimed-batch");
check(
  "batch line lists every id so siblings are greppable",
  Array.isArray(batch?.ids) && batch.ids.length === 3,
  JSON.stringify(batch?.ids),
);
check("batch line reports average wait", typeof batch?.avgWaitMs === "number", `${batch?.avgWaitMs}ms`);

// ── failure path: the exact production bug must be traceable ───────────────
console.log("\n[2] a batch failure is traceable to a single message id");
await seed(2, "tf-");
lines.length = 0;
const bad = {
  modelLabel: "stub-model",
  async complete() {
    return "<html>502 Bad Gateway</html>";
  },
};
await new ModerationWorker(pool, bad, cfg).runOnce();

const failStages = stageOf("tf-1");
check("failure still logs the llm stage", failStages.includes("llm"), failStages.join(" → "));
check("failure logs parsed as batchFailed", failStages.includes("parsed"));

const failLine = lines.find((l) => l.stage === "llm-failed" && l.trace === "tf-1");
check("llm-failed line exists for the message", Boolean(failLine));
check(
  "llm-failed carries the parser's own diagnosis",
  /no JSON object|results array/.test(failLine?.err ?? ""),
  String(failLine?.err),
);
check(
  "llm-failed lists BOTH ids, so either is greppable",
  Array.isArray(failLine?.ids) && failLine.ids.length === 2,
  JSON.stringify(failLine?.ids),
);
const rawLine = lines.find((l) => l.stage === "llm-raw" && l.trace === "tf-1");
check("raw model response is captured for diagnosis", /502/.test(rawLine?.content ?? ""), (rawLine?.content ?? "").slice(0, 40));

const requeued = lines.find((l) => l.stage === "requeued" && l.trace === "tf-1");
check("requeued stage logged per message", Boolean(requeued), String(requeued?.reason));
check("requeued stage reports the attempt number", requeued?.attempts === 1, `attempts=${requeued?.attempts}`);

// ── parked: exhausted attempts must be loud ───────────────────────────────
console.log("\n[3] a message that exhausts its attempts is logged as dead");
lines.length = 0;
const w = new ModerationWorker(pool, bad, cfg);
for (let i = 0; i < 4; i++) {
  await pool.query("UPDATE messages SET ready_for_work_at = 0");
  await w.runOnce();
}
const dead = lines.find((l) => l.stage === "dead" && l.trace === "tf-1");
check("dead stage logged", Boolean(dead));
check("dead stage is an error line", dead?.level === 50, `level=${dead?.level}`);
check("dead stage reports the attempt cap", dead?.attempts === 3, `attempts=${dead?.attempts}`);
check(
  "dead stage carries the diagnosis that killed it",
  /no JSON object|results array/.test(dead?.reason ?? ""),
  String(dead?.reason),
);

await pool.end();
process.stdout.write = realWrite;
console.log(
  failures === 0 ? "\nTrace is followable end to end." : `\n${failures} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
