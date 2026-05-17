import { AppError } from "../errors";
import { createChildLogger } from "../logger";
import { discordPlayer } from "../player";
import { playPreparedStream, Streamer } from "../streaming";

const logger = createChildLogger("screen-share");

import type { DiscordPlayerOwner, ScreenSharePlayback } from "./mediaTypes";
import { createYtDlp } from "./ytdlp";

export interface ScreenShareVoiceStatus {
  connected: boolean;
  activeGuildId: string | null;
  activeChannelId: string | null;
}

export interface ScreenShareControllerDependencies {
  getVoiceStatus: () => ScreenShareVoiceStatus;
  getPlayerOwner?: () => DiscordPlayerOwner;
  getDirectVideoUrl?: (source: string) => Promise<string>;
  streamer: Streamer;
  useTranscoder?: boolean;
  onBeforeStreamStart?: (
    guildId: string,
    channelId: string,
  ) => Promise<void> | void;
  onAfterStreamEnd?: (
    guildId: string,
    channelId: string,
  ) => Promise<void> | void;
  onStreamStart?: () => void;
  onStreamEnd?: () => void;
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

  return {
    isActive(): boolean {
      return active !== null;
    },

    async start(source: string): Promise<ScreenSharePlayback> {
      const status = dependencies.getVoiceStatus();
      let voiceReleased = false;
      let voiceRestored = false;

      const restoreVoice = async () => {
        if (voiceRestored || !voiceReleased || !guildId || !channelId) return;
        voiceRestored = true;
        await dependencies.onAfterStreamEnd?.(guildId, channelId);
      };

      if (active) {
        active.stop();
      }

      // Ensure bot is in the voice channel and owns the screen-share stream
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

      const guildId = status.activeGuildId;
      const channelId = status.activeChannelId;

      // If another media owner (e.g. music) holds the shared player, reject
      const owner = getPlayerOwner();
      if (owner === "music") {
        throw new AppError("Another media mode is active", "MEDIA_BUSY", 409);
      }

      try {
        const directUrl = await getDirectVideoUrl(source);
        logger.info(
          {
            guildId,
            channelId,
          },
          "Creating screen share session",
        );
        await dependencies.onBeforeStreamStart?.(guildId, channelId);
        voiceReleased = true;
        const session = await dependencies.streamer.createSession(
          guildId,
          channelId,
        );

        dependencies.onStreamStart?.();

        let stopped = false;
        const playFn = dependencies.useTranscoder
          ? (await import("../streaming")).playTranscodedPreparedStream
          : (await import("../streaming")).playPreparedStream;

        const done = playFn(directUrl, session, {
          fps: 30,
          bitrate: 2500,
          includeAudio: true,
          presetH26x: "superfast",
        }).finally(() => {
          active = null;
          dependencies.onStreamEnd?.();
          return restoreVoice();
        });
        done.catch(() => undefined);
        logger.info(
          {
            guildId,
            channelId,
          },
          "Screen share session started",
        );

        active = {
          done,
          stop() {
            if (stopped) return;
            stopped = true;
            session.stop();
            active = null;
            void restoreVoice();
          },
        };
        return active;
      } catch (error) {
        active = null;
        if (voiceReleased) {
          await restoreVoice();
        }
        logger.error(
          {
            error,
            guildId,
            channelId,
          },
          "Screen share startup failed",
        );
        throw new AppError(
          error instanceof Error ? error.message : "Screen stream failed",
          "SCREEN_STREAM_FAILED",
          500,
        );
      }
    },
  };
}
