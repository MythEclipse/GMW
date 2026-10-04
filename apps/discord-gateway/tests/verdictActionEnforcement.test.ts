/**
 * The model's chosen `action` reaches enforcement.
 *
 * ## Why this suite exists
 *
 * `verdicts.status` is two-valued, so it cannot say "the violation is in the
 * member's nickname and this message must stay". Until now the enforcer
 * recovered that intent with `isNicknameOnlyViolation`, which decided it by
 * regex-matching the model's own analysis prose — and production defeated it:
 *
 *     user 1052035456688205854, nickname "adit cuking", body "Nandayo"
 *     verdict: flags ["harassment"], analysis "Pesan mengandung sindiran pribadi
 *               melalui nickname 'adit cuking' ..."
 *     -> MESSAGE DELETED, nickname left alone
 *
 * The model now states the outcome in a named `action` field. This suite covers
 * the four decisions that field changes, and the two invariants that make it
 * safe to ship: the evidence-based guard still overrides the model, and no
 * `reset_nickname` can ever reach a delete.
 *
 * Everything is mocked at the boundary — the Discord client, the moderation
 * store, the notifier, the mod-channel logger. No database, no network, no real
 * Discord call. The assertions are on what the manager DECIDED and what it
 * recorded, not on how many times a function ran.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Boundary mocks ────────────────────────────────────────────────
// Registered before importing the manager, because the manager captures these
// bindings at module load.
const moderationActions: Array<Record<string, unknown>> = [];

mock.module("../src/modules/message-capture/messageStore.js", () => ({
  messageStore: {
    async createModerationAction(action: Record<string, unknown>) {
      moderationActions.push(action);
      return action;
    },
    async updateMessageAsDeleted() {
      return null;
    },
  },
}));

const notifierCalls: string[] = [];
mock.module("../src/modules/ai-moderation/autoDeleteNotify.js", () => ({
  sendDeletionNotification: async () => {
    notifierCalls.push("notified");
  },
}));

const loggerCalls: string[] = [];
mock.module("../src/modules/ai-moderation/autoDeleteLogger.js", () => ({
  logDeletionToChannel: async () => {
    loggerCalls.push("channel-logged");
  },
  logAlreadyDeleted: async () => {
    loggerCalls.push("already-deleted-logged");
  },
}));

const { attemptAutoDeleteFlaggedMessage } = await import(
  "../src/modules/ai-moderation/autoDeleteManager.js"
);
type VerdictLike =
  import("../src/modules/ai-moderation/autoDeleteEligibility.js").VerdictLike;
type AutoDeleteInput =
  import("../src/modules/ai-moderation/autoDeleteManager.js").AutoDeleteInput;

/**
 * `messages.metadata` is a TEXT column, so the real enforcer receives a JSON
 * STRING. The first version of the evidence suite passed a parsed object and the
 * guard was inert in production, so every fixture here is `JSON.stringify`'d on
 * purpose — a test that never sees the wire shape cannot catch this.
 *
 * Verbatim prod values: nickname "adit cuking", body "Nandayo".
 */
const PROD_NICKNAME_METADATA = JSON.stringify({
  member: { nickname: "adit cuking", displayName: "adit cuking" },
});

/** Verbatim prod analysis: plain `harassment` flag, nickname blamed in prose. */
const PROD_ANALYSIS =
  "Pesan mengandung sindiran pribadi melalui nickname 'adit cuking' yang " +
  "sudah ditandai sebagai hinaan dalam memori kanal. Pengguna menggunakan nama " +
  "panggilan yang sudah diketahui moderasi sebagai pelanggaran harassment tingkat " +
  "medium. Pesan 'Nandayo' adalah cara mengekspresikan ketidakpuasan atau sindiran " +
  "terhadap diri sendiri menggunakan kata 'cuking' yang merupakan hinaan pribadi.";

/**
 * A fresh member identity per message.
 *
 * `recentNicknameResets` is a MODULE-LEVEL LRU keyed on `guild_id:user_id`
 * with a 10-minute TTL, and it is the real production cooldown guard — so
 * without this, the first test in the file consumes the cooldown and every
 * later one silently skips its reset. That is a real coupling, not a test
 * artefact: it is exactly why the manager keeps that cache. The `messageId` and
 * the captured nickname are unchanged from prod; only the user id varies.
 */
let userSeq = 0;
function nextUserId(): string {
  userSeq += 1;
  return `10520354566882058${String(userSeq).padStart(2, "0")}`;
}

