import { describe, expect, it } from "vitest";
import { createDiscordClientOptions } from "../../src/discordClientOptions";

describe("createDiscordClientOptions", () => {
  it("uses low-memory message cache and active sweepers", () => {
    const options = createDiscordClientOptions();

    expect(options.restRequestTimeout).toBe(15_000);
    expect(options.retryLimit).toBe(2);
    expect(options.restGlobalRateLimit).toBe(45);
    expect(options.sweepers).toEqual({
      messages: { interval: 300, lifetime: 600 },
      threads: { interval: 3600, lifetime: 14400 },
    });
    expect(options.partials).toEqual([
      "USER",
      "CHANNEL",
      "GUILD_MEMBER",
      "MESSAGE",
    ]);
  });
});
