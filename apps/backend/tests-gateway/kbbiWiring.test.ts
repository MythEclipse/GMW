/**
 * End-to-end: KBBI definitions must appear in the PROMPT the worker builds.
 *
 * ## Why this file exists separately from `kbbiEvidence.test.ts`
 *
 * That file proves the pieces work: the selector picks words, the adapter
 * returns definitions, the formatter renders them. Every one of those tests
 * passes while the feature is completely inert, because none of them involve
 * the worker.
 *
 * The inert failure is a one-character class of bug: `formatDefinitions(...)`
 * is called, its result assigned to a variable, and the variable is never
 * interpolated into the template literal. The formatter test is green, the
 * adapter test is green, the model still guesses slang meanings, and nothing in
 * the suite objects. That is not hypothetical — it is exactly how the previous
 * version of this feature shipped.
 *
 * So this file runs the real `ModerationWorker.runOnce()` against a recording
 * gateway and asserts on the captured prompt string, the same shape as
 * `channelContextWiring.test.ts` and `linkEmbedWiring.test.ts`.
 */

import { expect, test } from "bun:test";
import pg from "pg";
import {
  type DictionaryConfig,
  KbbiDictionary,
} from "../src/modules-gateway/ai-moderation/kbbiDictionary.js";
import type { LlmGateway } from "../src/modules-gateway/ai-moderation/llmGateway.js";
import { clearPromptCache } from "../src/modules-gateway/ai-moderation/policy.js";
import { ModerationWorker } from "../src/modules-gateway/ai-moderation/worker.js";

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:***@127.0.0.1:5433/gmw_mod";

let pool: pg.Pool | null = null;
let reachable = false;

interface Captured {
  user: string;
  system: string;
}

const DICT_CFG: DictionaryConfig = {
  baseUrl: "http://dict.test",
  enabled: true,
  timeoutMs: 2000,
  maxWords: 24,
  maxWordsPerMessage: 8,
  maxCharsPerWord: 300,
  maxCharsPerBatch: 2000,
};

/** A dictionary stub that defines exactly the words it is given. */
function dictionaryDefining(
  answers: Record<string, { senses: string[]; standard?: boolean }>,
): KbbiDictionary {
  const stubFetch = ((url: string | URL) => {
    const words = new URL(String(url)).searchParams.getAll("words");
    const results = words.map((word) => {
      const a = answers[word];
      if (!a) return { word, status: "not_found", entry: null };
      return {
        word,
        status: "success",
        entry: {
          data: { entri: [{ nama: word, makna: [{ submakna: a.senses }] }] },
        },
        standard: { is_standard: a.standard ?? true },
      };
    });
    return Promise.resolve(
      new Response(JSON.stringify({ results }), { status: 200 }),
    );
  }) as typeof fetch;
  return new KbbiDictionary(DICT_CFG, stubFetch);
}

/** A worker whose gateway records the prompt and answers for every message. */
function recordingWorker(
  capture: (c: Captured) => void,
  dictionary?: KbbiDictionary,
): ModerationWorker {
  const gateway: LlmGateway = {
    modelLabel: "scripted",
    async complete(req) {
      capture({ user: req.user, system: req.system });
      const ids = [...req.user.matchAll(/<message id="([^"]+)"/g)].map(
        (m) => m[1] ?? "",
      );
      return JSON.stringify({
        results: ids.map((id) => ({
          message_id: id,
          status: "clean",
          flags: [],
          categories: [],
          confidence: 0.9,
          score: 0.02,
          analysis: "Ringkasan isi pesan.",
          evidence: [],
        })),
      });
    },
  };
  return new ModerationWorker(
    pool as pg.Pool,
    gateway,
    {
      leaseMs: 60_000,
      llmTimeoutMs: 10_000,
      visionTimeoutMs: 10_000,
      idlePollMs: 10,
      claimBatchSize: 10,
    },
    undefined,
    undefined,
    dictionary,
  );
}

