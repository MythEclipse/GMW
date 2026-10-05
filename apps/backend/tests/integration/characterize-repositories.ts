/**
 * P1b characterization snapshot — records what the Prisma-backed repositories
 * return TODAY, so P1c's Drizzle port can be proven not to change behaviour.
 *
 * This is a record-then-compare harness, not a pass/fail test. Run it before a
 * port (`--write`) and again after (`--check`); the second run must report zero
 * differences. A method whose output legitimately changes shape during a port
 * gets re-baselined deliberately, with the reason recorded in BASELINE_NOTES.
 *
 *   # record the current (Prisma) behaviour
 *   DATABASE_URL=... tsx tests/integration/characterize-repositories.ts --write
 *
 *   # after porting: must report no differences
 *   DATABASE_URL=... tsx tests/integration/characterize-repositories.ts --check
 *
 * Why a snapshot and not hand-written assertions: these repositories have ~107
 * query calls and zero existing coverage. Writing expected values by hand would
 * encode my assumptions rather than observed behaviour — which is exactly how a
 * subtly wrong query passes review. Snapshotting whatever Prisma does today is
 * the only honest baseline.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { executeTool } from "../../src/modules/chatbot/chatbot.tools.js";
import { dashboardRepository } from "../../src/modules/dashboard/dashboard.repository.js";
import { messagesRepository } from "../../src/modules/messages/messages.repository.js";
import { moderationRepository } from "../../src/modules/moderation/moderation.repository.js";
import {
  closeDrizzleDatabase,
  initializeDatabase,
} from "../../src/shared/database/drizzle.js";
import { clearFixture, FIXTURE, seedFixture } from "./characterize-fixture.js";

const SNAPSHOT_PATH = fileURLToPath(
  new URL("./__snapshots__/repositories.json", import.meta.url),
);

const { GUILD, CH_A } = FIXTURE;

/**
 * Methods whose output is EXPECTED to differ once the ORM changes, with the
 * reason. An empty list is the goal — anything added here is a behaviour change
 * that has to be justified, not papered over.
 *
 * These are not cosmetic. Every entry below was ALREADY BROKEN under Prisma,
 * and returns a `Tool <name> gagal: <reason>` string instead of JSON. The
 * Drizzle port fixes them, so the baseline has to record the broken behaviour
 * or the fix reads as a regression:
 *
 *   - `voice_recordings` has no `transcription` column. Prisma rejected the
 *     whole select, so `get_voice_recordings` always answered "gagal".
 *   - Prisma returns `messages.created_at` as a raw `bigint`, and
 *     `JSON.stringify` throws on one — so every tool that returns a message
 *     row (get_message_detail, get_recent_activity, search_messages,
 *     get_user_messages, get_top_flagged, get_server_stats) 500'd at the
 *     chatbot. This is the same BigInt-to-JSON hazard that
 *     `messages.getReviewMessages` was patched for, in a tool that was missed.
 *     Drizzle's `mode: "number"` columns return numbers, so the port fixes it.
 */
const BASELINE_NOTES: Record<string, string> = {
  "chatbot.get_server_stats":
    "Prisma returned created_at as bigint; JSON.stringify threw",
  "chatbot.get_server_stats.scoped":
    "Prisma returned created_at as bigint; JSON.stringify threw",
  "chatbot.get_recent_activity":
    "Prisma returned created_at as bigint; JSON.stringify threw",
  "chatbot.get_top_flagged":
    "Prisma returned created_at as bigint; JSON.stringify threw",
  "chatbot.search_messages":
    "Prisma returned created_at as bigint; JSON.stringify threw",
  "chatbot.get_user_messages":
    "Prisma returned created_at as bigint; JSON.stringify threw",
  "chatbot.get_message_detail":
    "Prisma returned created_at as bigint; JSON.stringify threw",
  "chatbot.get_voice_recordings":
    "transcription column does not exist; Prisma rejected the select",
  // Surfaced by running the port rather than by reading the file: these two
  // failed for the same bigint reason but were not in the first list, and both
  // pass `last_analyzed_at` straight through `JSON.stringify`.
  "chatbot.get_user_profile":
    "Prisma returned last_analyzed_at as bigint; JSON.stringify threw",
  "chatbot.get_channel_culture":
    "Prisma returned last_analyzed_at as bigint; JSON.stringify threw",
};

