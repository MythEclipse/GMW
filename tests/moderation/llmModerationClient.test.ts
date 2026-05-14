import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseModerationResponse,
  runModerationAnalysis,
} from "../../src/moderation/llmModerationClient";
import type { MessageRecord } from "../../src/moderation/types";

vi.mock("../../src/retry", () => ({
  retryWithBackoff: vi.fn((fn) => fn()),
}));

/**
 * Helper to create a full MessageRecord fixture with sensible defaults.
 * Only override fields that differ from defaults.
 */
function createMessageRecord(
  overrides: Partial<MessageRecord> = {},
): MessageRecord {
  const now = Date.now();
  return {
    id: "m1",
    guild_id: "guild123",
    channel_id: "channel123",
    thread_id: null,
    user_id: "user123",
    username: "user1",
    avatar_url: null,
    content: "hello",
    edited_content: null,
    created_at: now,
    edited_at: null,
    deleted_at: null,
    type: "text",
    metadata: null,
    ...overrides,
  };
}

describe("parseModerationResponse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("parses valid keyed results", () => {
    const result = parseModerationResponse(
      JSON.stringify({
        results: [
          {
            message_id: "m1",
            status: "warn",
            flags: ["provokasi"],
            score: 0.7,
            analysis: "Perlu peringatan.",
          },
        ],
      }),
      ["m1"],
    );

    expect(result).toEqual([
      {
        messageId: "m1",
        status: "warn",
        flags: ["provokasi"],
        score: 0.7,
        analysis: "Perlu peringatan.",
      },
    ]);
  });

  it("rejects missing target ids", () => {
    expect(() =>
      parseModerationResponse(JSON.stringify({ results: [] }), ["m1"]),
    ).toThrow(/missing/i);
  });

  it("rejects unknown ids", () => {
    expect(() =>
      parseModerationResponse(
        JSON.stringify({
          results: [
            {
              message_id: "m2",
              status: "clean",
              flags: [],
              score: 0,
              analysis: "OK",
            },
          ],
        }),
        ["m1"],
      ),
    ).toThrow(/unknown/i);
  });

  it("handles surrounding text around JSON", () => {
    const content = `Some preamble text here.
    {
      "results": [
        {
          "message_id": "m1",
          "status": "clean",
          "flags": [],
          "score": 0.1,
          "analysis": "OK"
        }
      ]
    }
    Some trailing text here.`;

    const result = parseModerationResponse(content, ["m1"]);
    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe("m1");
  });

  it("handles nested fields in results", () => {
    const content = JSON.stringify({
      results: [
        {
          message_id: "m1",
          status: "warn",
          flags: ["spam", "abuse"],
          score: 0.85,
          analysis: "Multiple violations detected",
          metadata: {
            nested: "field",
            count: 5,
          },
        },
      ],
    });

    const result = parseModerationResponse(content, ["m1"]);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.85);
  });

  it("rejects null score", () => {
    expect(() =>
      parseModerationResponse(
        JSON.stringify({
          results: [
            {
              message_id: "m1",
              status: "clean",
              flags: [],
              score: null,
              analysis: "OK",
            },
          ],
        }),
        ["m1"],
      ),
    ).toThrow(/null or undefined/i);
  });

  it("rejects undefined score", () => {
    expect(() =>
      parseModerationResponse(
        JSON.stringify({
          results: [
            {
              message_id: "m1",
              status: "clean",
              flags: [],
              analysis: "OK",
            },
          ],
        }),
        ["m1"],
      ),
    ).toThrow(/null or undefined/i);
  });

  it("rejects duplicate message_id", () => {
    expect(() =>
      parseModerationResponse(
        JSON.stringify({
          results: [
            {
              message_id: "m1",
              status: "clean",
              flags: [],
              score: 0.1,
              analysis: "OK",
            },
            {
              message_id: "m1",
              status: "warn",
              flags: ["spam"],
              score: 0.5,
              analysis: "Duplicate",
            },
          ],
        }),
        ["m1"],
      ),
    ).toThrow(/duplicate/i);
  });

  it("rejects invalid status", () => {
    expect(() =>
      parseModerationResponse(
        JSON.stringify({
          results: [
            {
              message_id: "m1",
              status: "invalid_status",
              flags: [],
              score: 0.5,
              analysis: "OK",
            },
          ],
        }),
        ["m1"],
      ),
    ).toThrow(/invalid status/i);
  });

  it("clamps score to 0-1 range", () => {
    const result = parseModerationResponse(
      JSON.stringify({
        results: [
          {
            message_id: "m1",
            status: "clean",
            flags: [],
            score: 1.5,
            analysis: "OK",
          },
        ],
      }),
      ["m1"],
    );

    expect(result[0].score).toBe(1);
  });

  it("clamps negative score to 0", () => {
    const result = parseModerationResponse(
      JSON.stringify({
        results: [
          {
            message_id: "m1",
            status: "clean",
            flags: [],
            score: -0.5,
            analysis: "OK",
          },
        ],
      }),
      ["m1"],
    );

    expect(result[0].score).toBe(0);
  });
});

describe("runModerationAnalysis", () => {
  it("parses successful response from LLM", async () => {
    const mockResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              results: [
                {
                  message_id: "m1",
                  status: "clean",
                  flags: [],
                  score: 0.1,
                  analysis: "OK",
                },
              ],
            }),
          },
        },
      ],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await runModerationAnalysis({
      targets: [createMessageRecord()],
      contextText: "test context",
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].messageId).toBe("m1");
    expect(result.raw).toEqual(mockResponse);
  });

  it("throws on non-ok HTTP response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    await expect(
      runModerationAnalysis({
        targets: [createMessageRecord()],
        contextText: "test context",
      }),
    ).rejects.toThrow(/LLM API error 500/);
  });

  it("throws on missing choices in response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    await expect(
      runModerationAnalysis({
        targets: [createMessageRecord()],
        contextText: "test context",
      }),
    ).rejects.toThrow(/Invalid LLM response structure/);
  });

  it("throws on missing content in message", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: {} }],
      }),
    });

    await expect(
      runModerationAnalysis({
        targets: [createMessageRecord()],
        contextText: "test context",
      }),
    ).rejects.toThrow(/No content in LLM response/);
  });
});
