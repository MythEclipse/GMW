/**
 * D10 regression suite.
 *
 * Each test here corresponds to a real defect in the v1 parser that is now
 * impossible. Run: bun test tests/ (picked up automatically by bunfig preload).
 */
import { describe, expect, test } from "bun:test";
import {
  clampScore,
  extractJson,
  hasDeferralAnalysis,
  parseVerdicts,
} from "../src/modules/ai-moderation/verdictParser.js";

const ids = (...n: number[]) =>
  Array.from({ length: n.length }, (_, i) => `m${n[i]}`);

/** A well-formed response for N messages, all clean. */
function cleanResponse(n: number): string {
  return JSON.stringify({
    results: Array.from({ length: n }, (_, i) => ({
      message_id: `m${i + 1}`,
      status: "clean",
      flags: [],
      analysis: "Tidak ada indikasi pelanggaran.",
      score: 0.02,
      confidence: 0.95,
      recommended_action: "none",
      severity: "none",
    })),
  });
}

describe("D10: a per-message defect must NOT fail the batch", () => {
  // This is the 120x cost multiplier from the audit: one deferral sentence used
  // to throw, discarding 59 valid verdicts and triggering 4 full re-requests
  // plus 60 individual fallbacks.
  test("one deferral analysis degrades only that message", () => {
    const raw = JSON.stringify({
      results: [
        {
          message_id: "m1",
          status: "clean",
          analysis: "Aman.",
          confidence: 0.9,
        },
        {
          message_id: "m2",
          status: "clean",
          // Contains the deferral pattern. v1 threw HERE and lost everything.
          analysis: "perlu ditinjau oleh moderator sebelum dapat ditentukan",
          confidence: 0.9,
        },
        {
          message_id: "m3",
          status: "clean",
          analysis: "Aman.",
          confidence: 0.9,
        },
      ],
    });

    const out = parseVerdicts(raw, ["m1", "m2", "m3"], 1);

    // 3 verdicts returned — not a batch failure.
    expect(out.batchFailed).toBe(false);
    expect(out.verdicts).toHaveLength(3);

    // The two good messages keep their real verdicts.
    expect(out.verdicts[0].status).toBe("clean");
    expect(out.verdicts[0].analysis).toBe("Aman.");
    expect(out.verdicts[2].status).toBe("clean");
    expect(out.verdicts[2].analysis).toBe("Aman.");

    // Only the offender is an error, and it says why.
    const bad = out.verdicts[1];
    expect(bad.status).toBe("error");
    expect(bad.flags).toContain("analysis_deferred");
    expect(bad.perMessageError).toBe("deferred");
  });

  test("a duplicate message_id degrades only the duplicate", () => {
    const raw = JSON.stringify({
      results: [
        {
          message_id: "m1",
          status: "clean",
          analysis: "First.",
          confidence: 0.9,
        },
        {
          message_id: "m1",
          status: "flagged",
          analysis: "Second.",
          confidence: 0.9,
        },
        {
          message_id: "m2",
          status: "clean",
          analysis: "Fine.",
          confidence: 0.9,
        },
      ],
    });

    const out = parseVerdicts(raw, ["m1", "m2"], 1);

    expect(out.batchFailed).toBe(false);
    expect(out.verdicts).toHaveLength(2);
    // First occurrence wins — the model's primary answer, not the batch.
    expect(out.verdicts[0].status).toBe("clean");
    expect(out.verdicts[0].analysis).toBe("First.");
    expect(out.verdicts[1].status).toBe("clean");
  });

  test("a hallucinated extra id cannot overwrite a real verdict", () => {
    const raw = JSON.stringify({
      results: [
        {
          message_id: "m1",
          status: "clean",
          analysis: "Aman.",
          confidence: 0.9,
        },
        {
          message_id: "NOT-REQUESTED",
          status: "flagged",
          analysis: "x",
          confidence: 0.9,
        },
        {
          message_id: "m2",
          status: "clean",
          analysis: "Aman.",
          confidence: 0.9,
        },
      ],
    });

    const out = parseVerdicts(raw, ["m1", "m2"], 1);
    expect(out.verdicts.map((v) => v.messageId)).toEqual(["m1", "m2"]);
    expect(out.verdicts.every((v) => v.status === "clean")).toBe(true);
  });

  test("an invalid status degrades only that message", () => {
    const raw = JSON.stringify({
      results: [
        {
          message_id: "m1",
          status: "clean",
          analysis: "Aman.",
          confidence: 0.9,
        },
        { message_id: "m2", status: "maybe", analysis: "?", confidence: 0.9 },
      ],
    });
    const out = parseVerdicts(raw, ["m1", "m2"], 1);
    expect(out.batchFailed).toBe(false);
    expect(out.verdicts[0].status).toBe("clean");
    expect(out.verdicts[1].status).toBe("error");
    expect(out.verdicts[1].flags).toContain("analysis_invalid_status");
  });

  // Out-of-order responses are normal from an LLM; the caller's ids define order.
  test("verdicts come back in the requested order, not response order", () => {
    const raw = JSON.stringify({
      results: [
        { message_id: "m3", status: "clean", analysis: "c", confidence: 0.9 },
        { message_id: "m1", status: "clean", analysis: "a", confidence: 0.9 },
        { message_id: "m2", status: "clean", analysis: "b", confidence: 0.9 },
      ],
    });
    const out = parseVerdicts(raw, ["m1", "m2", "m3"], 1);
    expect(out.verdicts.map((v) => v.messageId)).toEqual(["m1", "m2", "m3"]);
    expect(out.verdicts.map((v) => v.analysis)).toEqual(["a", "b", "c"]);
  });
});

