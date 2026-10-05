import { describe, expect, test } from "bun:test";
import {
  normaliseAction,
  parseVerdicts,
} from "../src/modules-gateway/ai-moderation/verdictParser.js";

/**
 * `action` is the field the model uses to say WHICH enforcement should happen.
 * Before it existed the enforcer had to infer that from the `analysis` prose,
 * which is how a verdict reading "Nickname mengandung sindiran pribadi; isi
 * pesan bersih" still produced action_type=delete_message: the message died and
 * the name survived.
 *
 * The rule these tests pin down is the asymmetry — an unparseable action must
 * fall back to `status`, never the other way round. Defaulting a `deleted`
 * verdict to `clean` would silently stop every deletion the first time a model
 * ignored the new field.
 */
describe("verdict action — the model names the disposition", () => {
  test("the three legal values pass through", () => {
    expect(normaliseAction("clean")).toBe("clean");
    expect(normaliseAction("delete_message")).toBe("delete_message");
    expect(normaliseAction("reset_nickname")).toBe("reset_nickname");
  });

  test("whitespace is tolerated, case is not invented", () => {
    expect(normaliseAction("  delete_message  ")).toBe("delete_message");
    expect(normaliseAction("DELETE_MESSAGE")).toBeNull();
  });

  test("anything else is rejected rather than guessed", () => {
    // `warn`/`mute`/`kick`/`ban` were removed from this system entirely; a
    // model still emitting one must not be able to route a verdict anywhere.
    for (const bogus of [
      "ban_user",
      "mute_user",
      "warn_user",
      "kick_user",
      "delete",
      "review",
      "",
      null,
      undefined,
      42,
      { action: "clean" },
    ]) {
      expect(normaliseAction(bogus)).toBeNull();
    }
  });

  test("the fallback is derived from status alone, not from the model", () => {
    // `actionFromStatus` is module-private, so it is exercised through the
    // public parse path: `status` alone decides when no valid action is named.
    const deleted = parseVerdicts(
      JSON.stringify({
        results: [
          {
            message_id: "1",
            status: "deleted",
            reason: "x",
            analysis: "x",
          },
        ],
      }),
      ["1"],
      1,
    ).verdicts[0];
    expect(deleted?.action).toBe("delete_message");

    const clean = parseVerdicts(
      JSON.stringify({
        results: [{ message_id: "2", status: "clean", analysis: "x" }],
      }),
      ["2"],
      1,
    ).verdicts[0];
    expect(clean?.action).toBe("clean");
  });
});

describe("parseVerdicts — action parsing and reconciliation", () => {
  // `ParseBatchResult.verdicts` is an array, not a Map.
  const parseOne = (raw: Record<string, unknown>) =>
    parseVerdicts(
      JSON.stringify({ results: [{ message_id: "1", ...raw }] }),
      ["1"],
      1,
    ).verdicts[0];

  test("a valid action is carried through", () => {
    const v = parseOne({
      status: "deleted",
      action: "reset_nickname",
      reason: "nickname kasar; isi pesan bersih",
      flags: ["offensive_nickname"],
      confidence: 0.9,
      score: 0.55,
      analysis: "Nickname mengandung kata kasar.",
    });
    expect(v?.status).toBe("deleted");
    expect(v?.action).toBe("reset_nickname");
  });

  test("a model that ignores the field falls back to the shipped behaviour", () => {
    // This is the load-bearing case: an older model, or one that drops the new
    // key, must still delete a deleted verdict rather than silently keep it.
    const v = parseOne({
      status: "deleted",
      reason: "hinaan langsung",
      flags: ["harassment"],
      confidence: 0.9,
      score: 0.7,
      analysis: "Hinaan langsung.",
    });
    expect(v?.action).toBe("delete_message");
  });

  test("an invented action cannot downgrade a deletion to a keep", () => {
    const v = parseOne({
      status: "deleted",
      action: "definitely_not_an_action",
      reason: "hinaan",
      flags: ["harassment"],
      confidence: 0.9,
      score: 0.7,
      analysis: "Hinaan langsung.",
    });
    expect(v?.action).toBe("delete_message");
    expect(v?.status).toBe("deleted");
  });

  test("reset_nickname paired with a clean status keeps BOTH as written", () => {
    // Deliberate, and the reason is ordering in autoDeleteManager: the
    // `modelAction === "reset_nickname"` branch runs BEFORE `status` is ever
    // consulted, and `isEligibleForAutoDelete` reads `status` — which is
    // `clean` here, so the message is kept. That is the whole point of the
    // field: a name-only violation is a verdict that deletes nothing.
    //
    // Promoting `status` to `deleted` instead would be actively wrong: the
    // feed card renders `status`, so every nickname reset would be displayed
    // as a deleted message while the message is still live in the channel.
    const v = parseOne({
      status: "clean",
      action: "reset_nickname",
      flags: ["offensive_nickname"],
      confidence: 0.9,
      score: 0.55,
      analysis: "Nickname mengandung kata kasar; isi pesan bersih.",
    });
    expect(v?.action).toBe("reset_nickname");
    expect(v?.status).toBe("clean");
  });

  test("an error verdict falls back to the clean disposition", () => {
    // `error` means "could not judge" — not evidence of a violation — so it
    // must never authorise enforcement. The derived action is `clean` here,
    // which is inert. The worker separately stores NULL for an error verdict,
    // so the column is honest about there being no disposition.
    const out = parseVerdicts(
      JSON.stringify({ results: [{ message_id: "1", status: "bogus" }] }),
      ["1"],
      1,
    );
    const v = out.verdicts[0];
    expect(v?.status).toBe("error");
    expect(v?.action).toBe("clean");
  });
});
