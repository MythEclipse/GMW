import { asc } from "drizzle-orm";
import { getDatabase } from "@/shared/database/drizzle";
import { uiStateTable } from "@/shared/database/schema";
import { createChildLogger } from "@/shared/logger/index";

const logger = createChildLogger("ui-state.service");

export class UiStateService {
  async getState() {
    const db = getDatabase();
    logger.debug("Fetching UI state");

    const rows = await db
      .select()
      .from(uiStateTable)
      .orderBy(asc(uiStateTable.key));

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

      // Was Prisma's `upsert({where, create, update})`; Drizzle's equivalent is
      // `onConflictDoUpdate`, which states the same single-statement intent
      // rather than a read-then-write race.
      await db
        .insert(uiStateTable)
        .values({ key, value: serialized, updated_at: now })
        .onConflictDoUpdate({
          target: uiStateTable.key,
          set: { value: serialized, updated_at: now },
        });
    }

    return await this.getState();
  }
}

export const uiStateService = new UiStateService();