async function seed(id: string, content: string): Promise<void> {
  await pool?.query(
    "TRUNCATE messages, verdicts, analysis_attempts, attachments",
  );
  await pool?.query(
    `INSERT INTO messages
       (id, guild_id, channel_id, user_id, username, content, created_at,
        ai_status, ready_for_work_at, metadata)
     VALUES ($1,'g1','c1','u1','aira',$2,$3,'pending',0,$4)`,
    [
      id,
      content,
      Date.now(),
      JSON.stringify({
        embeds: [],
        attachments: [],
        stickers: [],
        channel: {
          channelId: "c1",
          channelName: "general",
          topic: "obrolan harian",
          threadId: null,
          threadName: null,
          nsfw: false,
        },
      }),
    ],
  );
}

async function ensureDb(): Promise<boolean> {
  if (pool) return reachable;
  pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
  try {
    await pool.query("SELECT 1");
    reachable = true;
  } catch {
    reachable = false;
  }
  return reachable;
}

test("the definition reaches the prompt, inside the message that used the word", async () => {
  if (!(await ensureDb())) return expect(true).toBe(true);
  clearPromptCache();

  await seed("1554472364094521396", "biji kopi nascentFilled");

  let prompt = "";
  let system = "";
  await recordingWorker(
    (c) => {
      prompt = c.user;
      system = c.system;
    },
    dictionaryDefining({ biji: { senses: ["isi buah yang dapat ditanam"] } }),
  ).runOnce();

  // The word AND its official sense, in the user prompt.
  expect(prompt).toContain('<definition word="biji"');
  expect(prompt).toContain("isi buah yang dapat ditanam");

  // And the rule that explains what to do with it.
  expect(system).toContain("KAMUS");

  await pool?.end();
  pool = null;
});

