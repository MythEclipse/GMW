import type { NextFunction, Request, Response, Router } from "express";
import express from "express";
import { AppError } from "../errors";
import type { MediaController } from "../media/mediaController";
import type { MediaMode } from "../media/mediaTypes";

export type MediaRouteController = Pick<
  MediaController,
  "getState" | "queue" | "skip" | "stop"
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
    adminAuth,
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
    adminAuth,
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
    adminAuth,
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(await controller.stop());
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
