import type { Router } from "express";
import express from "express";
import { AppError } from "../errors.js";
import {
  getAnalyticsOverview,
  getHourlyStats,
  getModerationStats,
  getTopViolators,
  getTopicTrends,
  getUserLeaderboard,
} from "../moderation/analyticsStore.js";

export function createAnalyticsRoutes(): Router {
  const router = express.Router();

  // GET /api/analytics/overview - Full analytics dashboard data
  // Query params: guildId (required), channelId, hours (default 24)
  router.get("/analytics/overview", async (req, res, next) => {
    try {
      const {
        guildId,
        channelId,
        hours,
      } = req.query as {
        guildId?: string;
        channelId?: string;
        hours?: string;
      };

      if (!guildId) {
        throw new AppError(
          "guildId query parameter is required",
          "MISSING_GUILD_ID",
          400,
        );
      }

      const hoursNum = hours ? Math.min(parseInt(hours) || 24, 168) : 24;

      const overview = await getAnalyticsOverview({
        guildId,
        channelId,
        hours: hoursNum,
      });

      res.json(overview);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/analytics/hourly - Hourly message stats
  // Query params: guildId (required), channelId, hours (default 24)
  router.get("/analytics/hourly", async (req, res, next) => {
    try {
      const {
        guildId,
        channelId,
        hours,
      } = req.query as {
        guildId?: string;
        channelId?: string;
        hours?: string;
      };

      if (!guildId) {
        throw new AppError(
          "guildId query parameter is required",
          "MISSING_GUILD_ID",
          400,
        );
      }

      const hoursNum = hours ? Math.min(parseInt(hours) || 24, 168) : 24;

      const stats = await getHourlyStats({
        guildId,
        channelId,
        hours: hoursNum,
      });

      res.json(stats);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/analytics/topics - Topic trends
  // Query params: guildId (required), channelId, hours (default 24)
  router.get("/analytics/topics", async (req, res, next) => {
    try {
      const {
        guildId,
        channelId,
        hours,
      } = req.query as {
        guildId?: string;
        channelId?: string;
        hours?: string;
      };

      if (!guildId) {
        throw new AppError(
          "guildId query parameter is required",
          "MISSING_GUILD_ID",
          400,
        );
      }

      const hoursNum = hours ? Math.min(parseInt(hours) || 24, 168) : 24;

      const topics = await getTopicTrends({
        guildId,
        channelId,
        hours: hoursNum,
      });

      res.json(topics);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/analytics/leaderboard - User leaderboard
  // Query params: guildId (required), channelId, hours (default 24), limit (default 20)
  router.get("/analytics/leaderboard", async (req, res, next) => {
    try {
      const {
        guildId,
        channelId,
        hours,
        limit,
      } = req.query as {
        guildId?: string;
        channelId?: string;
        hours?: string;
        limit?: string;
      };

      if (!guildId) {
        throw new AppError(
          "guildId query parameter is required",
          "MISSING_GUILD_ID",
          400,
        );
      }

      const hoursNum = hours ? Math.min(parseInt(hours) || 24, 168) : 24;
      const limitNum = limit ? Math.min(parseInt(limit) || 20, 100) : 20;

      const users = await getUserLeaderboard({
        guildId,
        channelId,
        hours: hoursNum,
        limit: limitNum,
      });

      res.json(users);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/analytics/stats - Moderation stats breakdown
  // Query params: guildId (required), channelId, hours (default 24)
  router.get("/analytics/stats", async (req, res, next) => {
    try {
      const {
        guildId,
        channelId,
        hours,
      } = req.query as {
        guildId?: string;
        channelId?: string;
        hours?: string;
      };

      if (!guildId) {
        throw new AppError(
          "guildId query parameter is required",
          "MISSING_GUILD_ID",
          400,
        );
      }

      const hoursNum = hours ? Math.min(parseInt(hours) || 24, 168) : 24;

      const stats = await getModerationStats({
        guildId,
        channelId,
        hours: hoursNum,
      });

      res.json(stats);
    } catch (error) {
      next(error);
    }
  });

  // GET /api/analytics/violators - Top violators leaderboard
  // Query params: guildId (required), channelId, hours (default 24), limit (default 20)
  router.get("/analytics/violators", async (req, res, next) => {
    try {
      const {
        guildId,
        channelId,
        hours,
        limit,
      } = req.query as {
        guildId?: string;
        channelId?: string;
        hours?: string;
        limit?: string;
      };

      if (!guildId) {
        throw new AppError(
          "guildId query parameter is required",
          "MISSING_GUILD_ID",
          400,
        );
      }

      const hoursNum = hours ? Math.min(parseInt(hours) || 24, 168) : 24;
      const limitNum = limit ? Math.min(parseInt(limit) || 20, 100) : 20;

      const violators = await getTopViolators({
        guildId,
        channelId,
        hours: hoursNum,
        limit: limitNum,
      });

      res.json(violators);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
