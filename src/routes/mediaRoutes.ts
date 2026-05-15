import type { Router } from "express";
import express from "express";
import { AppError } from "../errors";
import type { MediaController } from "../media/mediaController";

export type MediaRouteController = Pick<
  MediaController,
  "getState" | "queue" | "skip" | "stop"
>;

export function createMediaRoutes(controller: MediaRouteController): Router {
  const router = express.Router();

  router.get("/media/status", (_req, res, next) => {
    try {
      res.json(controller.getState());
    } catch (error) {
      next(error);
    }
  });

  router.post("/media/queue", async (req, res, next) => {
    try {
      const { source } = req.body as { source?: string };
      if (!source) {
        throw new AppError(
          "Media source is required",
          "MISSING_MEDIA_SOURCE",
          400,
        );
      }
      res.json(await controller.queue(source));
    } catch (error) {
      next(error);
    }
  });

  router.post("/media/skip", async (_req, res, next) => {
    try {
      res.json(await controller.skip());
    } catch (error) {
      next(error);
    }
  });

  router.post("/media/stop", async (_req, res, next) => {
    try {
      res.json(await controller.stop());
    } catch (error) {
      next(error);
    }
  });

  return router;
}
