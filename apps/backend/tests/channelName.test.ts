import { describe, expect, it } from "vitest";
import { readChannelName } from "../src/shared/utils/channelName.js";

/**
 * `messages.metadata` is a `text` column holding a JSON document, NOT a jsonb
 * column. Prisma therefore returns it as a raw string, so the `-> 'channel' ->
 * > 'channelName'` traversal has to parse before it can read.
 *
 * Getting this wrong is silent: `readChannelName` returns `undefined`, callers
 * fall back to `channel_id`, and the dashboard shows raw ids where channel
 * names belong. The comparison harness caught it in two repositories at once,
 * which is why it is pinned here.
 */
describe("readChannelName", () => {
  it("parses the text column, which is how Prisma returns metadata", () => {
    expect(readChannelName('{"channel":{"channelName":"general"}}')).toBe(
      "general",
    );
  });

  it("also accepts an already-decoded object (jsonb columns)", () => {
    expect(readChannelName({ channel: { channelName: "general" } })).toBe(
      "general",
    );
  });

  it("returns undefined for a blank channelName so the caller falls back to the id", () => {
    expect(readChannelName('{"channel":{"channelName":""}}')).toBeUndefined();
  });

  it("returns undefined when the key path is absent", () => {
    expect(readChannelName('{"channel":{"other":"x"}}')).toBeUndefined();
    expect(readChannelName('{"other":"x"}')).toBeUndefined();
    expect(readChannelName('{"channel":null}')).toBeUndefined();
  });

  it("does not throw on malformed JSON — one bad row must not fail the query", () => {
    // The `::jsonb` cast this replaced aborted the ENTIRE query on the first
    // malformed row, taking the whole page down with it.
    expect(readChannelName("not json")).toBeUndefined();
    expect(readChannelName("{unclosed")).toBeUndefined();
    expect(readChannelName("[1,2,3]")).toBeUndefined();
  });

  it("returns undefined for nullish and empty input", () => {
    expect(readChannelName(null)).toBeUndefined();
    expect(readChannelName(undefined)).toBeUndefined();
    expect(readChannelName("")).toBeUndefined();
  });
});
