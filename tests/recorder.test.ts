import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const speaking = new EventEmitter();
const subscribe = vi.fn();
const joinVoiceChannel = vi.fn(() => ({
  receiver: {
    speaking,
    subscriptions: new Map(),
    subscribe,
  },
  on: vi.fn(),
  destroy: vi.fn(),
}));

function createChannel() {
  return {
    id: "voice-channel",
    name: "Voice",
    guild: {
      id: "guild",
      voiceAdapterCreator: {},
      members: {
        cache: new Map(),
        fetch: vi.fn(async () => null),
      },
    },
  };
}

vi.mock("@discordjs/voice", async () => {
  const actual =
    await vi.importActual<typeof import("@discordjs/voice")>(
      "@discordjs/voice",
    );
  return {
    ...actual,
    joinVoiceChannel,
    entersState: vi.fn(async () => undefined),
  };
});

describe("startRecording", () => {
  beforeEach(() => {
    subscribe.mockClear();
    speaking.removeAllListeners();
  });

  it("does not subscribe to the bot user's own audio", async () => {
    const { startRecording } = await import("../src/recorder");
    const client = {
      user: { id: "bot-user" },
    };
    const channel = createChannel();

    await startRecording(client as never, channel as never);
    speaking.emit("start", "bot-user");
    await new Promise((resolve) => setImmediate(resolve));

    expect(subscribe).not.toHaveBeenCalled();
  });

  it("does not subscribe to other bot users", async () => {
    const { startRecording } = await import("../src/recorder");
    const client = {
      user: { id: "self-user" },
      users: {
        cache: new Map([
          [
            "music-bot",
            {
              id: "music-bot",
              username: "Jockie Music",
              tag: "Jockie Music#8158",
              bot: true,
              displayAvatarURL: vi.fn(() => "https://example.com/avatar.png"),
            },
          ],
        ]),
        fetch: vi.fn(async () => null),
      },
    };

    await startRecording(client as never, createChannel() as never);
    speaking.emit("start", "music-bot");
    await new Promise((resolve) => setImmediate(resolve));

    expect(subscribe).not.toHaveBeenCalled();
  });
});
