import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { DiscordAudioPlayer } from "../../src/media/mediaTypes";
import { createMusicPlayer } from "../../src/media/musicPlayer";

class FakeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    this.emit("close", 0);
    return true;
  });
}

describe("createMusicPlayer", () => {
  it("spawns ffmpeg as Ogg Opus and passes stdout to Discord", async () => {
    const proc = new FakeProcess();
    const spawn = vi.fn(() => proc);
    const discordPlayer: DiscordAudioPlayer = {
      isConnected: () => true,
      playStream: vi.fn(),
      stop: vi.fn(),
    };
    const player = createMusicPlayer({ spawn, discordPlayer });

    const playback = player.play({
      source: "https://example.com/song.mp3",
      title: "song.mp3",
      kind: "url",
    });
    proc.emit("close", 0);
    await playback.done;

    expect(spawn).toHaveBeenCalledWith(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-i",
        "https://example.com/song.mp3",
        "-vn",
        "-acodec",
        "libopus",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-f",
        "ogg",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(discordPlayer.playStream).toHaveBeenCalledWith(proc.stdout);
  });

  it("rejects playback when Discord is not connected", () => {
    const spawn = vi.fn(() => new FakeProcess());
    const discordPlayer: DiscordAudioPlayer = {
      isConnected: () => false,
      playStream: vi.fn(),
      stop: vi.fn(),
    };
    const player = createMusicPlayer({ spawn, discordPlayer });

    expect(() =>
      player.play({
        source: "/tmp/song.ogg",
        title: "song.ogg",
        kind: "local",
      }),
    ).toThrow("Discord audio player is not connected");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("kills ffmpeg and stops Discord playback once", () => {
    const proc = new FakeProcess();
    const discordPlayer: DiscordAudioPlayer = {
      isConnected: () => true,
      playStream: vi.fn(),
      stop: vi.fn(),
    };
    const player = createMusicPlayer({
      spawn: vi.fn(() => proc),
      discordPlayer,
    });

    const playback = player.play({
      source: "/tmp/song.ogg",
      title: "song.ogg",
      kind: "local",
    });
    playback.stop();
    playback.stop();

    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(discordPlayer.stop).toHaveBeenCalledTimes(1);
  });
});