describe("D10: a real batch failure is still reported as such", () => {
  // Distinguishing these is the point: a broken response must RETRY, not be
  // silently downgraded to 60 "cannot judge" verdicts.
  test("non-JSON response fails the batch (retryable)", () => {
    const out = parseVerdicts("I refuse to answer that.", ["m1", "m2"], 2);
    expect(out.batchFailed).toBe(true);
    expect(out.batchError).toBeDefined();
    expect(out.verdicts.every((v) => v.status === "error")).toBe(true);
  });

  test("JSON without a results array fails the batch", () => {
    const out = parseVerdicts('{"foo": 1}', ["m1"], 1);
    expect(out.batchFailed).toBe(true);
  });

  test("a message the model omitted is reported as missing, not judged clean", () => {
    const raw = JSON.stringify({
      results: [
        {
          message_id: "m1",
          status: "clean",
          analysis: "Aman.",
          confidence: 0.9,
        },
      ],
    });
    const out = parseVerdicts(raw, ["m1", "m2", "m3"], 1);
    expect(out.batchFailed).toBe(false);
    expect(out.missing).toEqual(["m2", "m3"]);
    // m1 is judged; m2/m3 are absent so the caller keeps them queued.
    expect(out.verdicts).toHaveLength(1);
  });
});

describe("normalisation preserves policy behaviour", () => {
  test("severity is derived from score when the model omits it", () => {
    const raw = JSON.stringify({
      results: [
        {
          message_id: "m1",
          status: "flagged",
          score: 0.9,
          analysis: "x",
          confidence: 0.9,
        },
        {
          message_id: "m2",
          status: "flagged",
          score: 0.5,
          analysis: "x",
          confidence: 0.9,
        },
        {
          message_id: "m3",
          status: "clean",
          score: 0.0,
          analysis: "x",
          confidence: 0.9,
        },
      ],
    });
    const out = parseVerdicts(raw, ["m1", "m2", "m3"], 1);
    expect(out.verdicts[0].severity).toBe("critical");
    expect(out.verdicts[1].severity).toBe("medium");
    expect(out.verdicts[2].severity).toBe("none");
  });

  test("confidence falls back to score-derived defaults when omitted", () => {
    const raw = JSON.stringify({
      results: [
        { message_id: "m1", status: "flagged", score: 0.9, analysis: "x" },
        { message_id: "m2", status: "warn", analysis: "x" },
      ],
    });
    const out = parseVerdicts(raw, ["m1", "m2"], 1);
    expect(out.verdicts[0].confidence).toBeGreaterThanOrEqual(0.8);
    expect(out.verdicts[1].confidence).toBe(0.6);
  });

  test("categories default to flags when the model omits them", () => {
    const raw = JSON.stringify({
      results: [
        {
          message_id: "m1",
          status: "flagged",
          flags: ["harassment"],
          analysis: "x",
          confidence: 0.9,
        },
      ],
    });
    const out = parseVerdicts(raw, ["m1"], 1);
    expect(out.verdicts[0].categories).toEqual(["harassment"]);
  });

  test("an out-of-range confidence is clamped, not trusted", () => {
    const raw = JSON.stringify({
      results: [
        { message_id: "m1", status: "flagged", confidence: 7, analysis: "x" },
      ],
    });
    const out = parseVerdicts(raw, ["m1"], 1);
    expect(out.verdicts[0].confidence).toBe(1);
  });
});

describe("helpers", () => {
  test("extractJson finds fenced JSON", () => {
    expect(extractJson('```json\n{"results":[]}\n```')).toEqual({
      results: [],
    });
  });

  test("extractJson finds JSON buried in prose", () => {
    expect(
      extractJson('Sure! Here you go: {"results":[1]} hope that helps'),
    ).toEqual({ results: [1] });
  });

  test("extractJson handles nested braces and escaped quotes", () => {
    const s = 'noise {"a":{"b":"} not the end"},"c":[1,2]} trailing';
    expect(extractJson(s)).toEqual({ a: { b: "} not the end" }, c: [1, 2] });
  });

  test("extractJson throws only when there is genuinely no JSON", () => {
    expect(() => extractJson("no json here")).toThrow();
  });

  test("deferral detection keeps the v1 exception carve-out", () => {
    expect(hasDeferralAnalysis("perlu ditinjau oleh moderator")).toBe(true);
    expect(
      hasDeferralAnalysis(
        "tidak bisa menentukan karena tidak ada(indikasi|pelanggaran|masalah)",
      ),
    ).toBe(false);
    expect(hasDeferralAnalysis("bersih dan normal")).toBe(false);
  });

  test("clampScore bounds to [0,1] and falls back on junk", () => {
    expect(clampScore(0.5)).toBe(0.5);
    expect(clampScore(-3)).toBe(0);
    expect(clampScore(9)).toBe(1);
    expect(clampScore("nope", 0.42)).toBe(0.42);
    expect(clampScore(undefined)).toBe(0);
  });
});
