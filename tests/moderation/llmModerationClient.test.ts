import { describe, expect, it } from "vitest";
import { parseModerationResponse } from "../../src/moderation/llmModerationClient";

describe("parseModerationResponse", () => {
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
});
