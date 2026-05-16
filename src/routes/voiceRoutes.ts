import type { NextFunction, Request, Response, Router } from "express";
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
  adminPassword?: string;
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
  let adminPassword: string | undefined;

  if ("connect" in options && "disconnect" in options) {
    // Old signature: just VoiceController
    voiceController = options as VoiceController;
  } else {
    // New signature: options object
    const opts = options as VoiceRouteOptions;
    voiceController = opts.voiceController;
    patchSharedUIState = opts.patchSharedUIState;
    broadcaster = opts.broadcaster;
    adminPassword = opts.adminPassword;
  }

  const adminAuth = (req: Request, res: Response, next: NextFunction) => {
    if (!adminPassword) return next();
    const authHeader = req.headers["x-admin-password"];
    if (authHeader === adminPassword) {
      next();
    } else {
      res.status(401).json({ error: "Unauthorized access to admin features" });
    }
  };

  // GET /api/status - Get voice connection status
  router.get("/status", (_req: Request, res: Response, next: NextFunction) => {
    try {
      const status = voiceController.getStatus();
      res.json(status);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/guilds - List available guilds
  router.get("/guilds", (_req: Request, res: Response, next: NextFunction) => {
    try {
      const guilds = voiceController.listGuilds();
      res.json(guilds);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/guilds/:guildId/voice-channels - List voice channels in a guild
  router.get(
    "/guilds/:guildId/voice-channels",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { guildId } = req.params;

        if (!guildId) {
          throw new AppError("Guild ID is required", "MISSING_GUILD_ID", 400);
        }

        const channels = await voiceController.listVoiceChannels(
          guildId as string,
        );
        res.json(channels);
      } catch (error) {
        next(error);
      }
    },
  );

  // GET /api/guilds/:guildId/channels - List text channels in a guild
  router.get(
    "/guilds/:guildId/channels",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { guildId } = req.params;

        if (!guildId) {
          throw new AppError("Guild ID is required", "MISSING_GUILD_ID", 400);
        }

        const channels = await voiceController.listWatchableChannels(
          guildId as string,
        );
        res.json(channels);
      } catch (error) {
        next(error);
      }
    },
  );

  // POST /api/connect - Connect to a voice channel
  router.post(
    "/connect",
    adminAuth,
    async (req: Request, res: Response, next: NextFunction) => {
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
            selectedVoiceGuild: guildId,
            selectedVoiceChannel: channelId,
          });
          broadcaster.uiState(updatedState);
        }

        res.json(status);
      } catch (error) {
        next(error);
      }
    },
  );

  // POST /api/disconnect - Disconnect from voice channel
  router.post(
    "/disconnect",
    adminAuth,
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        logger.info("Disconnecting from voice channel");

        const status = await voiceController.disconnect();

        // Update UI state and broadcast to connected clients
        if (patchSharedUIState && broadcaster) {
          const updatedState = patchSharedUIState({
            selectedVoiceGuild: "",
            selectedVoiceChannel: "",
          });
          broadcaster.uiState(updatedState);
        }

        res.json(status);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