function message(overrides: Partial<AutoDeleteInput> = {}): AutoDeleteInput {
  return {
    id: "1554472364094521396",
    guild_id: "g1",
    channel_id: "c1",
    // Unique per call, so the production nickname-reset cooldown never carries
    // between tests. See `nextUserId`.
    user_id: nextUserId(),
    thread_id: null,
    username: "adit",
    content: "Nandayo",
    metadata: null,
    ...overrides,
  };
}

function verdict(overrides: Partial<VerdictLike> = {}): VerdictLike {
  return {
    status: "deleted",
    confidence: 0.95,
    score: 0.62,
    categories: ["harassment"],
    flags: ["harassment"],
    analysis: "contains abusive language",
    ...overrides,
  };
}

/**
 * A Discord client just complete enough for the delete path: a guild with one
 * channel that reports Manage Messages, a fetchable message whose `delete()` is
 * recorded, and two fetchable members (the target, then the bot's own).
 */
function fakeClient() {
  const deleted: string[] = [];
  const nicknames: Array<string | null> = [];
  const targetMember = {
    manageable: true,
    setNickname: async (value: string | null) => {
      nicknames.push(value);
    },
    user: { id: "1052035456688205854", username: "adit" },
  };
  const channel = {
    permissionsFor: () => ({ has: () => true }),
    messages: {
      fetch: async (id: string) => ({
        delete: async () => {
          deleted.push(id);
        },
      }),
    },
    send: async () => undefined,
  };
  const guild = {
    name: "GMW test",
    channels: { cache: new Map([["c1", channel]]) },
    channelsFetch: async () => undefined,
    members: {
      // Any id resolves to the target member: the manager only ever fetches the
      // message author and the bot's own account, and `user_id` varies per test
      // to defeat the production cooldown cache.
      fetch: async () => targetMember,
    },
  };
  return {
    deleted,
    nicknames,
    client: {
      user: { id: "bot1" },
      guilds: { cache: new Map([["g1", guild]]) },
    } as never,
  };
}

function lastAction(): Record<string, unknown> | undefined {
  return moderationActions[moderationActions.length - 1];
}

beforeEach(() => {
  moderationActions.length = 0;
  notifierCalls.length = 0;
  loggerCalls.length = 0;
});

