/**
 * End-to-end: the claim query must hand the worker the channel's purpose, and
 * the prompt the worker builds must contain it.
 *
 * A unit test on `formatChannelContextForPrompt` alone would pass while the
 * feature stayed inert — which is exactly how the link/embed bug survived
 * (`metadata` was selected but never interpolated) and how the vision
 * descriptions died (resolved, then dropped on the floor). So this asserts the
 * captured PROMPT string, the same way `linkEmbedWiring.test.ts` does.
 */
import { expect, test } from "bun:test";
import pg from "pg";
import type { LlmGateway } from "../src/modules-gateway/ai-moderation/llmGateway.js";
import {
  buildSystemPrompt,
  CHANNEL_CONTEXT_RULES,
  clearPromptCache,
} from "../src/modules-gateway/ai-moderation/policy.js";
import { ModerationWorker } from "../src/modules-gateway/ai-moderation/worker.js";
import { formatChannelContextForPrompt } from "../src/modules-gateway/message-capture/messageMetadata.js";

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:***@127.0.0.1:5433/gmw_mod";

let pool: pg.Pool;
let reachable = false;

interface Captured {
  user: string;
  system: string;
}

/** A worker wired to a gateway that records the prompt it was handed. */
function recordingWorker(
  capture: (prompt: Captured) => void,
): ModerationWorker {
  const gateway: LlmGateway = {
    modelLabel: "scripted",
    async complete(req) {
      capture({ user: req.user, system: req.system });
      const id = /<message id="([^"]+)"/.exec(req.user)?.[1] ?? "";
      return JSON.stringify({
        results: [
          {
            message_id: id,
            status: "clean",
            flags: [],
            categories: [],
            confidence: 0.9,
            score: 0.02,
            analysis: "Ringkasan isi pesan.",
            evidence: [],
          },
        ],
      });
    },
  };
  return new ModerationWorker(pool, gateway, {
    leaseMs: 60_000,
    llmTimeoutMs: 10_000,
    visionTimeoutMs: 10_000,
    idlePollMs: 10,
    claimBatchSize: 10,
  });
}

async function seed(
  id: string,
  content: string,
  metadata: string,
  channelId = "1222776746038792274",
) {
  await pool.query(
    "TRUNCATE messages, verdicts, analysis_attempts, attachments",
  );
  await pool.query(
    `INSERT INTO messages
       (id, guild_id, channel_id, user_id, username, content, created_at,
        ai_status, ready_for_work_at, metadata)
     VALUES ($1,'g1',$2,'u1','aira',$3,$4,'pending',0,$5)`,
    [id, channelId, content, Date.now(), metadata],
  );
}

const EXTERNAL_COMMUNITY_TOPIC = "Channel khusus share komunitas external";

/** The metadata capture writes for a post in the external-community channel. */
function metadataWithTopic(topic: string | null) {
  return JSON.stringify({
    embeds: [],
    attachments: [],
    stickers: [],
    channel: {
      channelId: "1222776746038792274",
      channelName: "share-komunitas",
      topic,
      threadId: null,
      threadName: null,
      nsfw: false,
    },
  });
}

test("the prompt carries the channel's topic, so an on-topic share is not spam", async () => {
  pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
  try {
    await pool.query("SELECT 1");
    reachable = true;
  } catch {
    reachable = false;
  }
  if (!reachable) return expect(true).toBe(true);

  // The reported message, shape for shape: an invite link posted in a channel
  // whose topic exists to collect exactly that.
  await seed(
    "1402327963029991111",
    "atminku suruh promote server tapi aku gatau mw promote kemana, jadi aku promote kesini aja\nhttps://discord.gg/idn",
    metadataWithTopic(EXTERNAL_COMMUNITY_TOPIC),
  );

  let prompt = "";
  let system = "";
  await recordingWorker((c) => {
    prompt = c.user;
    system = c.system;
  }).runOnce();

  // A verdict about "unrelated to the channel's topic" is only reachable when
  // the model was never shown the topic. These are the fix.
  expect(prompt).toContain("1402327963029991111");
  expect(prompt).toContain(EXTERNAL_COMMUNITY_TOPIC);
  expect(prompt).toContain('channel="share-komunitas"');
  expect(prompt).toContain("https://discord.gg/idn");
  // And the rules that tell the model how to read that attribute.
  expect(system).toContain("KONTEKS KANAL");

  await pool.end();
});

test("the rules explaining the attribute ship with every prompt", () => {
  clearPromptCache();
  const prompt = buildSystemPrompt({ mode: "text" });
  expect(prompt).toContain("KONTEKS KANAL");
  expect(prompt).toContain(CHANNEL_CONTEXT_RULES.slice(0, 40));
  // The rule that forbids the exact verdict this bug produced.
  expect(prompt).toContain("tidak relevan dengan topik channel");
});

test("a message with no captured topic leaves the prompt tag unchanged", () => {
  // The degraded branch: rows captured before topics were stored, and any row
  // whose channel exposes none. Must degrade silently, not render `topic=""`,
  // which would read as "this channel has an empty purpose" — an
  // evidence-free claim of the same kind as the bug.
  expect(formatChannelContextForPrompt(metadataWithTopic(null))).toBe(
    ' channel="share-komunitas"',
  );
  expect(formatChannelContextForPrompt(null)).toBe("");
  expect(formatChannelContextForPrompt("{}")).toBe("");
  expect(formatChannelContextForPrompt("not json")).toBe("");
});
