import { beforeEach, describe, expect, it, vi } from "vitest";
import { attemptAutoDeleteFlaggedMessage } from "../../src/moderation/autoDeleteManager";
import type { MessageRecord } from "../../src/moderation/types";

vi.mock("../../src/config", () => ({
  config: {
    AUTO_DELETE_FLAGGED_ENABLED: true,
    AUTO_DELETE_FLAGGED_DRY_RUN: false,
    AUTO_DELETE_FLAGGED_DELAY_MS: 0,
  },
}));

vi.mock("../../src/logger", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createMessage(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: "m1",
    guild_id: "g1",
    channel_id: "c1",
    thread_id: null,
    user_id: "u1",
    username: "user",
    avatar_url: null,
    content: "bad",
    edited_content: null,
    created_at: Date.now(),
    edited_at: null,
    deleted_at: null,
    type: "text",
    metadata: null,
    ai_status: "flagged",
    ...overrides,
  };
}

function createClient(options: {
  canManageMessages?: boolean;
  fetchError?: unknown;
  deleteError?: unknown;
} = {}) {
  const deleteMock = vi.fn(async () => {
    if (options.deleteError) throw options.deleteError;
  });
  const fetchMessageMock = vi.fn(async () => {
    if (options.fetchError) throw options.fetchError;
    return { delete: deleteMock };
  });
  const permissionsForMock = vi.fn(() => ({
    has: vi.fn(() => options.canManageMessages ?? true),
  }));
  const channel = {
    permissionsFor: permissionsForMock,
    messages: { fetch: fetchMessageMock },
  };
  const guild = {
    channels: { cache: new Map([["c1", channel]]) },
    members: { fetch: vi.fn(async () => ({ id: "self" })) },
  };
  const client = {
    user: { id: "self" },
    guilds: { cache: new Map([["g1", guild]]) },
  };

  return { client, guild, channel, fetchMessageMock, deleteMock };
}

describe("attemptAutoDeleteFlaggedMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips non-flagged messages", async () => {
    const { client, deleteMock } = createClient();
    const result = await attemptAutoDeleteFlaggedMessage(
      client as any,
      createMessage({ ai_status: "clean" }),
    );

    expect(result.reason).toBe("not_flagged");
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("skips when current user lacks Manage Messages", async () => {
    const { client, deleteMock } = createClient({ canManageMessages: false });
    const result = await attemptAutoDeleteFlaggedMessage(
      client as any,
      createMessage(),
    );

    expect(result.reason).toBe("missing_manage_messages");
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("deletes when message is flagged and permission exists", async () => {
    const { client, fetchMessageMock, deleteMock } = createClient({
      canManageMessages: true,
    });
    const result = await attemptAutoDeleteFlaggedMessage(
      client as any,
      createMessage(),
    );

    expect(result).toEqual({ deleted: true, skipped: false, reason: "deleted" });
    expect(fetchMessageMock).toHaveBeenCalledWith("m1");
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });

  it("treats unknown message as already deleted", async () => {
    const { client } = createClient({ fetchError: { code: 10008 } });
    const result = await attemptAutoDeleteFlaggedMessage(
      client as any,
      createMessage(),
    );

    expect(result).toEqual({
      deleted: true,
      skipped: false,
      reason: "already_deleted",
    });
  });
});