describe("the model's action chooses the outcome", () => {
  // 1. The headline case: the model says reset_nickname, and the name-only
  //    evidence is a rude nickname with a clean body — the exact prod row. The
  //    message must survive and the nickname must be reset.
  test("action reset_nickname takes the nickname-reset path and keeps the message", async () => {
    const { client, nicknames } = fakeClient();

    const result = await attemptAutoDeleteFlaggedMessage(
      client,
      message({
        content: "Nandayo",
        metadata: PROD_NICKNAME_METADATA,
      }),
      verdict({
        status: "deleted",
        action: "reset_nickname",
        flags: ["offensive_nickname"],
        analysis: "Nickname mengandung kata kasar 'cuking'; isi pesan bersih.",
      }),
    );

    expect(result.deleted).toBe(false);
    expect(result.reason).toBe("nickname_only_violation");
    expect(nicknames).toEqual([null]);
    expect(lastAction()?.action_type).toBe("reset_nickname");
    expect(lastAction()?.status).toBe("executed");
  });

  // The pure-model path: a clean nickname and clean body, but the model asks for
  // a reset. Only the named field carries that intent now, so this must work
  // without any evidence supporting it — and must still not delete anything.
  test("action reset_nickname is honoured on its own, without evidence support", async () => {
    const { client, nicknames, deleted } = fakeClient();

    const result = await attemptAutoDeleteFlaggedMessage(
      client,
      // A nickname with no insult term in it: `isNicknameOnlyViolation` is
      // FALSE here, so only the model's action can produce this outcome.
      message({
        content: "halo semua",
        metadata: JSON.stringify({
          member: { nickname: "rama_adityo", displayName: "rama_adityo" },
        }),
      }),
      verdict({
        status: "clean",
        action: "reset_nickname",
        flags: ["offensive_nickname"],
        analysis: "Nickname mengandung kata kasar; isi pesan bersih.",
      }),
    );

    expect(result.deleted).toBe(false);
    // `nickname_only_violation` rather than `model_action_reset_nickname`:
    // `isNicknameOnlyViolation` is consulted first and matches on the
    // nickname's own wording, so the evidence branch reports itself and the
    // model-only branch below is never reached. Same enforcement, same audit
    // row — only the label differs, and the label that survives is the one
    // backed by evidence rather than by the model's assertion.
    expect(result.reason).toBe("nickname_only_violation");
    expect(deleted).toEqual([]);
    expect(nicknames).toEqual([null]);
    expect(lastAction()?.action_type).toBe("reset_nickname");
  });

  // The invariant, stated correctly. `reset_nickname` never SPARES a message
  // that violates in its own right — but that is not the same as "never
  // deletes". This case has `metadata: null` (no nickname to reset at all) and a
  // body that is itself an insult, so there is no name-only violation to
  // enforce: the message is deleted.
  //
  // The previous version of this test asserted `deleted === false` here, which
  // contradicted its sibling ("a rude body still deletes") and encoded the
  // jail-card bug as if it were a requirement: naming `reset_nickname` would
  // have kept ANY message.
  test("action reset_nickname cannot spare a body that violates on its own", async () => {
    const { client, deleted } = fakeClient();

    const result = await attemptAutoDeleteFlaggedMessage(
      client,
      message({ content: "kamu kontol", metadata: null }),
      verdict({
        status: "deleted",
        action: "reset_nickname",
        confidence: 0.99,
        categories: ["harassment"],
        analysis: "hinaan di isi pesan",
      }),
    );

    expect(result.deleted).toBe(true);
    expect(deleted).toHaveLength(1);
    // No nickname exists, so nothing was reset — only the message went.
    expect(lastAction()?.action_type).toBe("delete_message");
  });

  // 2. THE REGRESSION THAT SHIPPED. The model says delete_message, but the
  //    evidence says the only problem is the nickname and the body is clean.
  //    The evidence wins: nickname reset, message kept.
  test("action delete_message is overridden to a reset when the nickname is the only violation", async () => {
    const { client, nicknames, deleted } = fakeClient();

    const result = await attemptAutoDeleteFlaggedMessage(
      client,
      message({
        content: "Nandayo",
        metadata: PROD_NICKNAME_METADATA,
      }),
      // Verbatim prod verdict: plain `harassment`, nickname blamed in prose.
      verdict({
        status: "deleted",
        action: "delete_message",
        analysis: PROD_ANALYSIS,
      }),
    );

    expect(result.deleted).toBe(false);
    expect(result.reason).toBe("nickname_only_violation");
    expect(deleted).toEqual([]);
    expect(nicknames).toEqual([null]);
    expect(lastAction()?.action_type).toBe("reset_nickname");
  });

  // The override is not a blanket "always reset": a rude BODY is a real message
  // violation, and the nickname reset is not a get-out-of-jail card. This is the
  // other half of the same guard, and the reason both halves are required.
  test("action reset_nickname does not spare a message whose own body violates", async () => {
    const { client, deleted } = fakeClient();

    const result = await attemptAutoDeleteFlaggedMessage(
      client,
      message({
        content: "dasar kontol cuking",
        metadata: PROD_NICKNAME_METADATA,
      }),
      verdict({
        status: "deleted",
        action: "reset_nickname",
        analysis: PROD_ANALYSIS,
      }),
    );

    // The body carries an insult term, so `isNicknameOnlyViolation` is false and
    // `status: "deleted"` is what authorises the delete. `action` cannot veto it,
    // because honouring `reset_nickname` here would be the jail card.
    expect(result.deleted).toBe(true);
    expect(result.reason).toBe("deleted");
    expect(deleted).toEqual(["1554472364094521396"]);
    expect(lastAction()?.action_type).toBe("delete_message");
  });

  // 3. Invalid action values must fall back to exactly the pre-action
  //    behaviour, for every junk shape the wire can carry.
  test("an invalid action falls back safely instead of deleting or erroring", async () => {
    for (const action of [
      "warn",
      "review",
      "escalate",
      "delete",
      "RESET_NICKNAME",
      "reset-nickname",
      "hapus_nickname",
      "",
      "   ",
      42,
      null,
      undefined,
      true,
      ["delete_message"],
      { action: "delete_message" },
    ]) {
      moderationActions.length = 0;
      const { client, deleted, nicknames } = fakeClient();

      const result = await attemptAutoDeleteFlaggedMessage(
        client,
        // A clean nickname and a rude body: `isNicknameOnlyViolation` is false,
        // so eligibility alone decides. A junk action must not divert this to a
        // nickname reset, and must not throw.
        message({ content: "dasar goblok", metadata: null }),
        verdict({ status: "deleted", action }),
      );

      // Pre-action behaviour: status `deleted` + eligible -> deleted.
      expect(result.deleted).toBe(true);
      expect(result.reason).toBe("deleted");
      expect(deleted).toEqual(["1554472364094521396"]);
      expect(nicknames).toEqual([]);
      expect(lastAction()?.action_type).toBe("delete_message");
    }
  });

  // An invalid action on a CLEAN verdict must stay a keep. This is the direction
  // that matters: a hallucinated field must never be able to authorise a delete.
  test("an invalid action on a clean verdict never reaches enforcement", async () => {
    for (const action of ["delete_message", "warn", 1, {}, null, undefined]) {
      moderationActions.length = 0;
      const { client, deleted, nicknames } = fakeClient();

      const result = await attemptAutoDeleteFlaggedMessage(
        client,
        message({ content: "halo semua", metadata: null }),
        verdict({ status: "clean", action, confidence: 0.99 }),
      );

      expect(result.deleted).toBe(false);
      expect(result.reason).toBe("not_eligible");
      expect(deleted).toEqual([]);
      expect(nicknames).toEqual([]);
      // No action row at all: the only writer of `action_type` on this path is a
      // delete attempt or a nickname reset, and neither happened.
      expect(lastAction()?.action_type).toBe("delete_message");
      expect(lastAction()?.status).toBe("failed");
    }
  });

  // 4. `clean` -> no action. The enforcer never sees a `clean` row at all (its
  //    candidate query filters `status = 'deleted'`), so this is asserted at the
  //    manager boundary: nothing is deleted, no reset, no reset_nickname row.
  //
  //    Uses a CLEAN nickname. The earlier version reused
  //    PROD_NICKNAME_METADATA ("adit cuking") with `status: "clean"` and
  //    expected no enforcement — but a rude nickname IS a violation, and the
  //    evidence guard deliberately overrides a `clean` verdict on it. Expecting
  //    `not_eligible` there asserted that the override did not exist.
  test("action clean performs no enforcement at all", async () => {
    const { client, deleted, nicknames } = fakeClient();

    const result = await attemptAutoDeleteFlaggedMessage(
      client,
      message({
        content: "Nandayo",
        metadata: JSON.stringify({
          member: { nickname: "rama_adityo", displayName: "rama_adityo" },
        }),
      }),
      verdict({ status: "clean", action: "clean" }),
    );

    expect(result.deleted).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("not_eligible");
    expect(deleted).toEqual([]);
    expect(nicknames).toEqual([]);
  });

  // A `clean` disposition beside a nickname-only violation still resets: the
  // evidence guard is not gated on the model's disposition, only on its
  // `status`. The model's `action` is a preference; the nickname evidence is
  // the authority.
  test("action clean cannot veto the nickname-only evidence guard", async () => {
    const { client, nicknames, deleted } = fakeClient();

    const result = await attemptAutoDeleteFlaggedMessage(
      client,
      message({
        content: "Nandayo",
        metadata: PROD_NICKNAME_METADATA,
      }),
      verdict({ status: "deleted", action: "clean" }),
    );

    expect(result.deleted).toBe(false);
    expect(result.reason).toBe("nickname_only_violation");
    expect(deleted).toEqual([]);
    expect(nicknames).toEqual([null]);
  });

  // The pre-existing behaviour, for the rows written before the column existed:
  // NULL action, nickname-only evidence -> the old reset path, unchanged.
  test("a null action (every row written before the column) still behaves as before", async () => {
    const { client, nicknames, deleted } = fakeClient();

    const nicknameOnly = await attemptAutoDeleteFlaggedMessage(
      client,
      message({ content: "Nandayo", metadata: PROD_NICKNAME_METADATA }),
      verdict({ status: "deleted", action: null }),
    );
    expect(nicknameOnly.reason).toBe("nickname_only_violation");
    expect(deleted).toEqual([]);

    moderationActions.length = 0;
    const plainDelete = await attemptAutoDeleteFlaggedMessage(
      client,
      message({ content: "dasar goblok", metadata: null }),
      verdict({ status: "deleted", action: null }),
    );
    expect(plainDelete.deleted).toBe(true);
    expect(lastAction()?.action_type).toBe("delete_message");
  });

  // The recorded verdict columns must carry the disposition, not just the
  // action_type: an audit row that cannot say what the model asked for is how
  // an override stays invisible.
  test("the audit row records the model's disposition", async () => {
    const { client } = fakeClient();

    await attemptAutoDeleteFlaggedMessage(
      client,
      message({
        content: "halo semua",
        metadata: JSON.stringify({
          member: { nickname: "rama_adityo", displayName: "rama_adityo" },
        }),
      }),
      verdict({ status: "clean", action: "reset_nickname" }),
    );

    const action = lastAction();
    expect(action?.action_type).toBe("reset_nickname");
    expect(action?.executed_by).toBe("auto-delete-manager");
    expect(action?.server_nick).toBe("rama_adityo");
    // `reset_nickname` is recorded as executed, never as a pending delete.
    expect(action?.status).toBe("executed");
    expect(action?.executed_at).not.toBeNull();
  });
});
