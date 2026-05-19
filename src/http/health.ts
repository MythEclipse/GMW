import { Router } from "express";
import { getMetrics, uptimeGauge } from "../metrics";

export interface HealthRoutesOptions {
  adminPassword: string;
  activeUserCount: () => number;
  wsClientCount: () => number;
}

export function createHealthRoutes(options: HealthRoutesOptions) {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      activeUsers: options.activeUserCount(),
      wsClients: options.wsClientCount(),
    });
  });

  router.get("/metrics", async (_req, res) => {
    res.set("Content-Type", "text/plain");
    uptimeGauge.set(process.uptime());
    res.send(await getMetrics());
  });

  router.post("/api/auth/login", (req, res) => {
    const { password } = req.body;
    if (password === options.adminPassword) {
      res.json({ ok: true });
      return;
    }
    res.status(401).json({ error: "Invalid password" });
  });

  return router;
}
