import { describe, expect, it } from "vitest";

const { calculateRetryDelay } = await import(
  "../../vendor/discord.js-selfbot-v13/src/rest/RequestHandler.js"
);

describe("calculateRetryDelay", () => {
  it("increases exponentially and applies bounded jitter", () => {
    expect(calculateRetryDelay(1, () => 0)).toBe(250);
    expect(calculateRetryDelay(2, () => 0)).toBe(500);
    expect(calculateRetryDelay(3, () => 0)).toBe(1000);
    expect(calculateRetryDelay(10, () => 0)).toBe(5000);
    expect(calculateRetryDelay(1, () => 0.999)).toBe(499);
  });
});
