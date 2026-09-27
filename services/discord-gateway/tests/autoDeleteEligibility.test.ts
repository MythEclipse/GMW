/**
 * Auto-delete eligibility rules.
 *
 * Revived from the pre-rewrite `autoDeleteEligibility.test.ts` (deleted in
 * 2658b0dd) and rewritten against `bun:test`, the runner this repo uses now.
 *
 * The input changed shape: the old tests set `ai_status: "flagged"` on a
 * message. After the rewrite that column only means "the worker finished", so
 * these tests set `verdict.status` instead — the field that actually carries
 * the judgement. A test that still passed on the old shape would prove
 * nothing about the live path.
 */
import { describe, expect, test } from "bun:test";
import {
  deriveRecommendedAction,
  deriveSeverity,
  isEligibleForAutoDelete,
  isNicknameOnlyViolation,
  parseStringList,
  type MessageLike,
  type VerdictLike,
} from "../src/modules/ai-moderation/autoDeleteEligibility.js";

function msg(overrides: Partial<MessageLike> = {}): MessageLike {
  return {
    id: "m1",
    guild_id: "g1",
    channel_id: "c1",
    user_id: "u1",
    thread_id: null,
    ...overrides,
  };
}

function verdict(overrides: Partial<VerdictLike> = {}): VerdictLike {
  return {
    status: "flagged",
    severity: "high",
    confidence: 0.95,
    score: 0.95,
    recommended_action: "delete",
    categories: ["harassment"],
    flags: ["harassment"],
    analysis: "contains abusive language directed at another member",
    ...overrides,
  };
}

describe("parseStringList", () => {
  test("splits comma-separated config values", () => {
    expect(parseStringList("a, b ,c")).toEqual(["a", "b", "c"]);
  });

  test("accepts a JSON array", () => {
    expect(parseStringList('["a","b"]')).toEqual(["a", "b"]);
  });

  test("empty and null yield an empty list", () => {
    expect(parseStringList("")).toEqual([]);
    expect(parseStringList(null)).toEqual([]);
  });

  test("falls back to comma splitting on malformed JSON", () => {
    expect(parseStringList("[broken, b")).toEqual(["[broken", "b"]);
  });
});

describe("deriveSeverity", () => {
  test("uses the stored severity when present", () => {
    expect(deriveSeverity(msg(), verdict({ severity: "critical" }))).toBe(
      "critical",
    );
  });

  // confidence is checked before score, so clear it when testing the score
  // thresholds — otherwise the default 0.95 from `verdict()` wins and every
  // case resolves to "critical".
  test("derives from score for a flagged verdict with no severity", () => {
    expect(
      deriveSeverity(
        msg(),
        verdict({ severity: null, confidence: null, score: 0.95 }),
      ),
    ).toBe("critical");
    expect(
      deriveSeverity(
        msg(),
        verdict({ severity: null, confidence: null, score: 0.75 }),
      ),
    ).toBe("high");
    expect(
      deriveSeverity(
        msg(),
        verdict({ severity: null, confidence: null, score: 0.2 }),
      ),
    ).toBe("medium");
  });

  test("a clean verdict is severity none", () => {
    expect(
      deriveSeverity(msg(), verdict({ status: "clean", severity: null })),
    ).toBe("none");
  });
});

