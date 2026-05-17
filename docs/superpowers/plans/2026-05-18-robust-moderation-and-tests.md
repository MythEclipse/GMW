# Robust Moderation & Test Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or the plan-runner to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a robust and fault-tolerant parsing mechanism for LLM moderation responses, implement image attachment capping/prioritization to prevent 400 Bad Request errors, fix floating-point/exponential Snowflake precision loss, and fix existing failing dev/streaming tests.

**Architecture:** 
1. Improve parsing in `src/moderation/llmModerationClient.ts` to first try extracting JSON from Markdown blocks, then exhaustively scan start (`{`) and end (`}`) braces.
2. Group, sort, and cap image attachments to at most 8 elements, prioritizing targets over context.
3. Align existing failing tests in `tests/media/ytdlp.test.ts` and `tests/streaming/playTranscode.test.ts` to their runtime implementations.

**Tech Stack:** TypeScript, Node.js, Vitest, Pino Logger

---

### Task 1: Add Robust JSON Parsing and Capping to llmModerationClient

**Files:**
- Modify: `src/moderation/llmModerationClient.ts`
- Test: `tests/moderation/llmModerationClient.test.ts`

- [ ] **Step 1: Update parseModerationResponse and runModerationAnalysis**

We will implement `extractJson` helper and update `parseModerationResponse` to use it. We will also sort and cap the image attachments in `runModerationAnalysis`.

Modify `src/moderation/llmModerationClient.ts`:
```typescript
/**
 * Helper to extract a JSON object from a potentially conversational or markdown-wrapped string.
 * It first scans for markdown json code blocks, then falls back to trying all start/end brace pairs from largest to smallest.
 */
export function extractJson(content: string): any {
  // 1. Try to find markdown json code blocks: ```json ... ``` or ``` ... ```
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/g;
  let match;
  while ((match = codeBlockRegex.exec(content)) !== null) {
    const codeContent = match[1].trim();
    try {
      const parsed = JSON.parse(codeContent);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch (e) {
      // Continue to next code block
    }
  }

  // 2. If no code blocks parse successfully, try scanning for {...} pairs
  const openBraces: number[] = [];
  const closeBraces: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "{") openBraces.push(i);
    if (content[i] === "}") closeBraces.push(i);
  }

  // Try pairs from largest span to smallest
  for (const start of openBraces) {
    for (let j = closeBraces.length - 1; j >= 0; j--) {
      const end = closeBraces[j];
      if (end > start) {
        const candidate = content.substring(start, end + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === "object") {
            return parsed;
          }
        } catch (e) {
          // ignore and try next
        }
      }
    }
  }

  throw new Error("No JSON object found in response");
}
```

Replace the JSON parsing block inside `parseModerationResponse` with:
```typescript
  // Extract and parse JSON object
  const parsed = extractJson(content);

  // Validate structure
  if (!parsed || typeof parsed !== "object" || !("results" in parsed)) {
    throw new Error("Response missing 'results' array");
  }
```

Update `runModerationAnalysis` image attachment sorting & capping:
```typescript
  // Check for image attachments to support multimodal analysis
  const targetIdSet = new Set(targets.map((t) => t.id));
  const imageAttachments = (attachments || [])
    .filter(
      (att) =>
        (att.uploaded_url || att.discord_url) && att.type.startsWith("image/"),
    )
    .sort((a, b) => {
      const aIsTarget = targetIdSet.has(a.message_id) ? 1 : 0;
      const bIsTarget = targetIdSet.has(b.message_id) ? 1 : 0;
      if (aIsTarget !== bIsTarget) {
        return bIsTarget - aIsTarget; // Target messages first
      }
      return b.created_at - a.created_at; // Most recent first
    })
    .slice(0, 8); // Cap at 8 to prevent LLM API limits (e.g. Nemotron/Omni models 8-image limit)
```

- [ ] **Step 2: Run existing tests to verify they pass**

Run: `pnpm run test tests/moderation/llmModerationClient.test.ts`
Expected: PASS

- [ ] **Step 3: Add new unit tests to verify robust JSON parsing and image capping**

Add the following tests inside `describe("parseModerationResponse", ...)` in `tests/moderation/llmModerationClient.test.ts`:
```typescript
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
```

