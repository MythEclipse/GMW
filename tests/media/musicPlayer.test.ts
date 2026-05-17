import type { spawn as nodeSpawn } from "node:child_process";

type Spawn = typeof nodeSpawn;

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { StreamType } from "@discordjs/voice";
import { describe, expect, it, vi } from "vitest";
import type {
  DiscordAudioPlayer,
  DiscordPlayerOwner,
} from "../../src/media/mediaTypes";
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
  it("spawns ffmpeg as raw PCM and passes stdout to Discord", async () => {
    const proc = new FakeProcess();
    const spawn = vi.fn(() => proc);
    const discordPlayer: DiscordAudioPlayer = {
      isConnected: () => true,
      playStream: vi.fn(),
      getOwner: vi.fn((): DiscordPlayerOwner => "none"),
      getMusicVolume: vi.fn(() => 1),
      setMusicVolume: vi.fn(),
      pause: vi.fn(),
      unpause: vi.fn(() => true),
      stop: vi.fn(),
    };
    const player = createMusicPlayer({
      spawn: spawn as unknown as Spawn,
      discordPlayer,
    });

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
        "pcm_s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-f",
        "s16le",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(discordPlayer.playStream).toHaveBeenCalledWith(
      proc.stdout,
      "music",
      {
        inputType: StreamType.Raw,
        inlineVolume: true,
      },
    );
  });

  it("rejects playback when Discord is not connected", () => {
    const spawn = vi.fn(() => new FakeProcess());
    const discordPlayer: DiscordAudioPlayer = {
      isConnected: () => false,
      playStream: vi.fn(),
      getOwner: vi.fn((): DiscordPlayerOwner => "none"),
      getMusicVolume: vi.fn(() => 1),
      setMusicVolume: vi.fn(),
      pause: vi.fn(),
      unpause: vi.fn(() => true),
      stop: vi.fn(),
    };
    const player = createMusicPlayer({
      spawn: spawn as unknown as Spawn,
      discordPlayer,
    });

    expect(() =>
      player.play({
        source: "/tmp/song.ogg",
        title: "song.ogg",
        kind: "local",
      }),
    ).toThrow("Discord audio player is not connected");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("releases ownership on normal ffmpeg close", async () => {
    const proc = new FakeProcess();
    const discordPlayer: DiscordAudioPlayer = {
      isConnected: () => true,
      playStream: vi.fn(),
      getOwner: vi.fn((): DiscordPlayerOwner => "none"),
      getMusicVolume: vi.fn(() => 1),
      setMusicVolume: vi.fn(),
      pause: vi.fn(),
      unpause: vi.fn(() => true),
      stop: vi.fn(),
    };
    const player = createMusicPlayer({
      spawn: vi.fn(() => proc) as unknown as Spawn,
      discordPlayer,
    });

    const playback = player.play({
      source: "/tmp/song.ogg",
      title: "song.ogg",
      kind: "local",
    });
    // simulate normal close
    proc.emit("close", 0);
    await playback.done;
    expect(discordPlayer.stop).toHaveBeenCalledWith("music");
  });

  it("kills ffmpeg and stops Discord playback once", () => {
    const proc = new FakeProcess();
    const discordPlayer: DiscordAudioPlayer = {
      isConnected: () => true,
      playStream: vi.fn(),
      getOwner: vi.fn((): DiscordPlayerOwner => "none"),
      getMusicVolume: vi.fn(() => 1),
      setMusicVolume: vi.fn(),
      pause: vi.fn(),
      unpause: vi.fn(() => true),
      stop: vi.fn(),
    };
    const player = createMusicPlayer({
      spawn: vi.fn(() => proc) as unknown as Spawn,
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
