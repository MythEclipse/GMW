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
          status: "deleted",
          reason: "second answer says delete",
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
          status: "deleted",
          reason: "a deletion we never asked for",
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
  // The score-derived severity ladder is gone with the column. What replaced it
  // is that `status` alone IS the decision, so the only score-shaped thing left
  // is the confidence floor a deletion is held to.
  test("a deleted verdict's confidence is floored at 0.8 when the model omits it", () => {
    const raw = JSON.stringify({
      results: [
        { message_id: "m1", status: "deleted", score: 0.9, analysis: "x" },
        { message_id: "m2", status: "deleted", score: 0.5, analysis: "x" },
        // A low score must NOT pull the confidence down below the floor: the
        // model already said "delete", and confidence is how sure it was.
        { message_id: "m3", status: "deleted", score: 0.05, analysis: "x" },
      ],
    });
    const out = parseVerdicts(raw, ["m1", "m2", "m3"], 1);
    expect(out.verdicts.map((v) => v.status)).toEqual([
      "deleted",
      "deleted",
      "deleted",
    ]);
    expect(out.verdicts[0].confidence).toBe(0.9);
    expect(out.verdicts[1].confidence).toBe(0.8);
    expect(out.verdicts[2].confidence).toBe(0.8);
  });

  test("a clean verdict with no confidence defaults to 0.9, not to its score", () => {
    const raw = JSON.stringify({
      results: [
        { message_id: "m1", status: "clean", score: 0.0, analysis: "x" },
        { message_id: "m2", status: "clean", analysis: "x" },
      ],
    });
    const out = parseVerdicts(raw, ["m1", "m2"], 1);
    // Both answers are "clean", so both are certain the message is fine; a
    // near-zero score must not make the model look unsure about that.
    expect(out.verdicts[0].confidence).toBe(0.9);
    expect(out.verdicts[1].confidence).toBe(0.9);
  });

  test("categories default to flags when the model omits them", () => {
    const raw = JSON.stringify({
      results: [
        {
          message_id: "m1",
          status: "deleted",
          reason: "harassment",
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
        {
          message_id: "m1",
          status: "deleted",
          reason: "x",
          confidence: 7,
          analysis: "x",
        },
      ],
    });
    const out = parseVerdicts(raw, ["m1"], 1);
    expect(out.verdicts[0].confidence).toBe(1);
  });
});

describe("status is the whole decision", () => {
  // `severity` and the six-valued `recommended_action` are both gone, so a
  // deletion cannot be softened by a second field the model also controls.
  test("a deleted verdict keeps the reason the model gave as the cause", () => {
    const raw = JSON.stringify({
      results: [
        {
          message_id: "m1",
          status: "deleted",
          reason: "hinaan langsung pada pengguna lain",
          analysis: "x",
          confidence: 0.9,
        },
      ],
    });
    const out = parseVerdicts(raw, ["m1"], 1);
    expect(out.verdicts[0].status).toBe("deleted");
    expect(out.verdicts[0].reason).toBe("hinaan langsung pada pengguna lain");
  });

  // `verdicts_reason_check` requires a non-empty reason for every deletion, so
  // the parser must never emit a `deleted` verdict without one.
  test("a deletion with no stated reason falls back to the analysis, never empty", () => {
    const raw = JSON.stringify({
      results: [
        {
          message_id: "m1",
          status: "deleted",
          analysis: "memuat tautan ke domain patterning",
          confidence: 0.9,
        },
      ],
    });
    const out = parseVerdicts(raw, ["m1"], 1);
    expect(out.verdicts[0].status).toBe("deleted");
    expect(out.verdicts[0].reason).toBe(out.verdicts[0].analysis);
    expect(out.verdicts[0].reason).not.toBe("");
  });

  // The safety property the two-value contract buys: a value we do not
  // understand is a keep, never a deletion on a guess.
  test("'warn' and 'flagged' are no longer accepted outcomes — both are errors", () => {
    const raw = JSON.stringify({
      results: [
        { message_id: "m1", status: "warn", analysis: "x", confidence: 0.95 },
        {
          message_id: "m2",
          status: "flagged",
          analysis: "x",
          confidence: 0.95,
        },
      ],
    });
    const out = parseVerdicts(raw, ["m1", "m2"], 1);
    expect(out.verdicts[0].status).toBe("error");
    expect(out.verdicts[0].perMessageError).toBe("invalid_status");
    expect(out.verdicts[1].status).toBe("error");
    expect(out.verdicts[1].perMessageError).toBe("invalid_status");
    // Confidence is forced to 0 so a stale high value cannot imply the model
    // was sure about a status we refused to accept.
    expect(out.verdicts[0].confidence).toBe(0);
    expect(out.verdicts[1].confidence).toBe(0);
  });

  test("'error' is not a value the model may return — it is derived, not read", () => {
    const raw = JSON.stringify({
      results: [
        { message_id: "m1", status: "error", analysis: "x", confidence: 0.9 },
      ],
    });
    const out = parseVerdicts(raw, ["m1"], 1);
    // `STATUSES` is exactly {clean, deleted}. `error` is not in it, so a model
    // that tries to report "could not judge" as a status is treated like any
    // other unknown value — and lands on the same error verdict, from the same
    // code path, with confidence forced to 0. There is no way for the model to
    // hand us an outcome the pipeline did not derive itself.
    expect(out.verdicts[0].status).toBe("error");
    expect(out.verdicts[0].perMessageError).toBe("invalid_status");
    expect(out.verdicts[0].confidence).toBe(0);
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
