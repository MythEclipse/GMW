import type { Router } from "express";
import express from "express";
import { AppError } from "../errors";
import { createChildLogger } from "../logger";
import type { ModerationBroadcaster } from "../moderation/broadcaster";
import type { VoiceController } from "../voiceController";
import type { SharedUIState } from "./uiStateRoutes";

const logger = createChildLogger("voice-routes");

export interface VoiceRouteOptions {
  voiceController: VoiceController;
  patchSharedUIState: (patch: Partial<SharedUIState>) => SharedUIState;
  broadcaster: ModerationBroadcaster;
}

export function createVoiceRoutes(
  options: VoiceRouteOptions | VoiceController,
): Router {
  const router = express.Router();

  // Support both old signature (VoiceController) and new signature (options object)
  let voiceController: VoiceController;
  let patchSharedUIState:
    | ((patch: Partial<SharedUIState>) => SharedUIState)
    | undefined;
  let broadcaster: ModerationBroadcaster | undefined;

  if ("connect" in options && "disconnect" in options) {
    // Old signature: just VoiceController
    voiceController = options as VoiceController;
  } else {
    // New signature: options object
    const opts = options as VoiceRouteOptions;
    voiceController = opts.voiceController;
    patchSharedUIState = opts.patchSharedUIState;
    broadcaster = opts.broadcaster;
  }

  // GET /api/status - Get voice connection status
  router.get("/status", (_req, res, next) => {
    try {
      const status = voiceController.getStatus();
      res.json(status);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/guilds - List available guilds
  router.get("/guilds", (_req, res, next) => {
    try {
      const guilds = voiceController.listGuilds();
      res.json(guilds);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/guilds/:guildId/voice-channels - List voice channels in a guild
  router.get("/guilds/:guildId/voice-channels", async (req, res, next) => {
    try {
      const { guildId } = req.params;

      if (!guildId) {
        throw new AppError("Guild ID is required", "MISSING_GUILD_ID", 400);
      }

      const channels = await voiceController.listVoiceChannels(guildId);
      res.json(channels);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/guilds/:guildId/channels - List text channels in a guild
  router.get("/guilds/:guildId/channels", async (req, res, next) => {
    try {
      const { guildId } = req.params;

      if (!guildId) {
        throw new AppError("Guild ID is required", "MISSING_GUILD_ID", 400);
      }

      const channels = await voiceController.listWatchableChannels(guildId);
      res.json(channels);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/guilds/:guildId/threads - List threads in a guild
  router.get("/guilds/:guildId/threads", async (req, res, next) => {
    try {
      const { guildId } = req.params;

      if (!guildId) {
        throw new AppError("Guild ID is required", "MISSING_GUILD_ID", 400);
      }

      const threads = await voiceController.listThreads(guildId);
      res.json(threads);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/connect - Connect to a voice channel
  router.post("/connect", async (req, res, next) => {
    try {
      const { guildId, channelId } = req.body as {
        guildId?: string;
        channelId?: string;
      };

      if (!guildId || !channelId) {
        throw new AppError(
          "guildId and channelId are required",
          "MISSING_CONNECT_FIELDS",
          400,
        );
      }

      logger.info({ guildId, channelId }, "Connecting to voice channel");

      const status = await voiceController.connect(guildId, channelId);

      // Update UI state and broadcast to connected clients
      if (patchSharedUIState && broadcaster) {
        const updatedState = patchSharedUIState({
          selectedGuild: guildId,
          selectedVoiceChannel: channelId,
        });
        broadcaster.uiState(updatedState);
      }

      res.json(status);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/disconnect - Disconnect from voice channel
  router.post("/disconnect", async (_req, res, next) => {
    try {
      logger.info("Disconnecting from voice channel");

      const status = await voiceController.disconnect();

      // Update UI state and broadcast to connected clients
      if (patchSharedUIState && broadcaster) {
        const updatedState = patchSharedUIState({
          selectedGuild: "",
          selectedVoiceChannel: "",
        });
        broadcaster.uiState(updatedState);
      }

      res.json(status);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
