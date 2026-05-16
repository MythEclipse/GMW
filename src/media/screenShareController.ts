import type { Readable } from "node:stream";
import {
  playStream as defaultPlayStream,
  prepareStream as defaultPrepareStream,
  Encoders,
  Utils,
} from "@dank074/discord-video-stream";
import { AppError } from "../errors";
import { createChildLogger } from "../logger";
import { discordPlayer } from "../player";

const logger = createChildLogger("screen-share");
import type { DiscordPlayerOwner, ScreenSharePlayback } from "./mediaTypes";
import { createYtDlp } from "./ytdlp";

export interface ScreenShareVoiceStatus {
  connected: boolean;
  activeGuildId: string | null;
  activeChannelId: string | null;
}

interface PreparedScreenStream {
  command: { kill?: (signal: NodeJS.Signals) => unknown };
  output: Readable;
}

type PrepareScreenStream = (
  source: string,
  options: object,
) => PreparedScreenStream;

type PlayScreenStream = (
  output: Readable,
  streamer: unknown,
  options: { type: "go-live" },
) => Promise<void>;

export interface ScreenShareControllerDependencies {
  getVoiceStatus: () => ScreenShareVoiceStatus;
  getPlayerOwner?: () => DiscordPlayerOwner;
  getDirectVideoUrl?: (source: string) => Promise<string>;
  prepareStream?: PrepareScreenStream;
  playStream?: PlayScreenStream;
  streamer: unknown;
}

export function createScreenShareController(
  dependencies: ScreenShareControllerDependencies,
) {
  let active: ScreenSharePlayback | null = null;
  const ytdlp = createYtDlp();
  const getPlayerOwner =
    dependencies.getPlayerOwner ?? (() => discordPlayer.getOwner());
  const getDirectVideoUrl =
    dependencies.getDirectVideoUrl ??
    ((source) => ytdlp.getDirectVideoUrl(source));
  const prepareStream =
    dependencies.prepareStream ??
    (defaultPrepareStream as unknown as PrepareScreenStream);
  const playStream =
    dependencies.playStream ??
    (defaultPlayStream as unknown as PlayScreenStream);

  return {
    isActive(): boolean {
      return active !== null;
    },

    async start(source: string): Promise<ScreenSharePlayback> {
      const status = dependencies.getVoiceStatus();
      if (
        !status.connected ||
        !status.activeGuildId ||
        !status.activeChannelId
      ) {
        throw new AppError(
          "Connect to a voice channel before sharing screen",
          "VOICE_NOT_CONNECTED",
          409,
        );
      }

      if (active) {
        active.stop();
      }

      try {
        const directUrl = await getDirectVideoUrl(source);
        const { command, output } = prepareStream(directUrl, {
          encoder: Encoders.software({ x264: { preset: "superfast" } }),
          height: 720,
          frameRate: 30,
          bitrateVideo: 2500,
          bitrateVideoMax: 4000,
          includeAudio: true,
          videoCodec: Utils.normalizeVideoCodec("H264"),
        });

        // Add FFmpeg error logging
        if (command && "stderr" in command && (command as any).stderr) {
          (command as any).stderr.on("data", (data: Buffer) => {
            if (data.toString().includes("Error")) {
              logger.error({ error: data.toString() }, "FFmpeg Screen Error");
            }
          });
        }

        let stopped = false;
        const done = playStream(output, dependencies.streamer, {
          type: "go-live",
        }).finally(() => {
          active = null;
        });

        active = {
          done,
          stop() {
            if (stopped) return;
            stopped = true;
            command.kill?.("SIGTERM");
            active = null;
          },
        };
        return active;
      } catch (error) {
        active = null;
        throw new AppError(
          error instanceof Error ? error.message : "Screen stream failed",
          "SCREEN_STREAM_FAILED",
          500,
        );
      }
    },
  };
}
