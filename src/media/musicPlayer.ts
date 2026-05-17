import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { StreamType } from "@discordjs/voice";
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

      let stderrOutput = "";
      proc.stderr.on("data", (chunk) => {
        stderrOutput += chunk.toString();
        const line = chunk.toString().trim();
        if (line && !line.includes("frame=")) {
          console.log("[musicPlayer] ffmpeg:", line);
        }
      });

      audioPlayer.playStream(proc.stdout, "music", {
        inputType: StreamType.Raw,
        inlineVolume: true,
      });

      let stopped = false;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        audioPlayer.stop("music");
      };

      const done = new Promise<void>((resolve, reject) => {
        proc.on("error", (error) => {
          console.error("[musicPlayer] Process error:", error);
          release();
          reject(error);
        });
        proc.stdout.on("error", (error) => {
          console.error("[musicPlayer] Stdout error:", error);
          release();
          reject(error);
        });
        proc.on("close", (code) => {
          release();
          if (code === 0 || stopped) {
            resolve();
            return;
          }
          const errorMsg = `ffmpeg exited with code ${code}`;
          console.error("[musicPlayer]", errorMsg);
          if (stderrOutput) {
            console.error("[musicPlayer] ffmpeg stderr:", stderrOutput.slice(-500));
          }
          reject(new Error(errorMsg));
        });
      });

      return {
        done,
        stop() {
          if (stopped) return;
          stopped = true;
          proc.kill("SIGTERM");
          release();
        },
      };
    },
  };
}

export function buildFfmpegArgs(source: string): string[] {
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
  ];

  if (source.startsWith("http://") || source.startsWith("https://")) {
    args.push(
      "-user_agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36"
    );
    args.push("-connect_timeout", "10");
    args.push("-read_timeout", "30");
  }

  args.push(
    "-i",
    source,
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
  );

  console.log("[ffmpeg] Command:", "ffmpeg", args.join(" ").slice(0, 200) + "...");
  return args;
}
