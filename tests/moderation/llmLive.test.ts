import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../../src/config";
import { runModerationAnalysis } from "../../src/moderation/llmModerationClient";
import type { MessageRecord } from "../../src/moderation/types";

describe("LLM Live Integration Test", () => {
  // Hanya jalankan jika API Key tersedia
  const hasApiKey =
    !!config.AI_LLM_API_KEY && config.AI_LLM_API_KEY !== "your-api-key";

  it.runIf(hasApiKey)(
    "should successfully call real LLM API and parse response",
    async () => {
      console.log(`Using Model: ${config.AI_LLM_MODEL}`);
      console.log(`Base URL: ${config.AI_LLM_BASE_URL}`);

      const mockMessages: MessageRecord[] = [
        {
          id: "test-msg-1",
          guild_id: "guild-1",
          channel_id: "channel-1",
          thread_id: null,
          user_id: "user-1",
          username: "Tester",
          avatar_url: null,
          content: "This is a clean test message.",
          edited_content: null,
          created_at: Date.now(),
          edited_at: null,
          deleted_at: null,
          type: "text",
          metadata: null,
        },
        {
          id: "test-msg-2",
          guild_id: "guild-1",
          channel_id: "channel-1",
          thread_id: null,
          user_id: "user-2",
          username: "BadActor",
          avatar_url: null,
          content: "I will kill you and steal your data! DIE!",
          edited_content: null,
          created_at: Date.now() + 1000,
          edited_at: null,
          deleted_at: null,
          type: "text",
          metadata: null,
        },
      ];

      const result = await runModerationAnalysis({
        targets: mockMessages,
        contextText: "Testing moderation system stability.",
      });

      console.log(
        "Raw Response received (first 100 chars):",
        JSON.stringify(result.raw).substring(0, 100),
      );

      expect(result.results).toHaveLength(2);

      const cleanMsg = result.results.find((r) => r.messageId === "test-msg-1");
      const badMsg = result.results.find((r) => r.messageId === "test-msg-2");

      expect(cleanMsg?.status).toBe("clean");
      expect(["warn", "flagged"]).toContain(badMsg?.status);

      console.log("Clean Message Result:", cleanMsg);
      console.log("Bad Message Result:", badMsg);
    },
    30000,
  ); // 30s timeout untuk LLM
});
