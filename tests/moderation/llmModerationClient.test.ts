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

  it("extracts JSON correctly from complex conversational output with thinking blocks containing braces", () => {
    const content = `Based on the messages, I will analyze them.
    <thinking>
      The JSON structure should be:
      {
        "results": [ ... ]
      }
    </thinking>
    Here is the results array:
    {
      "results": [
        {
          "message_id": "m1",
          "status": "clean",
          "flags": [],
          "score": 0.2,
          "analysis": "Benign"
        }
      ]
    }`;
    const result = parseModerationResponse(content, ["m1"]);
    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe("m1");
  });

  it("extracts JSON from markdown code block wrapping", () => {
    const content = `Sure! Here is the JSON structure:
\`\`\`json
{
  "results": [
    {
      "message_id": "m1",
      "status": "clean",
      "flags": [],
      "score": 0.2,
      "analysis": "Benign"
    }
  ]
}
\`\`\``;
    const result = parseModerationResponse(content, ["m1"]);
    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe("m1");
  });

  it("handles message_id returned with square brackets", () => {
    const content = JSON.stringify({
      results: [
        {
          message_id: "[m1]",
          status: "clean",
          flags: [],
          score: 0.1,
          analysis: "OK",
        },
      ],
    });
    const result = parseModerationResponse(content, ["m1"]);
    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe("m1");
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

  it("sends multimodal payload when image attachments are present", async () => {
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

    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("picser.tech") || url.includes("discord.com")) {
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () => {
            const buffer = Buffer.from("fake-image-bytes");
            return buffer.buffer.slice(
              buffer.byteOffset,
              buffer.byteOffset + buffer.byteLength,
            );
          },
        });
      }
      return Promise.resolve({
        ok: true,
        text: async () => JSON.stringify(mockResponse),
        json: async () => mockResponse,
      });
    });

    const mockAttachment = {
      id: "a1",
      message_id: "m1",
      guild_id: "guild123",
      channel_id: "channel123",
      thread_id: null,
      user_id: "user123",
      filename: "test.png",
      size: 500,
      type: "image/png",
      discord_url: "https://discord.com/attachment.png",
      uploaded_url: "https://picser.tech/test.png",
      upload_status: "uploaded" as const,
      upload_error: null,
      created_at: Date.now(),
      uploaded_at: Date.now(),
    };

    const result = await runModerationAnalysis({
      targets: [createMessageRecord()],
      contextText: "test context",
      attachments: [mockAttachment],
    });

    expect(result.results).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalled();

    const fetchCalls = (global.fetch as any).mock.calls;
    // Should be called twice: 1st for image download, 2nd for API completions
    expect(fetchCalls.length).toBe(2);

    // Verify 1st call (image download)
    expect(fetchCalls[0][0]).toBe("https://picser.tech/test.png");

    // Verify 2nd call (chat completions API)
    const [, completionsOptions] = fetchCalls[1];
    const body = JSON.parse(completionsOptions.body);

    const userMessage = body.messages[0];
    expect(userMessage.role).toBe("user");
    expect(Array.isArray(userMessage.content)).toBe(true);
    expect(userMessage.content[0].type).toBe("image_url");
    expect(userMessage.content[0].image_url.url).toContain(
      "data:image/png;base64,",
    );
    expect(userMessage.content[1].type).toBe("text");
    expect(userMessage.content[1].text).toContain(
      "Image Attachment for Message ID: m1",
    );
    expect(userMessage.content[2].type).toBe("text");
    expect(userMessage.content[2].text).toContain(
      "You are a content moderation assistant.",
    );
  });

  it("caps image attachments to 8 and prioritizes targets over context", async () => {
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

    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("picser.tech") || url.includes("discord.com")) {
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () => {
            const buffer = Buffer.from("fake-bytes");
            return buffer.buffer.slice(
              buffer.byteOffset,
              buffer.byteOffset + buffer.byteLength,
            );
          },
        });
      }
      return Promise.resolve({
        ok: true,
        text: async () => JSON.stringify(mockResponse),
        json: async () => mockResponse,
      });
    });

    const createAttachment = (
      id: string,
      msgId: string,
      createdAt: number,
    ) => ({
      id,
      message_id: msgId,
      guild_id: "guild123",
      channel_id: "channel123",
      thread_id: null,
      user_id: "user123",
      filename: `${id}.png`,
      size: 500,
      type: "image/png",
      discord_url: `https://discord.com/${id}.png`,
      uploaded_url: `https://picser.tech/${id}.png`,
      upload_status: "uploaded" as const,
      upload_error: null,
      created_at: createdAt,
      uploaded_at: createdAt,
    });

    // 10 attachments total (3 targets, 7 context)
    const attachments = [
      createAttachment("c1", "context1", 100),
      createAttachment("c2", "context2", 200),
      createAttachment("t1", "m1", 300), // Target 1
      createAttachment("c3", "context3", 400),
      createAttachment("t2", "m1", 500), // Target 2
      createAttachment("c4", "context4", 600),
      createAttachment("c5", "context5", 700),
      createAttachment("t3", "m1", 800), // Target 3
      createAttachment("c6", "context6", 900),
      createAttachment("c7", "context7", 1000),
    ];

    await runModerationAnalysis({
      targets: [createMessageRecord({ id: "m1" })],
      contextText: "test context",
      attachments,
    });

    const fetchCalls = (global.fetch as any).mock.calls;
    // Should download exactly 8 images (since it's capped at 8) plus 1 call for completion API = 9 calls total.
    expect(fetchCalls.length).toBe(9);

    // Target attachments (t3, t2, t1) must be fetched, then context in descending order of created_at:
    // Sorted order: t3 (800), t2 (500), t1 (300), c7 (1000), c6 (900), c5 (700), c4 (600), c3 (400)
    // Excluded: c2 (200), c1 (100)
    const downloadedUrls = fetchCalls.slice(0, 8).map((call: any) => call[0]);

    expect(downloadedUrls).toContain("https://picser.tech/t3.png");
    expect(downloadedUrls).toContain("https://picser.tech/t2.png");
    expect(downloadedUrls).toContain("https://picser.tech/t1.png");
    expect(downloadedUrls).toContain("https://picser.tech/c7.png");
    expect(downloadedUrls).not.toContain("https://picser.tech/c1.png");
  });
});
