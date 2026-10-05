/**
 * D10 regression suite.
 *
 * Each test here corresponds to a real defect in the v1 parser that is now
 * impossible. Run: bun test tests/ (picked up automatically by bunfig preload).
 */
import { describe, expect, test } from "vitest";
import {
  clampScore,
  extractJson,
  hasDeferralAnalysis,
  normaliseAction,
  parseVerdicts,
  resolveAction,
  VERDICT_ACTIONS,
} from "../src/modules-gateway/ai-moderation/verdictParser.js";

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

describe("action: the model chooses the disposition", () => {
  // `status` answers "is this a violation". It cannot answer "the violation is
  // in the member's NAME and the message should stay", because a message that
  // stays is not a `clean` verdict either. Until now that intent was recovered
  // by regex-matching the model's own prose, and production defeated it: user
  // 1052035456688205854, nickname "adit cuking", body "Nandayo" -> the MESSAGE
  // was deleted and the nickname left alone.

  function one(
    entry: Record<string, unknown>,
  ): ReturnType<typeof parseVerdicts> {
    return parseVerdicts(JSON.stringify({ results: [entry] }), ["m1"], 1);
  }

  test("the three documented values are accepted verbatim", () => {
    for (const action of ["clean", "delete_message", "reset_nickname"]) {
      const out = one({
        message_id: "m1",
        status: action === "clean" ? "clean" : "deleted",
        action,
        analysis: "x",
      });
      expect(out.batchFailed).toBe(false);
      expect(out.verdicts[0].action).toBe(action);
      expect(out.verdicts[0].perMessageError).toBeUndefined();
    }
  });

  test("surrounding whitespace is tolerated", () => {
    // Models emit " reset_nickname" often enough that a strict compare would
    // silently drop the only disposition the column exists to carry.
    const out = one({
      message_id: "m1",
      status: "deleted",
      action: "  reset_nickname\n",
      analysis: "x",
    });
    expect(out.verdicts[0].action).toBe("reset_nickname");
  });

  // The invalid case must degrade the DISPOSITION, never the verdict: one
  // hallucinated field must not cost a judgement whose `status` was fine.
  test("an unrecognised action falls back to the status-derived value", () => {
    for (const action of [
      "warn",
      "review",
      "reset",
      "delete",
      "resetnickname",
      "RESET_NICKNAME",
      "hapus nickname",
      "",
      123,
      null,
      true,
      ["reset_nickname"],
      { toString: () => "reset_nickname" },
    ]) {
      const out = one({
        message_id: "m1",
        status: "deleted",
        action,
        analysis: "x",
      });
      expect(out.verdicts[0].status).toBe("deleted");
      expect(out.verdicts[0].action).toBe("delete_message");
    }
  });

  test("a missing action falls back to exactly the pre-action behaviour", () => {
    // This is the upgrade path: a model that ignores the new field, and every
    // row written before the column existed, must behave identically to before.
    expect(
      one({ message_id: "m1", status: "deleted", analysis: "x" }).verdicts[0]
        .action,
    ).toBe("delete_message");
    expect(
      one({ message_id: "m1", status: "clean", analysis: "x" }).verdicts[0]
        .action,
    ).toBe("clean");
  });

  // A bad disposition is NOT a reason to throw or to error the verdict. That is
  // the D10 rule: one message's defect must never cost its siblings' verdicts.
  test("an invalid action never errors the verdict or fails the batch", () => {
    const raw = JSON.stringify({
      results: [
        { message_id: "m1", status: "clean", action: "clean", analysis: "a" },
        {
          message_id: "m2",
          status: "deleted",
          action: "maybe_reset",
          reason: "hinaan",
          analysis: "b",
        },
        {
          message_id: "m3",
          status: "clean",
          action: "nonsense",
          analysis: "perlu ditinjau oleh moderator",
        },
      ],
    });
    const out = parseVerdicts(raw, ["m1", "m2", "m3"], 1);
    expect(out.batchFailed).toBe(false);
    expect(out.verdicts.map((v) => v.status)).toEqual([
      "clean",
      "deleted",
      "error",
    ]);
    expect(out.verdicts[1].perMessageError).toBeUndefined();
  });

  test("an error verdict carries action clean, never a deletion", () => {
    // Every error path must be inert: `status: "error"` already blocks
    // enforcement, and an `action` of `delete_message` on the same verdict would
    // be a second field claiming authority it cannot have.
    for (const status of ["warn", "flagged", "error", "maybe"]) {
      expect(
        one({ message_id: "m1", status, analysis: "x" }).verdicts[0].action,
      ).toBe("clean");
    }
    // And the deferral path, which builds its own error verdict.
    const deferred = one({
      message_id: "m1",
      status: "deleted",
      action: "delete_message",
      analysis: "perlu ditinjau oleh admin",
    });
    expect(deferred.verdicts[0].status).toBe("error");
    expect(deferred.verdicts[0].action).toBe("clean");
  });

  // `reset_nickname` is the one disposition `status` cannot express, so it is
  // the one that must survive a contradicting status — it deletes nothing.
  test("reset_nickname survives a clean status", () => {
    const out = one({
      message_id: "m1",
      status: "clean",
      action: "reset_nickname",
      analysis: "nickname mengandung kata kasar; isi pesan bersih",
    });
    expect(out.verdicts[0].status).toBe("clean");
    expect(out.verdicts[0].action).toBe("reset_nickname");
  });

  // The converse is forced, and the reason is the point: honouring a `clean`
  // beside `status: "deleted"` would mean one inconsistent response silently
  // switches enforcement off — the 0025 failure of flagged verdicts sitting
  // unenforced, which is what "membiarkan pesan" looks like.
  test("clean beside deleted collapses to delete_message, never the reverse", () => {
    const out = one({
      message_id: "m1",
      status: "deleted",
      action: "clean",
      reason: "hinaan",
      analysis: "x",
    });
    expect(out.verdicts[0].status).toBe("deleted");
    expect(out.verdicts[0].action).toBe("delete_message");
  });

  test("normaliseAction recognises exactly the documented three", () => {
    expect(VERDICT_ACTIONS).toEqual([
      "clean",
      "delete_message",
      "reset_nickname",
    ]);
    for (const good of VERDICT_ACTIONS) {
      expect(normaliseAction(good)).toBe(good);
    }
    for (const bad of ["warn", "", " ", null, undefined, 1, {}, []]) {
      expect(normaliseAction(bad)).toBeNull();
    }
  });

  test("resolveAction is the single rule both fields agree on", () => {
    expect(resolveAction(null, "deleted")).toBe("delete_message");
    expect(resolveAction(null, "clean")).toBe("clean");
    expect(resolveAction(null, "error")).toBe("clean");
    expect(resolveAction("reset_nickname", "clean")).toBe("reset_nickname");
    expect(resolveAction("reset_nickname", "deleted")).toBe("reset_nickname");
    expect(resolveAction("clean", "deleted")).toBe("delete_message");
    expect(resolveAction("delete_message", "clean")).toBe("clean");
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
