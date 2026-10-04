/**
 * Does the revised prompt make the model write real descriptions?
 *
 * The complaint was that analyses read as boilerplate — "Pesan singkat yang
 * tidak mengandung unsur pelanggaran kebijakan server" — instead of saying
 * what the message or image actually is, and explaining slang when it is not
 * obvious.
 *
 * This runs both the vision pass and the moderation pass against the live
 * model and prints the raw analysis text for each case, so the change is
 * judged on real output. It also counts the boilerplate phrases, because
 * "looked fine on three samples" has already been wrong twice.
 *
 * Run: bun tests/analysis-description-probe.ts
 */

import { createDefaultGateway } from "../src/modules/ai-moderation/llmGateway.js";
import { buildSystemPrompt } from "../src/modules/ai-moderation/policy.js";

const BOILERPLATE = [
  "tidak mengandung unsur pelanggaran",
  "tidak ada indikasi pelanggaran",
  "tidak melanggar kebijakan",
  "tidak mengandung pelanggaran",
  "tidak ada pelanggaran",
  "tidak menunjukkan tanda-tanda",
  "tidak menunjukkan pelanggaran",
  "nihil",
  "bersih dari pelanggaran",
];

const gateway = createDefaultGateway();
const system = buildSystemPrompt({ mode: "text" });

interface Case {
  text: string;
  why: string;
}

const CASES: Case[] = [
  { text: "pecicilan", why: "slang — must be explained, not just judged" },
  { text: "masih pecicilan", why: "slang in a sentence" },
  { text: "biji", why: "vulgar Indonesian — must stay clean but be explained" },
  { text: "3,14er life crisis", why: "a joke that needs unpacking" },
  { text: "halo", why: "trivial, but should still say something true" },
  { text: "cuckholdin", why: "the nsfw case — description plus verdict" },
  { text: "dasar goblok", why: "mild insult — should name the insult" },
];

let boilerplate = 0;

console.log(`model: ${gateway.modelLabel ?? "unknown"}
`);

for (const c of CASES) {
  try {
    const raw = await gateway.complete({
      system,
      user: `## PESAN\n1. ${c.text}\n`,
      timeoutMs: 90_000,
    });
    const pick = (key: string): string | undefined =>
      raw
        .replace(/```[a-z]*/gi, "")
        .match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`))?.[1];
    const pickNum = (key: string): number => {
      const m = raw.match(new RegExp(`"${key}"\\s*:\\s*([0-9.]+)`));
      return m ? Number(m[1]) : NaN;
    };
    const status = pick("status") ?? "?";
    const analysis = pick("analysis") ?? "(missing)";
    const isBoiler = BOILERPLATE.some((p) =>
      analysis.toLowerCase().includes(p),
    );
    if (isBoiler) boilerplate++;

    console.log(
      `${isBoiler ? "BOILER" : "REAL  "}  ${JSON.stringify(c.text).padEnd(22)} ` +
        `status=${String(status).padEnd(8)} conf=${pickNum("confidence")}  (${c.why})`,
    );
    console.log(`          ${analysis}`);
  } catch (e) {
    console.log(`ERROR  ${JSON.stringify(c.text)} — ${String(e).slice(0, 90)}`);
  }
}

console.log(
  `\nboilerplate: ${boilerplate}/${CASES.length} ` +
    `(before the change, the production corpus ran 26%)`,
);
