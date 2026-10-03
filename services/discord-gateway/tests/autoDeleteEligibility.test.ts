/**
 * Auto-delete eligibility rules.
 *
 * Revived from the pre-rewrite `autoDeleteEligibility.test.ts` (deleted in
 * 2658b0dd) and rewritten against `bun:test`, the runner this repo uses now.
 *
 * The input changed shape twice. The old tests set `ai_status: "flagged"` on a
 * message; after the 0020 rewrite that column only means "the worker
 * finished", so these tests set `verdict.status` instead — the field that
 * actually carries the judgement. Then `severity` and the six-valued
 * `recommended_action` were deleted, taking `deriveSeverity` and
 * `deriveRecommendedAction` with them: there is nothing left to derive, because
 * `status` is the whole decision and the pipeline is full auto.
 *
 * That is why the suites below replaced the two derivation suites rather than
 * re-asserting them. Each replacement keeps the original question ("is this
 * guarded?") and points it at the gate that now exists — confidence, evidence,
 * and the allow-lists — instead of at a tier that no longer does.
 */
import { describe, expect, test } from "bun:test";
import {
  isEligibleForAutoDelete,
  isNicknameOnlyViolation,
  type MessageLike,
  parseStringList,
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
    status: "deleted",
    confidence: 0.95,
    score: 0.95,
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

describe("status alone decides eligibility", () => {
  // This is the rule that matters most now: the model says "delete" or it does
  // not, and the operator decided the pipeline is full auto. There is no tier
  // that can hold a deletion back and no field that can promote one.
  test("a deleted verdict is eligible once the evidence gates pass", () => {
    expect(isEligibleForAutoDelete(msg(), verdict())).toBe(true);
  });

  test("a clean verdict is never eligible", () => {
    expect(isEligibleForAutoDelete(msg(), verdict({ status: "clean" }))).toBe(
      false,
    );
  });

  // The middle tier is gone rather than merged into `deleted`. A verdict that
  // says "warn" is not a soft deletion waiting for a review — it is a value the
  // parser never emits, and the enforcer must not act on one if it ever sees it.
  test("an unknown status is never eligible, not even a warn/flagged-shaped one", () => {
    for (const status of ["warn", "flagged", "", "DELETED", "review"]) {
      expect(isEligibleForAutoDelete(msg(), verdict({ status }))).toBe(false);
    }
  });

  test("an error verdict is never eligible", () => {
    // "Could not judge" is not evidence of a violation, and deleting on it is
    // unrecoverable: the content is gone and the judgement never happened.
    expect(isEligibleForAutoDelete(msg(), verdict({ status: "error" }))).toBe(
      false,
    );
  });

  // The regression this guards: an `analyzed` message with a deleted verdict
  // must still be deletable. After the rewrite `analyzed` is the pipeline's
  // terminal state, so gating on it (as the old code did) would silently stop
  // every deletion.
  test("a verdict is judged on its own status, not the pipeline's", () => {
    const m = msg({ ai_status: "analyzed" });
    expect(isEligibleForAutoDelete(m, verdict())).toBe(true);
  });

  // A confidence gate is not a severity tier: it does not decide WHETHER a
  // violation occurred, only whether the model was sure enough for the removal
  // to be automatic. So it must survive the removal of severity intact.
  test("a deleted verdict at low confidence is not eligible", () => {
    // This replaces the deleted `deriveSeverity` score-threshold suite. The
    // question those tests asked — "is this bad enough?" — is answered by
    // `status` alone now, so the surviving question is "was the model sure?",
    // and the answer still has to gate the delete.
    expect(
      isEligibleForAutoDelete(
        msg(),
        verdict({ confidence: 0.49, score: 0.49 }),
      ),
    ).toBe(false);
    // Boundary: AUTO_DELETE_MIN_CONFIDENCE defaults to 0.5, and the gate is
    // `< threshold`, so exactly at the bar still deletes.
    expect(
      isEligibleForAutoDelete(msg(), verdict({ confidence: 0.5, score: 0.5 })),
    ).toBe(true);
  });

  test("confidence falls back to score when the verdict carries no confidence", () => {
    expect(
      isEligibleForAutoDelete(msg(), verdict({ confidence: null, score: 0.9 })),
    ).toBe(true);
    expect(
      isEligibleForAutoDelete(msg(), verdict({ confidence: null, score: 0.1 })),
    ).toBe(false);
  });

  test("a deleted verdict with neither confidence nor score is not eligible", () => {
    expect(
      isEligibleForAutoDelete(
        msg(),
        verdict({ confidence: null, score: null }),
      ),
    ).toBe(false);
  });

  test("falls back to legacy ai_* columns when no verdict row exists", () => {
    // Legacy `messages.ai_*` is only consulted for rows the backfill has not
    // reached. `readVerdict` maps `ai_status` onto `status`, so an
    // already-analysed legacy row reads its judgement from `ai_status`.
    const legacy = msg({
      ai_status: "deleted",
      ai_confidence: 0.99,
      ai_categories: "harassment",
    });
    expect(isEligibleForAutoDelete(legacy, null)).toBe(true);
  });

  test("a legacy row whose ai_status is not a deletion is not eligible", () => {
    const legacy = msg({
      ai_status: "analyzed",
      ai_confidence: 0.99,
      ai_categories: "harassment",
    });
    // `analyzed` is the queue state and says nothing about the outcome, so a
    // legacy row that never got a real judgement must not delete on it.
    expect(isEligibleForAutoDelete(legacy, null)).toBe(false);
  });

  test("a pending message with no verdict is not eligible", () => {
    expect(isEligibleForAutoDelete(msg({ ai_status: "pending" }), null)).toBe(
      false,
    );
  });

  test("a message with no verdict and no legacy columns is not eligible", () => {
    expect(isEligibleForAutoDelete(msg(), null)).toBe(false);
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

/**
 * Regression: the guard existed but the model routed around it by WORDING.
 *
 * Prod row (user 1052035456688205854, nickname "adit cuking", body "Nandayo"):
 * the verdict flagged plain `harassment`, cited the NICKNAME as the violation,
 * and the pipeline DELETED THE MESSAGE instead of resetting the name.
 *
 * Both prose paths failed at once, for reasons that have nothing to do with
 * severity:
 *   - the flag was `harassment`, which is not in USERNAME_ATTRIBUTABLE_FLAGS
 *   - "mengandung" came BEFORE "nickname", and the pattern required the reverse
 *   - the analysis never volunteered that the message itself was clean
 *
 * So the decision is now also checked against the NICKNAME and BODY themselves,
 * which the model cannot reword. Fixtures below are verbatim prod values.
 */
describe("isNicknameOnlyViolation — evidence-based path", () => {
  const rudeNick = {
    member: { nickname: "adit cuking", displayName: "adit cuking" },
  };

  test("prod case: rude nickname + clean body, however the verdict is phrased", () => {
    // Verbatim prod analysis. Flag is what the feed card showed.
    const analysis =
      "Pesan mengandung sindiran pribadi melalui nickname 'adit cuking' yang sudah ditandai sebagai hinaan dalam memori kanal. Pengguna menggunakan nama panggilan yang sudah diketahui moderasi sebagai pelanggaran harassment tingkat medium. Pesan 'Nandayo' adalah cara mengekspresikan ketidakpuasan atau sindiran terhadap diri sendiri menggunakan kata 'cuking' yang merupakan hinaan pribadi.";

    expect(
      isNicknameOnlyViolation(
        msg({ content: "Nandayo", metadata: rudeNick }),
        verdict({ flags: ["harassment"], analysis }),
      ),
    ).toBe(true);
  });

  test("a rude body is still a deletable message violation", () => {
    // The nickname is rude AND the message is rude. The message must remain
    // deletable — the nickname reset is not a get-out-of-jail card.
    expect(
      isNicknameOnlyViolation(
        msg({ content: "kamu kontol", metadata: rudeNick }),
        verdict({
          flags: ["harassment"],
          analysis: "isi pesan mengandung kata kasar",
        }),
      ),
    ).toBe(false);
  });

  test("a rude nickname with no insults in the body, empty flags", () => {
    // No flags at all used to mean "cannot be a nickname violation". The
    // evidence path must not depend on the model choosing a flag.
    expect(
      isNicknameOnlyViolation(
        msg({ content: "halo semua", metadata: rudeNick }),
        verdict({ flags: [], analysis: "" }),
      ),
    ).toBe(true);
  });

  test("a clean nickname and clean body stay deletable", () => {
    expect(
      isNicknameOnlyViolation(
        msg({
          content: "Nandayo",
          metadata: { member: { nickname: "rama_adityo" } },
        }),
        verdict({
          flags: ["harassment"],
          analysis: "Pesan mengandung sindiran pribadi.",
        }),
      ),
    ).toBe(false);
  });

  test("no captured nickname leaves the prose paths in charge", () => {
    expect(
      isNicknameOnlyViolation(
        msg({ content: "Nandayo", metadata: { member: {} } }),
        verdict({
          flags: ["harassment"],
          analysis: "Pesan mengandung sindiran pribadi.",
        }),
      ),
    ).toBe(false);
  });
});
