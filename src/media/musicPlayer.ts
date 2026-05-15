import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { discordPlayer } from "../player";
import type {
  DiscordAudioPlayer,
  MusicPlayback,
  MusicPlayer,
  ResolvedMediaSource,
} from "./mediaTypes";

export interface MusicPlayerDependencies {
  spawn?: typeof nodeSpawn;
  discordPlayer?: DiscordAudioPlayer;
}

export function createMusicPlayer(
  dependencies: MusicPlayerDependencies = {},
): MusicPlayer {
  const spawn = dependencies.spawn ?? nodeSpawn;
  const audioPlayer = dependencies.discordPlayer ?? discordPlayer;

  return {
    play(source: ResolvedMediaSource): MusicPlayback {
      if (!audioPlayer.isConnected()) {
        throw new Error("Discord audio player is not connected");
      }

      const proc = spawn("ffmpeg", buildFfmpegArgs(source.source), {
        stdio: ["ignore", "pipe", "pipe"],
      }) as unknown as ChildProcessWithoutNullStreams;
      proc.stderr.resume();

      audioPlayer.playStream(proc.stdout);

      let stopped = false;
      const done = new Promise<void>((resolve, reject) => {
        proc.on("error", reject);
        proc.stdout.on("error", reject);
        proc.on("close", (code) => {
          if (code === 0 || stopped) {
            resolve();
            return;
          }
          reject(new Error(`ffmpeg exited with code ${code}`));
        });
      });

      return {
        done,
        stop() {
          if (stopped) return;
          stopped = true;
          proc.kill("SIGTERM");
          audioPlayer.stop();
        },
      };
    },
  };
}

export function buildFfmpegArgs(source: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-i",
    source,
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
  ];
}