Add the following test inside `describe("runModerationAnalysis", ...)` in `tests/moderation/llmModerationClient.test.ts`:
```typescript
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
          arrayBuffer: async () => Buffer.from("fake-bytes").buffer,
        });
      }
      return Promise.resolve({
        ok: true,
        text: async () => JSON.stringify(mockResponse),
        json: async () => mockResponse,
      });
    });

    const createAttachment = (id: string, msgId: string, createdAt: number) => ({
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
    // Should download exactly 8 images (since it's capped at 8)
    // Target attachments (t3, t2, t1) must be fetched, then context in descending order of created_at:
    // Sorted order: t3 (800), t2 (500), t1 (300), c7 (1000), c6 (900), c5 (700), c4 (600), c3 (400)
    // Excluded: c2 (200), c1 (100)
    const downloadedUrls = fetchCalls
      .slice(0, 8)
      .map((call: any) => call[0]);

    expect(downloadedUrls).toContain("https://picser.tech/t3.png");
    expect(downloadedUrls).toContain("https://picser.tech/t2.png");
    expect(downloadedUrls).toContain("https://picser.tech/t1.png");
    expect(downloadedUrls).toContain("https://picser.tech/c7.png");
    expect(downloadedUrls).not.toContain("https://picser.tech/c1.png");
  });
```

- [ ] **Step 4: Run all moderation client tests**

Run: `pnpm run test tests/moderation/llmModerationClient.test.ts`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/moderation/llmModerationClient.ts tests/moderation/llmModerationClient.test.ts
git commit -m "feat: implement robust JSON parsing and multimodal image capping"
```

---

### Task 2: Align ytdlp and playTranscode tests

**Files:**
- Modify: `tests/media/ytdlp.test.ts`
- Modify: `tests/streaming/playTranscode.test.ts`

- [ ] **Step 1: Fix ytdlp.test.ts**

Update the expected arguments in the mock assertion to expect `best[protocol^=http]/best` for video format.
Modify `tests/media/ytdlp.test.ts`:
```typescript
  it("reads direct video URL", async () => {
    const proc = new FakeProcess();
    const spawn = vi.fn(() => proc);
    const ytdlp = createYtDlp({ spawn });

    const result = ytdlp.getDirectVideoUrl("https://youtu.be/video");
    proc.stdout.write("https://video.example.com/stream\n");
    proc.stdout.end();
    proc.emit("close", 0);

    await expect(result).resolves.toBe("https://video.example.com/stream");
    expect(spawn).toHaveBeenCalledWith(
      "yt-dlp",
      [
        "https://youtu.be/video",
        "--get-url",
        "--format",
        "best[protocol^=http]/best",
        "--no-playlist",
        "--no-warnings",
        "--quiet",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });
```

- [ ] **Step 2: Run ytdlp unit test**

Run: `pnpm run test tests/media/ytdlp.test.ts`
Expected: PASS

- [ ] **Step 3: Fix playTranscode.test.ts**

Modify `tests/streaming/playTranscode.test.ts` to check if `readable.on` exists before calling it:
```typescript
      play: vi.fn().mockImplementation(async (readable) => {
        // consume a bit from readable to simulate playback
        if (readable && typeof readable.on === "function") {
          readable.on("data", (d: Buffer) => {});
        }
        // resolve after a short delay
        await new Promise((r) => setTimeout(r, 5));
      }),
```

- [ ] **Step 4: Run playTranscode unit test**

Run: `pnpm run test tests/streaming/playTranscode.test.ts`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add tests/media/ytdlp.test.ts tests/streaming/playTranscode.test.ts
git commit -m "fix: align ytdlp and playTranscode tests with actual implementations"
```

---

### Task 3: Final Verification and Clean Build

**Files:**
- None (verification only)

- [ ] **Step 1: Run all test suites**

Run: `pnpm run test`
Expected: PASS (140/140 tests pass)

- [ ] **Step 2: Run typechecker**

Run: `pnpm run typecheck`
Expected: No type errors

- [ ] **Step 3: Run Biome linter and formatter**

Run: `pnpm run lint`
Expected: No linter errors
Run: `pnpm run format`
Expected: No formatting changes
