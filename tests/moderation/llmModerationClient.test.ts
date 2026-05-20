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

  it("handles missing target ids gracefully", () => {
    const result = parseModerationResponse(JSON.stringify({ results: [] }), [
      "m1",
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe("m1");
    expect(result[0].status).toBe("clean");
    expect(result[0].score).toBe(0);
    expect(result[0].analysis).toContain("incomplete");
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

  it("handles message_id returned with extra wrapping quotes", () => {
    const result = parseModerationResponse(
      JSON.stringify({
        results: [
          {
            message_id: '"test-msg-1"',
            status: "clean",
            flags: [],
            score: 0.1,
            analysis: "OK",
          },
        ],
      }),
      ["test-msg-1"],
    );

    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe("test-msg-1");
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

  it("requests strict JSON output without thinking", async () => {
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
      text: async () => JSON.stringify(mockResponse),
      json: async () => mockResponse,
    });

    await runModerationAnalysis({
      targets: [createMessageRecord()],
      contextText: "test context",
    });

    const requestBody = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(requestBody.temperature).toBe(0);
    expect(requestBody.response_format).toEqual({ type: "json_object" });
    expect(requestBody.reasoning_budget).toBeUndefined();
    expect(requestBody.chat_template_kwargs).toEqual({
      enable_thinking: false,
    });
  });

  it("sends text-only analysis without dummy image", async () => {
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
      text: async () => JSON.stringify(mockResponse),
      json: async () => mockResponse,
    });

    await runModerationAnalysis({
      targets: [createMessageRecord()],
      contextText: "test context",
    });

    const requestBody = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(requestBody.messages[0].role).toBe("system");
    expect(requestBody.messages[1].role).toBe("user");
    expect(typeof requestBody.messages[1].content).toBe("string");
    expect(requestBody.messages[1].content).toContain("test context");
    expect(requestBody.messages[1].content).not.toContain("data:image/png");
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

  it("parses first JSON object when provider appends extra JSON", async () => {
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
      text: async () =>
        `${JSON.stringify(mockResponse)}\n{"usage":{"tokens":12}}`,
    });

    const result = await runModerationAnalysis({
      targets: [createMessageRecord()],
      contextText: "test context",
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].messageId).toBe("m1");
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
      if (url === "https://httpbin.org/image/png") {
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
      discord_url: "https://httpbin.org/image/png",
      uploaded_url: "https://httpbin.org/image/png",
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
    expect(fetchCalls[0][0]).toBe("https://httpbin.org/image/png");

    // Verify 2nd call (chat completions API)
    const [, completionsOptions] = fetchCalls[1];
    const body = JSON.parse(completionsOptions.body);

    expect(body.messages[0].role).toBe("system");
    const userMessage = body.messages[1];
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
    expect(userMessage.content[2].text).toContain("test context");
    expect(body.messages[0].content).toContain(
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
      if (url.startsWith("https://httpbin.org/image/")) {
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
      discord_url: `https://httpbin.org/image/png?source=${id}`,
      uploaded_url: `https://httpbin.org/image/png?source=${id}`,
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

    expect(downloadedUrls).toContain("https://httpbin.org/image/png?source=t3");
    expect(downloadedUrls).toContain("https://httpbin.org/image/png?source=t2");
    expect(downloadedUrls).toContain("https://httpbin.org/image/png?source=t1");
    expect(downloadedUrls).toContain("https://httpbin.org/image/png?source=c7");
    expect(downloadedUrls).not.toContain(
      "https://httpbin.org/image/png?source=c1",
    );
  });

  it("sends verified real PNG and JPEG attachments with realistic Indonesian text", async () => {
    const mockResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              results: [
                {
                  message_id: "m1",
                  status: "warn",
                  flags: ["harassment"],
                  score: 0.65,
                  analysis: "Teks dan gambar perlu ditinjau moderator.",
                },
              ],
            }),
          },
        },
      ],
    };

    const imageBytes = Buffer.from("realistic-image-bytes");
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (
        url === "https://httpbin.org/image/png" ||
        url === "https://httpbin.org/image/jpeg"
      ) {
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () =>
            imageBytes.buffer.slice(
              imageBytes.byteOffset,
              imageBytes.byteOffset + imageBytes.byteLength,
            ),
        });
      }

      return Promise.resolve({
        ok: true,
        text: async () => JSON.stringify(mockResponse),
        json: async () => mockResponse,
      });
    });

    const attachments = [
      {
        id: "png1",
        message_id: "m1",
        guild_id: "guild123",
        channel_id: "channel123",
        thread_id: null,
        user_id: "user123",
        filename: "bukti-chat.png",
        size: 8090,
        type: "image/png",
        discord_url: "https://httpbin.org/image/png",
        uploaded_url: "https://httpbin.org/image/png",
        upload_status: "uploaded" as const,
        upload_error: null,
        created_at: Date.now(),
        uploaded_at: Date.now(),
      },
      {
        id: "jpeg1",
        message_id: "m1",
        guild_id: "guild123",
        channel_id: "channel123",
        thread_id: null,
        user_id: "user123",
        filename: "screenshot.jpeg",
        size: 35588,
        type: "image/jpeg",
        discord_url: "https://httpbin.org/image/jpeg",
        uploaded_url: "https://httpbin.org/image/jpeg",
        upload_status: "uploaded" as const,
        upload_error: null,
        created_at: Date.now() + 1,
        uploaded_at: Date.now() + 1,
      },
    ];

    const result = await runModerationAnalysis({
      targets: [
        createMessageRecord({
          id: "m1",
          username: "asep",
          content:
            "tolong cek gambar ini, dia kirim link mencurigakan https://example.invalid/login dan maksa orang klik",
        }),
      ],
      contextText:
        "Sebelumnya user lain bilang link itu mirip phishing dan screenshot memperlihatkan halaman login palsu.",
      attachments,
    });

    expect(result.results[0].status).toBe("warn");

    const fetchCalls = (global.fetch as any).mock.calls;
    expect(fetchCalls[0][0]).toBe("https://httpbin.org/image/jpeg");
    expect(fetchCalls[1][0]).toBe("https://httpbin.org/image/png");

    const requestBody = JSON.parse(fetchCalls[2][1].body);
    const contentParts = requestBody.messages[1].content;
    expect(
      contentParts.filter((part: any) => part.type === "image_url"),
    ).toHaveLength(2);
    expect(contentParts[0].image_url.url).toContain("data:image/jpeg;base64,");
    expect(contentParts[2].image_url.url).toContain("data:image/png;base64,");
    expect(contentParts.at(-1).text).toContain("https://example.invalid/login");
    expect(contentParts.at(-1).text).toContain("Sebelumnya user lain bilang");
  });

  it("falls back to discord_url when uploaded_url is not ready", async () => {
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
                  analysis: "Image available through Discord URL fallback.",
                },
              ],
            }),
          },
        },
      ],
    };

    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === "https://httpbin.org/image/png") {
        const buffer = Buffer.from("png-bytes");
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () =>
            buffer.buffer.slice(
              buffer.byteOffset,
              buffer.byteOffset + buffer.byteLength,
            ),
        });
      }

      return Promise.resolve({
        ok: true,
        text: async () => JSON.stringify(mockResponse),
        json: async () => mockResponse,
      });
    });

    await runModerationAnalysis({
      targets: [
        createMessageRecord({
          id: "m1",
          content: "gambar belum selesai upload ke tele",
        }),
      ],
      contextText: "test context",
      attachments: [
        {
          id: "pending-image",
          message_id: "m1",
          guild_id: "guild123",
          channel_id: "channel123",
          thread_id: null,
          user_id: "user123",
          filename: "pending.png",
          size: 8090,
          type: "image/png",
          discord_url: "https://httpbin.org/image/png",
          uploaded_url: null,
          upload_status: "pending" as const,
          upload_error: null,
          created_at: Date.now(),
          uploaded_at: null,
        },
      ],
    });

    expect((global.fetch as any).mock.calls[0][0]).toBe(
      "https://httpbin.org/image/png",
    );
  });

  it("keeps analyzing text when an image URL returns non-OK", async () => {
    const mockResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              results: [
                {
                  message_id: "m1",
                  status: "warn",
                  flags: ["suspicious_link"],
                  score: 0.6,
                  analysis:
                    "Image fetch failed, text still indicates suspicious link.",
                },
              ],
            }),
          },
        },
      ],
    };

    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === "https://httpbin.org/image/png") {
        return Promise.resolve({ ok: false, status: 503 });
      }

      return Promise.resolve({
        ok: true,
        text: async () => JSON.stringify(mockResponse),
        json: async () => mockResponse,
      });
    });

    const result = await runModerationAnalysis({
      targets: [
        createMessageRecord({
          id: "m1",
          content: "cek bonus gratis di https://example.invalid/claim sekarang",
        }),
      ],
      contextText:
        "Pesan ini dikirim berulang setelah user lain menolak klik link.",
      attachments: [
        {
          id: "bad-image",
          message_id: "m1",
          guild_id: "guild123",
          channel_id: "channel123",
          thread_id: null,
          user_id: "user123",
          filename: "broken.png",
          size: 8090,
          type: "image/png",
          discord_url: "https://httpbin.org/image/png",
          uploaded_url: "https://httpbin.org/image/png",
          upload_status: "uploaded" as const,
          upload_error: null,
          created_at: Date.now(),
          uploaded_at: Date.now(),
        },
      ],
    });

    expect(result.results[0].status).toBe("warn");

    const requestBody = JSON.parse((global.fetch as any).mock.calls[1][1].body);
    expect(requestBody.messages[1].content).toHaveLength(1);
    expect(requestBody.messages[1].content[0].text).toContain(
      "https://example.invalid/claim",
    );
  });

  describe("Edge Cases & Real-World Scenarios", () => {
    it("handles single result object without results wrapper", () => {
      const content = JSON.stringify({
        message_id: "m1",
        status: "clean",
        flags: [],
        score: 0.1,
        analysis: "OK",
      });

      const result = parseModerationResponse(content, ["m1"]);
      expect(result).toHaveLength(1);
      expect(result[0].messageId).toBe("m1");
      expect(result[0].status).toBe("clean");
    });

    it("handles alternative array key 'result' instead of 'results'", () => {
      const content = JSON.stringify({
        result: [
          {
            message_id: "m1",
            status: "flagged",
            flags: ["spam"],
            score: 0.8,
            analysis: "Spam detected",
          },
        ],
      });

      const result = parseModerationResponse(content, ["m1"]);
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe("flagged");
    });

    it("handles alternative array key 'data' instead of 'results'", () => {
      const content = JSON.stringify({
        data: [
          {
            message_id: "m1",
            status: "warn",
            flags: ["hate_speech"],
            score: 0.6,
            analysis: "Potential hate speech",
          },
        ],
      });

      const result = parseModerationResponse(content, ["m1"]);
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe("warn");
    });

    it("handles alternative array key 'messages' instead of 'results'", () => {
      const content = JSON.stringify({
        messages: [
          {
            message_id: "m1",
            status: "clean",
            flags: [],
            score: 0.05,
            analysis: "No violations",
          },
        ],
      });

      const result = parseModerationResponse(content, ["m1"]);
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe("clean");
    });

    it("handles text with links and URLs", () => {
      const content = JSON.stringify({
        results: [
          {
            message_id: "m1",
            status: "clean",
            flags: [],
            score: 0.1,
            analysis: "Link shared, no violations",
          },
        ],
      });

      const result = parseModerationResponse(content, ["m1"]);
      expect(result[0].status).toBe("clean");
    });

    it("handles very long message content", () => {
      const longContent = "a".repeat(10000);
      const content = JSON.stringify({
        results: [
          {
            message_id: "m1",
            status: "clean",
            flags: [],
            score: 0.1,
            analysis: `Analyzed ${longContent.length} character message`,
          },
        ],
      });

      const result = parseModerationResponse(content, ["m1"]);
      expect(result).toHaveLength(1);
      expect(result[0].analysis).toContain("10000");
    });

    it("handles multiple messages with mixed statuses", () => {
      const content = JSON.stringify({
        results: [
          {
            message_id: "m1",
            status: "clean",
            flags: [],
            score: 0.1,
            analysis: "OK",
          },
          {
            message_id: "m2",
            status: "warn",
            flags: ["spam"],
            score: 0.5,
            analysis: "Potential spam",
          },
          {
            message_id: "m3",
            status: "flagged",
            flags: ["hate_speech", "abuse"],
            score: 0.95,
            analysis: "Severe violations",
          },
        ],
      });

      const result = parseModerationResponse(content, ["m1", "m2", "m3"]);
      expect(result).toHaveLength(3);
      expect(result[0].status).toBe("clean");
      expect(result[1].status).toBe("warn");
      expect(result[2].status).toBe("flagged");
      expect(result[2].flags).toContain("hate_speech");
      expect(result[2].flags).toContain("abuse");
    });

    it("handles LLM response with thinking blocks and markdown", () => {
      const content = `
        <thinking>
          Let me analyze these messages carefully.
          Message 1 seems clean.
          Message 2 has some concerning language.
        </thinking>

        Based on my analysis:

        \`\`\`json
        {
          "results": [
            {
              "message_id": "m1",
              "status": "clean",
              "flags": [],
              "score": 0.1,
              "analysis": "No violations detected"
            },
            {
              "message_id": "m2",
              "status": "warn",
              "flags": ["inappropriate"],
              "score": 0.6,
              "analysis": "Contains inappropriate language"
            }
          ]
        }
        \`\`\`

        These are my findings.
      `;

      const result = parseModerationResponse(content, ["m1", "m2"]);
      expect(result).toHaveLength(2);
      expect(result[0].status).toBe("clean");
      expect(result[1].status).toBe("warn");
    });

    it("handles response with extra fields and nested objects", () => {
      const content = JSON.stringify({
        results: [
          {
            message_id: "m1",
            status: "flagged",
            flags: ["violence"],
            score: 0.9,
            analysis: "Contains violent content",
            metadata: {
              confidence: 0.95,
              model_version: "v2",
              processing_time_ms: 150,
            },
            extra_field: "ignored",
          },
        ],
      });

      const result = parseModerationResponse(content, ["m1"]);
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe("flagged");
      expect(result[0].score).toBe(0.9);
    });

    it("handles scientific notation in score", () => {
      const content = JSON.stringify({
        results: [
          {
            message_id: "m1",
            status: "clean",
            flags: [],
            score: 1e-1,
            analysis: "Very low risk",
          },
        ],
      });

      const result = parseModerationResponse(content, ["m1"]);
      expect(result[0].score).toBe(0.1);
    });

    it("handles empty flags array and null analysis", () => {
      const content = JSON.stringify({
        results: [
          {
            message_id: "m1",
            status: "clean",
            flags: [],
            score: 0,
            analysis: null,
          },
        ],
      });

      const result = parseModerationResponse(content, ["m1"]);
      expect(result[0].flags).toEqual([]);
      expect(result[0].analysis).toBe("");
    });

    it("handles missing optional fields with defaults", () => {
      const content = JSON.stringify({
        results: [
          {
            message_id: "m1",
            status: "clean",
            score: 0.1,
          },
        ],
      });

      const result = parseModerationResponse(content, ["m1"]);
      expect(result[0].flags).toEqual([]);
      expect(result[0].score).toBe(0.1);
      expect(result[0].analysis).toBe("");
    });

    it("handles Unicode and emoji in analysis text", () => {
      const content = JSON.stringify({
        results: [
          {
            message_id: "m1",
            status: "warn",
            flags: ["inappropriate"],
            score: 0.7,
            analysis: "Contains inappropriate emoji 🚫 and symbols ⚠️",
          },
        ],
      });

      const result = parseModerationResponse(content, ["m1"]);
      expect(result[0].analysis).toContain("🚫");
      expect(result[0].analysis).toContain("⚠️");
    });

    it("handles response with only one array in deeply nested object", () => {
      const content = JSON.stringify({
        metadata: { version: 1 },
        analysis_results: [
          {
            message_id: "m1",
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

  describe("Real-World Text Samples", () => {
    it("analyzes message with URL", () => {
      const content = JSON.stringify({
        results: [
          {
            message_id: "m1",
            status: "clean",
            flags: [],
            score: 0.15,
            analysis: "Message contains URL but no violations",
          },
        ],
      });

      const result = parseModerationResponse(content, ["m1"]);
      expect(result[0].status).toBe("clean");
    });

    it("analyzes message with mentions and hashtags", () => {
      const content = JSON.stringify({
        results: [
          {
            message_id: "m1",
            status: "clean",
            flags: [],
            score: 0.05,
            analysis: "Mentions and hashtags are acceptable",
          },
        ],
      });

      const result = parseModerationResponse(content, ["m1"]);
      expect(result[0].status).toBe("clean");
    });

    it("analyzes message with code snippets", () => {
      const content = JSON.stringify({
        results: [
          {
            message_id: "m1",
            status: "clean",
            flags: [],
            score: 0.1,
            analysis: "Code snippet detected, no violations",
          },
        ],
      });

      const result = parseModerationResponse(content, ["m1"]);
      expect(result[0].status).toBe("clean");
    });

    it("analyzes message with mixed languages", () => {
      const content = JSON.stringify({
        results: [
          {
            message_id: "m1",
            status: "clean",
            flags: [],
            score: 0.1,
            analysis: "Mixed language content analyzed successfully",
          },
        ],
      });

      const result = parseModerationResponse(content, ["m1"]);
      expect(result[0].status).toBe("clean");
    });
  });

  describe("Failure Scenarios", () => {
    it("throws on completely invalid JSON", () => {
      expect(() =>
        parseModerationResponse("not json at all", ["m1"]),
      ).toThrow();
    });

    it("throws on empty object", () => {
      expect(() => parseModerationResponse(JSON.stringify({}), ["m1"])).toThrow(
        /missing.*results/i,
      );
    });

    it("throws on array without results wrapper and no message_id", () => {
      expect(() =>
        parseModerationResponse(
          JSON.stringify([
            {
              status: "clean",
              flags: [],
              score: 0.1,
              analysis: "OK",
            },
          ]),
          ["m1"],
        ),
      ).toThrow();
    });

    it("throws on mismatched message IDs", () => {
      expect(() =>
        parseModerationResponse(
          JSON.stringify({
            results: [
              {
                message_id: "m999",
                status: "clean",
                flags: [],
                score: 0.1,
                analysis: "OK",
              },
            ],
          }),
          ["m1"],
        ),
      ).toThrow(/unknown.*message_id/i);
    });

    it("throws on invalid status value", () => {
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

    it("throws on non-finite score", () => {
      const content = `{
        "results": [
          {
            "message_id": "m1",
            "status": "clean",
            "flags": [],
            "score": "NaN",
            "analysis": "OK"
          }
        ]
      }`;

      expect(() => parseModerationResponse(content, ["m1"])).toThrow(/finite/i);
    });
  });
});
