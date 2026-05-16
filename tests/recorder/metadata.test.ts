import { describe, expect, it } from "vitest";
import { createSegmentMetadata } from "../../src/recorder/metadata";
import type { SegmentState, UserMetadata } from "../../src/types";

describe("createSegmentMetadata", () => {
  const user: UserMetadata = {
    userId: "user-1",
    username: "Alice",
    tag: "Alice#0001",
    displayName: "Alice",
    avatarUrl: "https://example.com/avatar.png",
    bot: false,
    roles: [],
    highestRole: null,
    joinedTimestamp: null,
  };

  const segment = {
    index: 0,
    startTime: 1500,
    endTime: 2500,
    filename: "/recordings/user-1/1500.ogg",
    jsonFilename: "/recordings/user-1/1500.json",
    oggStream: {} as any,
    out: {} as any,
  } as SegmentState;

  it("includes shared recording session id", () => {
    const metadata = createSegmentMetadata(
      user,
      segment,
      "user-1-1500",
      "guild-voice-1000",
      1000,
      5000,
    );

    expect(metadata).toMatchObject({
      sessionId: "user-1-1500",
      recordingSessionId: "guild-voice-1000",
      sessionStartTime: 1000,
      startTime: 1500,
      endTime: 2500,
    });
  });
});
