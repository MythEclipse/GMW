import type { NextFunction, Request, Response, Router } from "express";
import express from "express";
import { AppError } from "../errors";
import type { MediaController } from "../media/mediaController";
import type { MediaMode } from "../media/mediaTypes";

export type MediaRouteController = Pick<
  MediaController,
  "getState" | "queue" | "skip" | "stop" | "setMusicVolume"
>;

export interface MediaRouteOptions {
  adminPassword?: string;
}

export function createMediaRoutes(
  controller: MediaRouteController,
  options: MediaRouteOptions = {},
): Router {
  const router = express.Router();
  const { adminPassword } = options;

  const adminAuth = (req: Request, res: Response, next: NextFunction) => {
    if (!adminPassword) return next();
    const authHeader = req.headers["x-admin-password"];
    if (authHeader === adminPassword) {
      next();
    } else {
      res.status(401).json({ error: "Unauthorized access to admin features" });
    }
  };

  // Apply admin auth as router-level middleware so route stack ordering
  // remains predictable for tests that inspect route handlers.
  router.use(adminAuth);

  router.get(
    "/media/status",
    (_req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(controller.getState());
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/media/queue",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { source, mode = "music" } = req.body as {
          source?: string;
          mode?: MediaMode;
        };
        if (!source) {
          throw new AppError(
            "Media source is required",
            "MISSING_MEDIA_SOURCE",
            400,
          );
        }
        if (mode !== "music" && mode !== "screen") {
          throw new AppError("Invalid media mode", "INVALID_MEDIA_MODE", 400);
        }
        res.json(await controller.queue(source, { mode }));
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/media/skip",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(await controller.skip());
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/media/stop",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(await controller.stop());
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/media/volume",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { volume } = req.body as { volume?: number };
        if (typeof volume !== "number" || Number.isNaN(volume)) {
          throw new AppError("Volume is required", "INVALID_VOLUME", 400);
        }
        if (volume < 0 || volume > 1) {
          throw new AppError(
            "Volume must be between 0 and 1",
            "INVALID_VOLUME",
            400,
          );
        }
        res.json(await controller.setMusicVolume(volume));
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
