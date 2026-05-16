import { beforeEach, describe, expect, it, vi } from "vitest";

// Use vi.hoisted so mocks are available at module evaluation time (when vi.mock hoists)
const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const speaker = {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return speaker;
    }),
    emit: vi.fn((event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) listener(...args);
      return true;
    }),
    removeAllListeners: vi.fn(() => {
      listeners.clear();
      return speaker;
    }),
  };
  return {
    mockSpeaker: speaker,
    mockSubscribe: vi.fn(() => {
      const oggPacketStream = {
        pipe: vi.fn(() => ({ pipe: vi.fn(() => ({ on: vi.fn() })) })),
        unpipe: vi.fn(),
      };
      return {
        pipe: vi.fn(() => oggPacketStream),
        on: vi.fn(),
      };
    }),
    mockDestroy: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockMkdirSync: vi.fn(),
    mockOggPipe: vi.fn(() => ({ pipe: vi.fn(() => ({ on: vi.fn() })) })),
    mockCreateWriteStream: vi.fn(() => ({
      on: vi.fn(),
    })),
    mockFsExistsSync: vi.fn(() => true),
  };
});

vi.mock("node:fs", () => ({
  default: {
    createWriteStream: mocks.mockCreateWriteStream,
    existsSync: mocks.mockFsExistsSync,
    mkdirSync: mocks.mockMkdirSync,
    writeFileSync: mocks.mockWriteFileSync,
  },
  createWriteStream: mocks.mockCreateWriteStream,
  existsSync: mocks.mockFsExistsSync,
  mkdirSync: mocks.mockMkdirSync,
  writeFileSync: mocks.mockWriteFileSync,
}));

vi.mock("prism-media", () => ({
  opus: {
    OggLogicalBitstream: vi.fn(function OggLogicalBitstream() {
      return {
        pipe: mocks.mockOggPipe,
        end: vi.fn(),
      };
    }),
    OpusHead: vi.fn(function OpusHead() {}),
    Decoder: vi.fn(function Decoder() {}),
  },
}));

vi.mock("@discordjs/voice", async () => {
  const actual =
    await vi.importActual<typeof import("@discordjs/voice")>(
      "@discordjs/voice",
    );
  return {
    ...actual,
    joinVoiceChannel: vi.fn(() => ({
      receiver: {
        speaking: mocks.mockSpeaker,
        subscriptions: new Map(),
        subscribe: mocks.mockSubscribe,
      },
      on: vi.fn(),
      destroy: mocks.mockDestroy,
    })),
    entersState: vi.fn().mockResolvedValue(undefined),
    getVoiceConnection: vi.fn(() => ({
      destroy: mocks.mockDestroy,
    })),
  };
});

vi.mock("../src/retry", () => ({
  retryWithBackoff: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

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

describe("startRecording", () => {
  beforeEach(() => {
    mocks.mockSubscribe.mockClear();
    mocks.mockSpeaker.removeAllListeners();
    mocks.mockDestroy.mockClear();
    mocks.mockWriteFileSync.mockClear();
    mocks.mockMkdirSync.mockClear();
    mocks.mockOggPipe.mockClear();
  });

  it("does not subscribe to the bot user's own audio", async () => {
    const { startRecording, resetActiveSessions } = await import(
      "../src/recorder"
    );
    resetActiveSessions();
    const client = { user: { id: "bot-user" } };
    const channel = createChannel();

    await startRecording(client as never, channel as never);
    mocks.mockSpeaker.emit("start", "bot-user");
    await flushMicrotasks();

    expect(mocks.mockSubscribe).not.toHaveBeenCalled();
  });

  it("does not subscribe to other bot users", async () => {
    const { startRecording, resetActiveSessions } = await import(
      "../src/recorder"
    );
    resetActiveSessions();
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
    mocks.mockSpeaker.emit("start", "music-bot");
    await flushMicrotasks();

    expect(mocks.mockSubscribe).not.toHaveBeenCalled();
  });

  it("subscribes to a non-bot human user", async () => {
    const { startRecording, resetActiveSessions } = await import(
      "../src/recorder"
    );
    resetActiveSessions();
    const client = {
      user: { id: "self-user" },
      users: {
        cache: new Map([
          [
            "human-user",
            {
              id: "human-user",
              username: "Alice",
              tag: "Alice#0001",
              bot: false,
              displayAvatarURL: vi.fn(() => "https://example.com/avatar.png"),
            },
          ],
        ]),
        fetch: vi.fn(async () => null),
      },
    };

    await startRecording(client as never, createChannel() as never);
    mocks.mockSpeaker.emit("start", "human-user");
    await flushMicrotasks();

    expect(mocks.mockSubscribe).toHaveBeenCalledTimes(2);
  });
});

describe("stopRecording", () => {
  beforeEach(() => {
    mocks.mockSubscribe.mockClear();
    mocks.mockSpeaker.removeAllListeners();
    mocks.mockDestroy.mockClear();
    mocks.mockWriteFileSync.mockClear();
    mocks.mockMkdirSync.mockClear();
    mocks.mockOggPipe.mockClear();
  });

  it("destroys the voice connection", async () => {
    const { startRecording, stopRecording, resetActiveSessions } = await import(
      "../src/recorder"
    );
    resetActiveSessions();
    const client = { user: { id: "self-user" } };

    await startRecording(client as never, createChannel() as never);
    stopRecording("guild");

    expect(mocks.mockDestroy).toHaveBeenCalled();
  });

  it("finalizes the active recording session", async () => {
    const { startRecording, stopRecording, resetActiveSessions } = await import(
      "../src/recorder"
    );
    resetActiveSessions();
    const client = { user: { id: "self-user" } };

    await startRecording(client as never, createChannel() as never);
    stopRecording("guild");

    await flushMicrotasks();

    expect(mocks.mockMkdirSync).toHaveBeenCalled();
    expect(mocks.mockWriteFileSync).toHaveBeenCalled();
  });
});
