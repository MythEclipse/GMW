import { createChildLogger } from "../../infrastructure/logger/index.js"
import type { UiStateRepository } from "../../infrastructure/repositories/ui-state.repository.js"

const logger = createChildLogger("ui-state.service")

/**
 * Read and write the dashboard's UI preferences (theme, panel state, …).
 *
 * The bag is opaque by design — this layer neither validates nor interprets
 * its keys. All persistence lives in `UiStateRepository`, injected by
 * `presentation/composition.ts`, so importing this file needs no database.
 */
export class UiStateService {
	constructor(private readonly repository: UiStateRepository) {}

	async getState(): Promise<Record<string, unknown>> {
		logger.debug("Fetching UI state")
		return this.repository.getAll()
	}

	/** Write the given keys, then return the full map so callers skip a refetch. */
	async updateState(
		updates: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		logger.debug({ keys: Object.keys(updates) }, "Updating UI state")
		await this.repository.putAll(updates)
		return await this.getState()
	}
}
