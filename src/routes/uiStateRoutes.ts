import type { Router } from "express";
import express from "express";
import type { SharedUIState, SharedUIStatePatch } from "../state/uiState";

export { SharedUIState, SharedUIStatePatch };

export interface UIStateRouteOptions {
  getSharedUIState: () => SharedUIState;
  patchSharedUIState: (
    patch: SharedUIStatePatch,
  ) => Promise<SharedUIState> | SharedUIState;
}

export function createUIStateRoutes(options: UIStateRouteOptions): Router {
  const router = express.Router();
  const { getSharedUIState, patchSharedUIState } = options;

  // GET /api/ui-state - Get current UI state
  router.get("/ui-state", (_req, res, next) => {
    try {
      const state = getSharedUIState();
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/ui-state - Update UI state
  router.post("/ui-state", async (req, res, next) => {
    try {
      const patch = req.body as SharedUIStatePatch;
      const updated = await patchSharedUIState(patch);
      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
