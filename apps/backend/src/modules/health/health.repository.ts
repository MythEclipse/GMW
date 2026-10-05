import { sql } from "drizzle-orm";
import { getDatabase } from "@/shared/database/drizzle";
import { createChildLogger } from "@/shared/logger/index";

const logger = createChildLogger("health.repository");

export class HealthRepository {
  async checkDatabaseConnection() {
    try {
      logger.debug("Running database health check");
      // Drizzle's `sql` template, not Prisma's `$queryRaw`. This endpoint is
      // what deploy-direct.sh probes on every deploy, so it is the first query
      // ported off Prisma (P1a) — retiring Prisma can no longer break deploys.
      await getDatabase().execute(sql`SELECT 1`);
      logger.debug("Database health check passed");
      return { connected: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ error: message }, "Database health check failed");
      return { connected: false, error: message };
    }
  }
}

export const healthRepository = new HealthRepository();