test("a definition is scoped to its own message, never shared across the batch", async () => {
  if (!(await ensureDb())) return expect(true).toBe(true);
  clearPromptCache();

  await pool?.query(
    "TRUNCATE messages, verdicts, analysis_attempts, attachments",
  );
  await pool?.query(
    `INSERT INTO messages
       (id, guild_id, channel_id, user_id, username, content, created_at,
        ai_status, ready_for_work_at, metadata)
     VALUES
       ('1554472364094521397','g1','c1','u1','aira','biji kopi',$1,'pending',0,$2),
       ('1554472364094521398','g1','c1','u2','budi','makan siang',$1,'pending',0,$2)`,
    [
      Date.now(),
      JSON.stringify({
        embeds: [],
        attachments: [],
        stickers: [],
        channel: {
          channelId: "c1",
          channelName: "general",
          topic: "obrolan harian",
          threadId: null,
          threadName: null,
          nsfw: false,
        },
      }),
    ],
  );

  let prompt = "";
  await recordingWorker(
    (c) => {
      prompt = c.user;
    },
    dictionaryDefining({
      biji: { senses: ["isi buah yang dapat ditanam"] },
      makan: { senses: ["memakan makanan pokok"] },
    }),
  ).runOnce();

  // Split on the message boundaries and assert each block carries only its own.
  const blocks = prompt.split(/<message id="/).slice(1);
  expect(blocks.length).toBe(2);

  const bijiBlock = blocks.find((b) => b.startsWith("1554472364094521397"));
  const makanBlock = blocks.find((b) => b.startsWith("1554472364094521398"));
  expect(bijiBlock).toContain('word="biji"');
  expect(bijiBlock).not.toContain('word="makan"');
  expect(makanBlock).toContain('word="makan"');
  expect(makanBlock).not.toContain('word="biji"');

  await pool?.end();
  pool = null;
});

test("no dictionary configured leaves the prompt exactly as it was", async () => {
  if (!(await ensureDb())) return expect(true).toBe(true);
  clearPromptCache();

  await seed("1554472364094521399", "biji kopi");

  let prompt = "";
  let system = "";
  await recordingWorker((c) => {
    prompt = c.user;
    system = c.system;
  }).runOnce();

  expect(prompt).toContain("1554472364094521399");
  expect(prompt).not.toContain("<dictionary>");
  expect(system).not.toContain("KAMUS");

  await pool?.end();
  pool = null;
});

test("a dictionary that fails costs grounding, not the verdict", async () => {
  if (!(await ensureDb())) return expect(true).toBe(true);
  clearPromptCache();

  await seed("1554472364094521400", "biji kopi");

  const broken = new KbbiDictionary(DICT_CFG, (() =>
    Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch);

  let prompt = "";
  let system = "";
  await recordingWorker((c) => {
    prompt = c.user;
    system = c.system;
  }, broken).runOnce();

  // The message still reached the model, and still got an answer.
  expect(prompt).toContain("1554472364094521400");
  expect(prompt).not.toContain("<dictionary>");
  expect(system).not.toContain("KAMUS");

  const { rows } = await (pool as pg.Pool).query(
    "SELECT ai_status FROM messages WHERE id = '1554472364094521400'",
  );
  expect(rows[0]?.ai_status).toBe("analyzed");

  await pool?.end();
  pool = null;
});

test("a non-standard word is marked, so the model knows the sense is not the intended one", async () => {
  if (!(await ensureDb())) return expect(true).toBe(true);
  clearPromptCache();

  await seed("1554472364094521401", "bokap cok");

  let prompt = "";
  await recordingWorker(
    (c) => {
      prompt = c.user;
    },
    dictionaryDefining({ bokap: { senses: ["ayah"], standard: false } }),
  ).runOnce();

  expect(prompt).toContain('<definition word="bokap" standard="false">');

  await pool?.end();
  pool = null;
});

test("no word is marked not_in_dictionary unless the service was actually asked", async () => {
  if (!(await ensureDb())) return expect(true).toBe(true);
  clearPromptCache();

  // Five messages of eight lookable words against a 24-word budget. The stub
  // records every `words=` it was sent, so the test can compare the prompt's
  // <not_in_dictionary> claims against what actually reached the service.
  const asked: string[] = [];
  const spy = new KbbiDictionary(DICT_CFG, ((url: string | URL) => {
    const words = new URL(String(url)).searchParams.getAll("words");
    asked.push(...words);
    // The service answers honestly: it defines none of them.
    return Promise.resolve(
      new Response(
        JSON.stringify({
          results: words.map((w) => ({
            word: w,
            status: "not_found",
            entry: null,
          })),
        }),
        { status: 200 },
      ),
    );
  }) as typeof fetch);

  await (pool as pg.Pool).query(
    "TRUNCATE messages, verdicts, analysis_attempts, attachments",
  );
  // One shared table and these DB tests are not serialised against each other,
  // so this seeds through the file's own helper and asserts only about the word
  // it actually sent. The batch-overflow case — where the budget runs out
  // mid-batch — is covered deterministically in kbbiEvidence.test.ts, where it
  // does not depend on how many rows happen to survive a concurrent truncate.
  await seed(
    "1554472364094529000",
    Array.from({ length: 8 }, (_, i) => `zzq0w${i}`).join(" "),
  );

  let prompt = "";
  await recordingWorker((c) => {
    prompt = c.user;
  }, spy).runOnce();

  expect(asked.length).toBeGreaterThan(0);

  // Every absence the prompt asserts must be one the service really denied.
  const asserted = [
    ...prompt.matchAll(/<not_in_dictionary words="([^"]+)"/g),
  ].flatMap((m) => (m[1] ?? "").split(" "));

  expect(asserted.length).toBeGreaterThan(0);
  for (const word of asserted) expect(asked).toContain(word);
  // No duplicate bookkeeping: the batch was asked once about each word.
  expect(new Set(asserted).size).toBe(asserted.length);

  await pool?.end();
  pool = null;
});
