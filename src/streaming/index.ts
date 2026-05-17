import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import { PassThrough } from "node:stream";
import {
  Streamer as DankStreamer,
  playStream as dankPlayStream,
  prepareStream as dankPrepareStream,
  Encoders,
  Utils,
} from "@dank074/discord-video-stream";
import type { Client } from "discord.js-selfbot-v13";

type VoiceConnectionLike = any;
type StreamConnectionLike = any;

export interface StreamPlayOptions {
  fps?: number;
  bitrate?: number | string;
  includeAudio?: boolean;
  presetH26x?: string;
}

export interface StreamSession {
  connection: VoiceConnectionLike;
  stream: StreamConnectionLike;
  play(source: string | Readable, options?: StreamPlayOptions): Promise<void>;
  stop(): void;
}

export const UtilsAPI = {
  normalizeVideoCodec: (c: string) => c.toUpperCase?.() ?? c,
};

export class Streamer {
  client: Client;
  dankStreamer: DankStreamer;

  constructor(client: Client) {
    this.client = client;
    this.dankStreamer = new DankStreamer(client);
  }

  async createSession(
    guildId: string,
    channelId: string,
  ): Promise<StreamSession> {
    await this.dankStreamer.joinVoice(guildId, channelId);

    let stopped = false;
    let currentCommand: any = null;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      try {
        if (currentCommand?.kill) currentCommand.kill("SIGKILL");
      } catch (e) {
        // ignore
      }
      this.dankStreamer.stopStream();
      this.dankStreamer.leaveVoice();
    };

    return {
      connection: {} as any,
      stream: {} as any,
      play: async (
        source: string | Readable,
        options: StreamPlayOptions = {},
      ) => {
        if (stopped) return;

        let targetSource: string | Readable = source;
        if (typeof source === "string" && source.includes("\n")) {
          const urls = source.split("\n").filter((u) => u.trim());
          targetSource = urls[0] ?? source;
        }

        const fps = options.fps ?? 60;
        const bitrateStr = String(options.bitrate ?? 8000).replace(/k$/i, "");
        const bitrateVideo = parseInt(bitrateStr, 10) || 8000;

        console.log(
          "[Streamer] Starting screen share for source:",
          typeof targetSource === "string"
            ? targetSource.slice(0, 50) + "..."
            : "ReadableStream",
        );
        const { command, output } = dankPrepareStream(targetSource, {
          encoder: Encoders.software({
            x264: { preset: (options.presetH26x as any) ?? "ultrafast" },
            x265: { preset: (options.presetH26x as any) ?? "ultrafast" },
          }),
          videoCodec: Utils.normalizeVideoCodec("H264"),
          width: 1920,
          height: 1080,
          bitrateVideo: bitrateVideo,
          frameRate: fps,
          includeAudio: options.includeAudio !== false,
          minimizeLatency: false,
          customInputOptions: ["-fflags nobuffer"],
          customHeaders: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.3",
            Connection: "keep-alive",
          },
        });

        currentCommand = command;

        const webOutput = new PassThrough();
        const discordOutput = new PassThrough();

        output.pipe(webOutput);
        output.pipe(discordOutput);

        const globalAny: any = globalThis;
        const onData = (chunk: Buffer) => {
          try {
            globalAny.broadcastVideoToWeb?.(chunk);
          } catch {
            // ignore
          }
        };
        webOutput.on("data", onData);

        command.on("error", (err: Error) => {
          console.error("[Streamer] Transcoder error:", err);
        });
        command.on("stderr", (stderrLine: string) => {
          console.error("[Streamer] FFMPEG:", stderrLine);
        });
        command.on("end", () => {
          console.log("[Streamer] FFMPEG process ended naturally.");
        });

        try {
          console.log("[Streamer] Calling dankPlayStream...");
          await dankPlayStream(discordOutput, this.dankStreamer, undefined);
          console.log("[Streamer] dankPlayStream completed successfully.");
        } catch (err) {
          console.error("[Streamer] dankPlayStream error:", err);
        } finally {
          console.log("[Streamer] Cleaning up stream resources.");
          webOutput.off("data", onData);
          stop();
        }
      },
      stop,
    };
  }
}

export function prepareStream(source: string, _options: any): any {
  return { command: null, output: new PassThrough() };
}

export async function playStream(): Promise<void> {
  return;
}

export async function createStreamSession(
  client: Client,
  guildId: string,
  channelId: string,
): Promise<StreamSession> {
  return new Streamer(client).createSession(guildId, channelId);
}

export async function playPreparedStream(
  source: string | Readable,
  session: StreamSession,
  options: StreamPlayOptions = {},
): Promise<void> {
  await session.play(source, options);
}

export async function playTranscodedPreparedStream(
  source: string | Readable,
  session: StreamSession,
  options: StreamPlayOptions = {},
): Promise<void> {
  await session.play(source, options);
}
