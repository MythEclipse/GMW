import { describe, expect, it } from "vitest";
import {
  getConversationKey,
  pickBatchWithinBudget,
} from "../../src/moderation/aiAnalyzer";
import type { MessageRecord } from "../../src/moderation/types";

function message(
  id: string,
  content: string,
  thread_id: string | null = null,
): MessageRecord {
  return {
    id,
    guild_id: "g1",
    channel_id: "c1",
    thread_id,
    user_id: "u1",
    username: "u1",
    avatar_url: null,
    content,
    edited_content: null,
    created_at: Number(id.replace("m", "")) || 1,
    edited_at: null,
    deleted_at: null,
    type: "text",
    metadata: null,
    ai_status: "pending",
  };
}

describe("analysis queue helpers", () => {
  it("uses thread id before channel id", () => {
    expect(getConversationKey(message("m1", "hello", "t1"))).toBe("t1");
    expect(getConversationKey(message("m1", "hello", null))).toBe("c1");
  });

  it("picks batch within budget", () => {
    const batch = pickBatchWithinBudget(
      [message("m1", "a"), message("m2", "x".repeat(1000))],
      50,
      10,
    );
    expect(batch.map((item) => item.id)).toEqual(["m1"]);
  });
});
