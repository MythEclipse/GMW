import { createChildLogger } from "@/shared/logger/index";
import { getDatabase } from "../../shared/database/index.js";

const logger = createChildLogger("ui-state.service");

export class UiStateService {
  async getState() {
    const db = getDatabase();
    logger.debug("Fetching UI state");

    const rows = await db.ui_state.findMany({
      orderBy: { key: "asc" },
    });

    const result: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        result[row.key] = JSON.parse(row.value);
      } catch {
        result[row.key] = row.value;
      }
    }

    return result;
  }

  async updateState(updates: Record<string, unknown>) {
    const db = getDatabase();
    const now = Date.now();

    logger.debug({ keys: Object.keys(updates) }, "Updating UI state");

    for (const [key, value] of Object.entries(updates)) {
      const serialized =
        typeof value === "string" ? value : JSON.stringify(value);

      await db.ui_state.upsert({
        where: { key },
        create: { key, value: serialized, updated_at: BigInt(now) },
        update: { value: serialized, updated_at: BigInt(now) },
      });
    }

    return await this.getState();
  }
}

export const uiStateService = new UiStateService();
