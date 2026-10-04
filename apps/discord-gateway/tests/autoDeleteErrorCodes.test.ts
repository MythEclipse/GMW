import { describe, expect, it } from "bun:test";

import { isAlreadyDeletedError } from "../src/modules/ai-moderation/autoDeleteManager.js";

/**
 * The delete path used to record Discord's MESSAGE_ID_NOT_FOUND as a failure,
 * which put a permanent stream of red "failed" rows in the dashboard for
 * deletes that had already happened — a human moderator, another bot, or
 * Discord's own retention removed the message first.
 *
 * In production, 7 of 20 failing attempts were messages that really were gone
 * (their messages.deleted_at was set) yet recorded as status='failed'.
 */
describe("isAlreadyDeletedError", () => {
  it("treats Discord's numeric unknown-message codes as already gone", () => {
    for (const code of [10008, 10003, 50001, 404]) {
      expect(isAlreadyDeletedError({ code })).toBe(true);
      expect(isAlreadyDeletedError({ code: String(code) })).toBe(true);
    }
  });

  it("treats MESSAGE_ID_NOT_FOUND as already gone", () => {
    expect(isAlreadyDeletedError({ code: "MESSAGE_ID_NOT_FOUND" })).toBe(true);
    expect(isAlreadyDeletedError({ code: "MESSAGE_ID_NOT_FOUND_TYPE" })).toBe(
      true,
    );
  });

  it("reads the code out of the nested discord.js error shape", () => {
    // discord.js-selfbot-v13 wraps the REST error one level down.
    expect(
      isAlreadyDeletedError({
        name: "DiscordAPIError",
        code: "MESSAGE_ID_NOT_FOUND",
        message: "Unknown Message",
      }),
    ).toBe(true);
  });

  it("does not swallow real failures", () => {
    // 50013 Missing Permissions is a genuine failure: the account should be
    // fixed, not silently reported as a successful delete.
    expect(isAlreadyDeletedError({ code: 50013 })).toBe(false);
    expect(isAlreadyDeletedError({ code: "50013" })).toBe(false);
    expect(isAlreadyDeletedError({ code: 30003 })).toBe(false);
  });

  it("returns false for a non-error value instead of throwing", () => {
    expect(isAlreadyDeletedError(undefined)).toBe(false);
    expect(isAlreadyDeletedError(null)).toBe(false);
    expect(isAlreadyDeletedError("some string")).toBe(false);
  });
});
