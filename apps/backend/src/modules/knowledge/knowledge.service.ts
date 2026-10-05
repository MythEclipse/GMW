import { getDatabase } from "@/shared/database/drizzle"
import { createChildLogger } from "../../shared/logger/index.js"
import { KnowledgeRepository } from "./knowledge.repository.js"

const logger = createChildLogger("knowledge.service")

export class KnowledgeService {
	constructor(private readonly repository: KnowledgeRepository) {}

	async listChannelCultures(limit = 50, search?: string) {
		logger.debug({ limit, search }, "Listing channel cultures")
		return this.repository.listChannelCultures(limit, search)
	}

	async listGlossary(limit = 50, search?: string) {
		logger.debug({ limit, search }, "Listing glossary terms")
		return this.repository.listGlossary(limit, search)
	}
}

/**
 * Lazily constructed, not built at import time.
 *
 * `createKnowledgeService()` calls `getDatabase()`, which throws until
 * `initializeDatabase()` has run. Deferring construction to first call keeps
 * importing this file free of a database, which is what lets a unit test
 * import the service and pass its own repository.
 *
 * Still one instance per process, which is what the oRPC router and the
 * gateway assume when they import `knowledgeService`.
 */
let instance: KnowledgeService | undefined

export const createKnowledgeService = () =>
	new KnowledgeService(new KnowledgeRepository(getDatabase()))

export const knowledgeService: Pick<
	KnowledgeService,
	"listChannelCultures" | "listGlossary"
> = {
	listChannelCultures: (
		...args: Parameters<KnowledgeService["listChannelCultures"]>
	) => {
		instance ??= createKnowledgeService()
		return instance.listChannelCultures(...args) as ReturnType<
			KnowledgeService["listChannelCultures"]
		>
	},
	listGlossary: (...args: Parameters<KnowledgeService["listGlossary"]>) => {
		instance ??= createKnowledgeService()
		return instance.listGlossary(...args) as ReturnType<
			KnowledgeService["listGlossary"]
		>
	},
}
