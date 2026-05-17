import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/errors";
import { MediaController } from "../../src/media/mediaController";
import type {
  MusicPlayback,
  MusicPlayer,
  ResolvedMediaSource,
  ScreenShareController,
} from "../../src/media/mediaTypes";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function source(input: string): ResolvedMediaSource {
  return { source: input, title: input.split("/").pop() || input, kind: "url" };
}

describe("MediaController", () => {
  it("rejects queue playback when voice is not connected", async () => {
    const controller = new MediaController({
      isVoiceConnected: () => false,
      isBrowserStreaming: () => false,
      resolveMediaSource: async () => source("https://example.com/song.mp3"),
      musicPlayer: { play: vi.fn() },
    });

    await expect(
      controller.queue("https://example.com/song.mp3"),
    ).rejects.toMatchObject({
      code: "VOICE_NOT_CONNECTED",
      statusCode: 409,
    } satisfies Partial<AppError>);
  });

  it("rejects queue playback while browser streaming is active", async () => {
    const controller = new MediaController({
      isVoiceConnected: () => true,
      isBrowserStreaming: () => true,
      resolveMediaSource: async () => source("https://example.com/song.mp3"),
      musicPlayer: { play: vi.fn() },
    });

    await expect(
      controller.queue("https://example.com/song.mp3"),
    ).rejects.toMatchObject({
      code: "BROWSER_STREAM_ACTIVE",
      statusCode: 409,
    } satisfies Partial<AppError>);
  });

  it("queues and starts the first item", async () => {
    const done = deferred();
    const playback: MusicPlayback = { done: done.promise, stop: vi.fn() };
    const musicPlayer: MusicPlayer = { play: vi.fn(() => playback) };
    const controller = new MediaController({
      isVoiceConnected: () => true,
      isBrowserStreaming: () => false,
      resolveMediaSource: async () => source("https://example.com/song.mp3"),
      musicPlayer,
    });

    const state = await controller.queue("https://example.com/song.mp3");

    expect(state.playing).toBe(true);
    expect(state.current?.title).toBe("song.mp3");
    expect(musicPlayer.play).toHaveBeenCalledWith(state.current);
  });

  it("advances to the next item when playback finishes", async () => {
    const first = deferred();
    const second = deferred();
    const musicPlayer: MusicPlayer = {
      play: vi
        .fn()
        .mockReturnValueOnce({ done: first.promise, stop: vi.fn() })
        .mockReturnValueOnce({ done: second.promise, stop: vi.fn() }),
    };
    const controller = new MediaController({
      isVoiceConnected: () => true,
      isBrowserStreaming: () => false,
      resolveMediaSource: async (input) => source(input),
      musicPlayer,
    });

    await controller.queue("https://example.com/first.mp3");
    await controller.queue("https://example.com/second.mp3");
    first.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    expect(controller.getState().current?.title).toBe("second.mp3");
  });

  it("skips current playback and starts the next item", async () => {
    const currentStop = vi.fn();
    const nextPlayback = deferred();
    const musicPlayer: MusicPlayer = {
      play: vi
        .fn()
        .mockReturnValueOnce({
          done: new Promise<void>(() => {}),
          stop: currentStop,
        })
        .mockReturnValueOnce({ done: nextPlayback.promise, stop: vi.fn() }),
    };
    const controller = new MediaController({
      isVoiceConnected: () => true,
      isBrowserStreaming: () => false,
      resolveMediaSource: async (input) => source(input),
      musicPlayer,
    });
    await controller.queue("https://example.com/first.mp3");
    await controller.queue("https://example.com/second.mp3");

    const state = await controller.skip();

    expect(currentStop).toHaveBeenCalled();
    expect(state.current?.title).toBe("second.mp3");
  });

  it("ignores stale completion after skip starts the next item", async () => {
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const musicPlayer: MusicPlayer = {
      play: vi
        .fn()
        .mockReturnValueOnce({ done: first.promise, stop: vi.fn() })
        .mockReturnValueOnce({ done: second.promise, stop: vi.fn() })
        .mockReturnValueOnce({ done: third.promise, stop: vi.fn() }),
    };
    const controller = new MediaController({
      isVoiceConnected: () => true,
      isBrowserStreaming: () => false,
      resolveMediaSource: async (input) => source(input),
      musicPlayer,
    });
    await controller.queue("https://example.com/first.mp3");
    await controller.queue("https://example.com/second.mp3");
    await controller.queue("https://example.com/third.mp3");

    await controller.skip();
    first.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    expect(controller.getState().current?.title).toBe("second.mp3");
    expect(musicPlayer.play).toHaveBeenCalledTimes(2);
  });

  it("advances when player throws while starting an item", async () => {
    const second = deferred();
    const musicPlayer: MusicPlayer = {
      play: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("not connected");
        })
        .mockReturnValueOnce({ done: second.promise, stop: vi.fn() }),
    };
    const controller = new MediaController({
      isVoiceConnected: () => true,
      isBrowserStreaming: () => false,
      resolveMediaSource: async (input) => source(input),
      musicPlayer,
    });

    await controller.queue("https://example.com/first.mp3");
    await controller.queue("https://example.com/second.mp3");

    expect(controller.getState().current?.title).toBe("second.mp3");
  });

  it("stops current playback and clears the queue", async () => {
    const stop = vi.fn();
    const controller = new MediaController({
      isVoiceConnected: () => true,
      isBrowserStreaming: () => false,
      resolveMediaSource: async (input) => source(input),
      musicPlayer: {
        play: vi.fn(() => ({ done: new Promise<void>(() => {}), stop })),
      },
    });
    await controller.queue("https://example.com/song.mp3");

    const state = await controller.stop();

    expect(stop).toHaveBeenCalled();
    expect(state).toEqual({
      playing: false,
      activeMode: null,
      musicVolume: 1,
      current: null,
      queue: [],
    });
  });

  it("starts screen share mode by resolving the video source", async () => {
    const screenPlayback = deferred();
    const screenController: ScreenShareController = {
      isActive: vi.fn(() => false),
      start: vi.fn(async () => ({
        done: screenPlayback.promise,
        stop: vi.fn(),
      })),
    };
    const resolveMediaSource = vi.fn(async (input, mode) => source(input));
    const controller = new MediaController({
      isVoiceConnected: () => true,
      isBrowserStreaming: () => false,
      resolveMediaSource,
      musicPlayer: { play: vi.fn() },
      screenController,
    });

    const state = await controller.queue("https://youtu.be/video", {
      mode: "screen",
    });

    expect(screenController.start).toHaveBeenCalledWith(
      "https://youtu.be/video",
    );
    expect(resolveMediaSource).toHaveBeenCalledWith("https://youtu.be/video", "screen");
    expect(state).toMatchObject({ playing: true, activeMode: "screen" });
  });

  it("rejects music while screen share is active", async () => {
    const screenController: ScreenShareController = {
      isActive: vi.fn(() => true),
      start: vi.fn(),
    };
    const controller = new MediaController({
      isVoiceConnected: () => true,
      isBrowserStreaming: () => false,
      resolveMediaSource: async (input) => source(input),
      musicPlayer: { play: vi.fn() },
      screenController,
    });

    await expect(
      controller.queue("https://example.com/song.mp3"),
    ).rejects.toMatchObject({
      code: "MEDIA_BUSY",
      statusCode: 409,
    } satisfies Partial<AppError>);
  });

  it("emits state changes", async () => {
    const onStateChange = vi.fn();
    const controller = new MediaController({
      isVoiceConnected: () => true,
      isBrowserStreaming: () => false,
      resolveMediaSource: async (input) => source(input),
      musicPlayer: {
        play: vi.fn(() => ({
          done: new Promise<void>(() => {}),
          stop: vi.fn(),
        })),
      },
      onStateChange,
    });

    await controller.queue("https://example.com/song.mp3");

    expect(onStateChange).toHaveBeenCalledWith(
      expect.objectContaining({ playing: true }),
    );
  });
});