describe("deriveRecommendedAction", () => {
  // This is the rule that matters most: the model is conservative and often
  // says "review" for genuinely severe content. Severity has to win.
  test("flagged + high severity is always delete, whatever the model said", () => {
    expect(
      deriveRecommendedAction(
        msg(),
        verdict({ severity: "high", recommended_action: "review" }),
      ),
    ).toBe("delete");
    expect(
      deriveRecommendedAction(
        msg(),
        verdict({ severity: "critical", recommended_action: "monitor" }),
      ),
    ).toBe("delete");
  });

  test("flagged at medium severity keeps the model's answer", () => {
    expect(
      deriveRecommendedAction(
        msg(),
        verdict({ severity: "medium", recommended_action: "review" }),
      ),
    ).toBe("review");
  });

  // A warn verdict only reaches its own branch when severity is not
  // high/critical — a warn at high severity is deliberately promoted to
  // delete, the same rule flagged messages follow. Both cases below pass
  // recommended_action: "review" explicitly, because the stored value wins
  // when severity is not severe enough to override it.
  test("warn at low severity keeps the model's answer", () => {
    expect(
      deriveRecommendedAction(
        msg(),
        verdict({
          status: "warn",
          severity: "low",
          confidence: 0.3,
          score: 0.3,
          recommended_action: "review",
        }),
      ),
    ).toBe("review");
  });

  test("warn with no stored action falls back to warn", () => {
    expect(
      deriveRecommendedAction(
        msg(),
        verdict({
          status: "warn",
          severity: "low",
          confidence: 0.3,
          score: 0.3,
          recommended_action: null,
        }),
      ),
    ).toBe("warn");
  });

  test("warn at high severity is promoted to delete", () => {
    expect(
      deriveRecommendedAction(
        msg(),
        verdict({
          status: "warn",
          severity: "high",
          recommended_action: "review",
        }),
      ),
    ).toBe("delete");
  });
});

describe("isEligibleForAutoDelete", () => {
  test("a flagged high-severity message is eligible", () => {
    expect(isEligibleForAutoDelete(msg(), verdict())).toBe(true);
  });

  test("a clean message is never eligible", () => {
    expect(
      isEligibleForAutoDelete(msg(), verdict({ status: "clean" })),
    ).toBe(false);
  });

  test("an error verdict is never eligible", () => {
    expect(
      isEligibleForAutoDelete(msg(), verdict({ status: "error" })),
    ).toBe(false);
  });

  // The regression this guards: an `analyzed` message with a flagged verdict
  // must still be deletable. After the rewrite `analyzed` is the pipeline's
  // terminal state, so gating on it (as the old code did) would silently stop
  // every deletion.
  test("a verdict is judged on its own status, not the pipeline's", () => {
    const m = msg({ ai_status: "analyzed" });
    expect(isEligibleForAutoDelete(m, verdict())).toBe(true);
  });

  test("confidence below the threshold is rejected", () => {
    expect(
      isEligibleForAutoDelete(
        msg(),
        verdict({ confidence: 0, score: 0, severity: "high" }),
      ),
    ).toBe(false);
  });

  test("falls back to legacy ai_* columns when no verdict row exists", () => {
    const legacy = msg({
      ai_status: "flagged",
      ai_severity: "high",
      ai_confidence: 0.99,
      ai_recommended_action: "delete",
    });
    expect(isEligibleForAutoDelete(legacy, null)).toBe(true);
  });

  test("a pending message with no verdict is not eligible", () => {
    expect(isEligibleForAutoDelete(msg({ ai_status: "pending" }), null)).toBe(
      false,
    );
  });
});

describe("isNicknameOnlyViolation", () => {
  test("an offensive_username-only flag is a nickname violation", () => {
    expect(
      isNicknameOnlyViolation(
        msg(),
        verdict({ flags: ["offensive_username"] }),
      ),
    ).toBe(true);
  });

  test("a content flag is not a nickname violation", () => {
    expect(
      isNicknameOnlyViolation(msg(), verdict({ flags: ["harassment"] })),
    ).toBe(false);
  });

  test("no flags at all is not a nickname violation", () => {
    expect(isNicknameOnlyViolation(msg(), verdict({ flags: [] }))).toBe(false);
  });

  test("username-attributable flags plus corroborating analysis text", () => {
    expect(
      isNicknameOnlyViolation(
        msg(),
        verdict({
          flags: ["offensive_username", "identity_attack"],
          analysis: "username mengandung katatofensif; isi pesan bersih",
        }),
      ),
    ).toBe(true);
  });

  test("username-attributable flags but analysis blames the content", () => {
    expect(
      isNicknameOnlyViolation(
        msg(),
        verdict({
          flags: ["offensive_username", "identity_attack"],
          analysis: "isi pesan mengandung kata kasar yang=swap dan juga umpan",
        }),
      ),
    ).toBe(false);
  });
});
