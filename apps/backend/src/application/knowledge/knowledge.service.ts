import { createChildLogger } from "../../infrastructure/logger/index.js"
import type { KnowledgeRepository } from "../../infrastructure/repositories/knowledge.repository.js"

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