/** Stable stringify: object keys sorted, so key-order churn is not a diff. */
function stable(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (Array.isArray(value)) return value.map(stable);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = stable((value as Record<string, unknown>)[key]);
  }
  return out;
}

/** Every repository method P1c will port, invoked with fixture-shaped args. */
async function collect(): Promise<Record<string, unknown>> {
  const calls: Array<[string, () => Promise<unknown>]> = [
    // ── moderation ────────────────────────────────────────────────────
    ["moderation.getStats", () => moderationRepository.getStats()],
    ["moderation.getQueueStats", () => moderationRepository.getQueueStats()],
    [
      "moderation.listActions.all",
      () => moderationRepository.listActions({ limit: 50 }),
    ],
    [
      "moderation.listActions.statusExecuted",
      () => moderationRepository.listActions({ status: "executed", limit: 50 }),
    ],
    [
      "moderation.listActions.typeResetNickname",
      () =>
        moderationRepository.listActions({
          actionType: "reset_nickname",
          limit: 50,
        }),
    ],
    ["moderation.getTrends", () => moderationRepository.getTrends(30)],
    [
      "moderation.getTopFlaggedDomains",
      () => moderationRepository.getTopFlaggedDomains(30),
    ],
    [
      "moderation.getTopFlaggedChannels",
      () => moderationRepository.getTopFlaggedChannels(30),
    ],
    [
      "moderation.getHourlyModeration",
      () => moderationRepository.getHourlyModeration(30),
    ],
    [
      "moderation.getByCategory",
      () => moderationRepository.getByCategory(30, "scam"),
    ],
    ["moderation.getCoverage", () => moderationRepository.getCoverage(30)],

    // ── messages ──────────────────────────────────────────────────────
    [
      "messages.findMany.default",
      () => messagesRepository.findMany({ limit: 10 }),
    ],
    [
      "messages.findMany.guild",
      () => messagesRepository.findMany({ guildId: GUILD, limit: 10 }),
    ],
    [
      "messages.findMany.search",
      () =>
        messagesRepository.findMany({
          guildId: GUILD,
          search: "halo",
          limit: 10,
        }),
    ],
    ["messages.findById", () => messagesRepository.findById("char-msg-1")],
    [
      "messages.findById.missing",
      () => messagesRepository.findById("char-nope"),
    ],
    [
      "messages.getAnalysisAttempts",
      () => messagesRepository.getAnalysisAttempts("char-msg-1"),
    ],
    // These four take POSITIONAL args, not a query object — passing an
    // object here made Prisma reject `limit` as an unknown field argument,
    // which surfaced as four bogus "this method throws" snapshots.
    [
      "messages.getEditHistory",
      // Takes a messageId — not (limit, cursor). Passing `undefined` returned
      // zero rows on BOTH the old and new code, so `--check` reported a match
      // while actually asserting nothing. That is the failure mode a snapshot
      // cannot catch on its own.
      () => messagesRepository.getEditHistory("char-msg-5"),
    ],
    [
      "messages.findByChannel",
      () => messagesRepository.findByChannel(CH_A, { limit: 10 }),
    ],
    [
      "messages.getReviewMessages",
      () => messagesRepository.getReviewMessages(undefined, 10),
    ],
    [
      "messages.getImageMessages",
      () => messagesRepository.getImageMessages(GUILD, 10),
    ],
    [
      "messages.getAttachmentsByChannel",
      () => messagesRepository.getAttachmentsByChannel(CH_A, { limit: 10 }),
    ],
    ["messages.getActivity", () => messagesRepository.getActivity(30)],
    [
      "messages.getRecentEdits",
      () => messagesRepository.getRecentEdits(undefined, undefined),
    ],
    ["messages.listGuilds", () => messagesRepository.listGuilds()],
    [
      "messages.listTextChannels",
      () => messagesRepository.listTextChannels(GUILD),
    ],

    // ── dashboard ─────────────────────────────────────────────────────
    ["dashboard.getStats", () => dashboardRepository.getStats()],
    ["dashboard.getActivity", () => dashboardRepository.getActivity(14)],
    ["dashboard.listUsers", () => dashboardRepository.listUsers({ limit: 20 })],
    [
      "dashboard.listUsers.search",
      () => dashboardRepository.listUsers({ limit: 20, search: "alpha" }),
    ],
    [
      "dashboard.listChannels",
      () => dashboardRepository.listChannels({ limit: 20, guildId: GUILD }),
    ],
    [
      "dashboard.getChannelDetail",
      () => dashboardRepository.getChannelDetail(CH_A),
    ],
    [
      "dashboard.getTopReactions",
      () => dashboardRepository.getTopReactions(10),
    ],
    ["dashboard.getTopReactors", () => dashboardRepository.getTopReactors(10)],
    [
      "dashboard.getUserDetail",
      () => dashboardRepository.getUserDetail("char-user-1"),
    ],

    // ── chatbot tools ─────────────────────────────────────────────────
    // Every executor that touches the database. Each returns a JSON STRING, so
    // the collector parses it before snapshotting — otherwise key order inside
    // the string would register as a diff on every port.
    [
      "chatbot.get_server_stats",
      () => executeTool("get_server_stats", { guildId: GUILD }),
    ],
    [
      "chatbot.get_server_stats.scoped",
      () =>
        executeTool("get_server_stats", { guildId: GUILD, channelId: CH_A }),
    ],
    [
      "chatbot.get_top_channels",
      () => executeTool("get_top_channels", { guildId: GUILD }),
    ],
    [
      "chatbot.get_recent_activity",
      () => executeTool("get_recent_activity", { guildId: GUILD }),
    ],
    [
      "chatbot.get_top_flagged",
      () => executeTool("get_top_flagged", { guildId: GUILD }),
    ],
    [
      "chatbot.search_messages",
      () => executeTool("search_messages", { query: "halo", guildId: GUILD }),
    ],
    [
      "chatbot.get_user_messages",
      () =>
        executeTool("get_user_messages", {
          userId: "char-user-1",
          guildId: GUILD,
        }),
    ],
    [
      "chatbot.get_user_profile",
      () =>
        executeTool("get_user_profile", {
          userId: "char-user-1",
          guildId: GUILD,
        }),
    ],
    [
      "chatbot.get_user_reputation",
      () => executeTool("get_user_reputation", { userId: "char-user-1" }),
    ],
    [
      "chatbot.get_channel_culture",
      () => executeTool("get_channel_culture", { channelId: CH_A }),
    ],
    [
      "chatbot.get_message_detail",
      () => executeTool("get_message_detail", { messageId: "char-msg-1" }),
    ],
    [
      "chatbot.get_message_reviews",
      () => executeTool("get_message_reviews", { guildId: GUILD }),
    ],
    [
      "chatbot.get_voice_recordings",
      () => executeTool("get_voice_recordings", { guildId: GUILD }),
    ],
    [
      "chatbot.get_moderation_timeline",
      () =>
        executeTool("get_moderation_timeline", { guildId: GUILD, days: 60 }),
    ],
    [
      "chatbot.get_corrections",
      () => executeTool("get_corrections", { guildId: GUILD }),
    ],
  ];

  const out: Record<string, unknown> = {};
  for (const [name, run] of calls) {
    try {
      const result = await run();
      // The chatbot tools answer with a JSON STRING, not an object. Parsing it
      // here means a key-order change inside the payload does not read as a
      // behavioural difference — only the values are compared.
      out[name] =
        typeof result === "string"
          ? stable(JSON.parse(result))
          : stable(result);
    } catch (err) {
      // Recorded, not swallowed: a method that throws today must still
      // throw after the port, and that IS the baseline.
      out[name] = {
        __threw: true,
        name: err instanceof Error ? err.name : typeof err,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return out;
}

function diff(before: unknown, after: unknown, path = ""): string[] {
  if (Object.is(before, after)) return [];
  if (
    typeof before !== "object" ||
    typeof after !== "object" ||
    before === null ||
    after === null
  ) {
    return [
      `${path || "<root>"}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
    ];
  }
  if (Array.isArray(before) !== Array.isArray(after)) {
    return [`${path}: shape changed (array vs object)`];
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) {
      return [`${path}: length ${before.length} -> ${after.length}`];
    }
    return before.flatMap((v, i) => diff(v, after[i], `${path}[${i}]`));
  }
  const keys = new Set([
    ...Object.keys(before as object),
    ...Object.keys(after as object),
  ]);
  return [...keys].flatMap((k) =>
    diff(
      (before as Record<string, unknown>)[k],
      (after as Record<string, unknown>)[k],
      path ? `${path}.${k}` : k,
    ),
  );
}

async function main() {
  const mode = process.argv[2] === "--check" ? "check" : "write";

  // ONE handle. The repositories used to read through Prisma while the fixture
  // used Drizzle, so this initialised both; Prisma is gone as of P1d and every
  // read now goes through the same Drizzle handle.
  await initializeDatabase();
  await seedFixture();

  let actual: Record<string, unknown>;
  try {
    actual = await collect();
  } finally {
    await clearFixture();
  }
  await closeDrizzleDatabase();

  if (mode === "write") {
    writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(actual, null, 2)}\n`);
    const n = Object.keys(actual).length;
    const threw = Object.values(actual).filter(
      (v) => typeof v === "object" && v !== null && "__threw" in v,
    ).length;
    console.log(
      `recorded ${n} method snapshots to ${SNAPSHOT_PATH}` +
        (threw > 0
          ? ` (${threw} currently throw and are recorded as such)`
          : ""),
    );
    return;
  }

  const expected = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  const problems: string[] = [];
  const skipped: string[] = [];
  for (const name of new Set([
    ...Object.keys(expected),
    ...Object.keys(actual),
  ])) {
    if (!(name in expected)) {
      problems.push(`${name}: NEW method, not in the baseline`);
      continue;
    }
    if (!(name in actual)) {
      problems.push(`${name}: MISSING from the current run`);
      continue;
    }
    // A skipped method still has to SUCCEED now. If it throws again, the fix
    // regressed and that must not pass quietly.
    if (name in BASELINE_NOTES) {
      const value = actual[name];
      const stillBroken =
        typeof value === "object" && value !== null && "__threw" in value;
      if (stillBroken) {
        problems.push(
          `${name}: was expected to be FIXED by the port but still throws`,
        );
      } else {
        skipped.push(`${name} — ${BASELINE_NOTES[name]}`);
      }
      continue;
    }
    problems.push(...diff(expected[name], actual[name], name));
  }

  if (skipped.length > 0) {
    console.log(
      `${skipped.length} method(s) were broken before the port and now return data:`,
    );
    for (const s of skipped) console.log(`  fixed: ${s}`);
  }

  if (problems.length === 0) {
    console.log(
      `P1b: ${Object.keys(actual).length} method snapshots match the baseline`,
    );
    return;
  }
  console.error(`P1b: ${problems.length} difference(s) against the baseline:`);
  for (const p of problems.slice(0, 60)) console.error(`  ${p}`);
  if (problems.length > 60) {
    console.error(`  ...and ${problems.length - 60} more`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error("characterization harness threw:", err);
  process.exit(1);
});
