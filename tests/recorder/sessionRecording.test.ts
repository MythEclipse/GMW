import { describe, expect, it, vi } from "vitest";
import {
  buildSessionMuxFilter,
  createRecordingSession,
  finalizeRecordingSession,
} from "../../src/recorder/sessionRecording";
import type { UserMetadata } from "../../src/types";

function user(overrides: Partial<UserMetadata> = {}): UserMetadata {
  return {
    userId: "user-1",
    username: "Alice",
    tag: "Alice#0001",
    displayName: "Alice",
    avatarUrl: "https://example.com/avatar.png",
    bot: false,
    roles: [],
    highestRole: null,
    joinedTimestamp: null,
    ...overrides,
  };
}

describe("sessionRecording", () => {
  it("tracks participants and segment refs", () => {
    const session = createRecordingSession({
      guildId: "guild",
      channelId: "voice",
      channelName: "Voice",
      startTime: 1000,
      recordingsDir: "/recordings",
    });

    session.registerSegment({
      user: user(),
      oggPath: "/recordings/user-1/1500.ogg",
      jsonPath: "/recordings/user-1/1500.json",
      startTime: 1500,
      endTime: 2500,
    });

    const snapshot = session.snapshot(3000);

    expect(snapshot).toMatchObject({
      sessionId: "guild-voice-1000",
      guildId: "guild",
      channelId: "voice",
      channelName: "Voice",
      startTime: 1000,
      endTime: 3000,
      durationMs: 2000,
      status: "pending",
      participants: [{ userId: "user-1", username: "Alice" }],
      segments: [
        {
          userId: "user-1",
          oggPath: "/recordings/user-1/1500.ogg",
          jsonPath: "/recordings/user-1/1500.json",
          startTime: 1500,
          endTime: 2500,
          offsetMs: 500,
        },
      ],
    });
  });

  it("builds timeline-offset ffmpeg filter", () => {
    const filter = buildSessionMuxFilter(
      [{ startTime: 1000 }, { startTime: 2500 }],
      1000,
    );
    expect(filter).toBe(
      "[0:a]adelay=0|0[pad0];[1:a]adelay=1500|1500[pad1];[pad0][pad1]amix=inputs=2:dropout_transition=0[out]",
    );
  });

  it("writes empty metadata without running ffmpeg", async () => {
    const session = createRecordingSession({
      guildId: "guild",
      channelId: "voice",
      channelName: "Voice",
      startTime: 1000,
      recordingsDir: "/recordings",
    });
    const writeJson = vi.fn();
    const mkdir = vi.fn();
    const runFfmpeg = vi.fn();

    await finalizeRecordingSession(session, {
      endTime: 4000,
      mkdir,
      writeJson,
      runFfmpeg,
    });

    expect(runFfmpeg).not.toHaveBeenCalled();
    expect(mkdir).toHaveBeenCalledWith("/recordings/sessions/guild-voice-1000");
    expect(writeJson).toHaveBeenCalledWith(
      "/recordings/sessions/guild-voice-1000/session.json",
      expect.objectContaining({ status: "empty", durationMs: 3000 }),
    );
  });
});
