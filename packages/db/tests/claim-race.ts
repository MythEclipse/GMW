import { createDb } from "../src/client.js";
import { claimMessages, reclaimExpiredClaims } from "../src/queue.js";

const URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5433/gmw_mod";

const client = createDb({ connectionString: URL });
const GUILD = "race-test-guild";
const CHANNEL = "race-test-channel";

async function seed(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(`race-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`);
  await client.messages.createMany({
    data: ids.map((id, i) => ({
      id,
      guild_id: GUILD,
      channel_id: CHANNEL,
      user_id: "u1",
      username: "tester",
      content: `msg ${i}`,
      created_at: BigInt(Date.now() + i),
      type: "text",
      ai_status: "pending",
      owner: "worker",
      ready_for_work_at: 0n,
    })),
  });
  return ids;
}

async function cleanup(ids: string[]) {
  await client.messages.deleteMany({ where: { id: { in: ids } } });
}

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function main() {
  console.log("\n=== 1. disjointness under concurrent claims ===");
  {
    const ids = await seed(120);
    // 6 workers racing for the same 120 rows, batch 25.
    const workers = Array.from({ length: 6 }, (_, w) =>
      claimMessages(client, {
        workerId: `w${w}`,
        limit: 25,
        leaseMs: 60_000,
        maxRetries: 8,
      }),
    );
    const results = await Promise.all(workers);
    const all = results.flat().map((r) => r.id);
    const unique = new Set(all);
    check("no row claimed twice", all.length === unique.size, `${all.length} claimed, ${unique.size} unique`);
    check("every row claimed exactly once", all.length === 120, `got ${all.length}/120`);

    const attempts = await client.messages.findMany({
      where: { id: { in: ids } },
      select: { attempts: true, ai_status: true, worker_id: true },
    });
    check("attempts incremented to 1", attempts.every((a) => a.attempts === 1), `max=${Math.max(...attempts.map(a=>a.attempts))}`);
    check("all rows claimed", attempts.every((a) => a.ai_status === "claimed"));
    check("worker_id set", attempts.every((a) => typeof a.worker_id === "string" && a.worker_id.length > 0));
    await cleanup(ids);
  }

  console.log("\n=== 2. exhausted queue returns empty, not an error ===");
  {
    const rows = await claimMessages(client, { workerId: "w-empty", limit: 25, leaseMs: 60_000 });
    check("empty queue -> []", Array.isArray(rows) && rows.length === 0, `got ${rows.length}`);
  }

  console.log("\n=== 3. claimed rows are invisible to the next claim ===");
  {
    const ids = await seed(30);
    const first = await claimMessages(client, { workerId: "w1", limit: 30, leaseMs: 60_000 });
    const second = await claimMessages(client, { workerId: "w2", limit: 30, leaseMs: 60_000 });
    check("first claim got 30", first.length === 30, `got ${first.length}`);
    check("second claim got 0", second.length === 0, `got ${second.length}`);
    await cleanup(ids);
  }

  console.log("\n=== 4. reclaim returns expired leases to pending ===");
  {
    const ids = await seed(10);
    await claimMessages(client, { workerId: "dead-worker", limit: 10, leaseMs: -1 });
    const expired = await client.messages.count({
      where: { id: { in: ids }, ai_status: "claimed" },
    });
    check("rows marked claimed", expired === 10, `got ${expired}`);
    const reclaimed = await reclaimExpiredClaims(client);
    check("reclaim returned rows", reclaimed >= 10, `reclaimed ${reclaimed}`);
    const backToPending = await client.messages.count({
      where: { id: { in: ids }, ai_status: "pending" },
    });
    check("rows back to pending", backToPending === 10, `got ${backToPending}`);
    const withWorker = await client.messages.count({
      where: { id: { in: ids }, worker_id: { not: null } },
    });
    check("worker_id cleared", withWorker === 0, `still set on ${withWorker}`);
    await cleanup(ids);
  }

  console.log("\n=== 5. deleted_at rows are never claimed ===");
  {
    const ids = await seed(5);
    await client.messages.updateMany({
      where: { id: { in: ids } },
      data: { deleted_at: BigInt(Date.now()) },
    });
    const rows = await claimMessages(client, { workerId: "w3", limit: 25, leaseMs: 60_000 });
    check("soft-deleted excluded", !rows.some((r) => ids.includes(r.id)), `claimed ${rows.filter(r=>ids.includes(r.id)).length}`);
    await cleanup(ids);
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  await client.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("harness error:", e);
  process.exit(1);
});