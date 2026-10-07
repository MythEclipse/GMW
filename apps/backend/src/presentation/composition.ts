/**
 * The composition root: where the object graph is actually built.
 *
 * Kana's `main.ts` equivalent. Everything in `application/` is a class that
 * takes its collaborators as constructor arguments and imports no singleton;
 * this is the one place that reaches into `infrastructure/` for the concrete
 * repositories and the Zod-validated config, and hands the results to
 * `presentation/` (`buildRouter`, `createHttpApp`, the WebSocket servers, the
 * gateway lifecycle).
 *
 * WHY IT SITS IN `presentation/` AND NOT IN `application/`: the rule is that
 * dependencies point inward. `application/` may not import `infrastructure/`
 * singletons, but the graph that joins the two has to live somewhere OUTSIDE
 * both — and this repo has no `main.ts` layer, so the presentation layer, which
 * already wires transports, is the honest home for it.
 *
 * CONSTRUCTION ORDER MATTERS. `getDatabase()` throws "Database not
 * initialized" until `initializeDatabase()` has run, so `buildUseCases()` is
 * called from `presentation/http/server.ts` immediately after that await —
 * never at module load. That is what lets every module above import this file
 * (or the services) in a unit test that has no Postgres at all.
 */
import type { AnalysisSettings } from "../application/analysis/analysis.service.js"
import { AnalysisService } from "../application/analysis/analysis.service.js"
import type { AiLlmSettings } from "../application/chatbot/chatbot.service.js"
import { ChatbotService } from "../application/chatbot/chatbot.service.js"
import { DashboardService } from "../application/dashboard/dashboard.service.js"
import type { RetentionDeps } from "../application/gateway/retention.js"
import { HealthService } from "../application/health/health.service.js"
import { KnowledgeService } from "../application/knowledge/knowledge.service.js"
import { MessagesService } from "../application/messages/messages.service.js"
import { ModerationService } from "../application/moderation/moderation.service.js"
import { UiStateService } from "../application/ui-state/ui-state.service.js"
import { config } from "../infrastructure/config/index.js"
import { getDatabase } from "../infrastructure/database/drizzle.js"
import { AnalysisRepository } from "../infrastructure/repositories/analysis.repository.js"
import { ChatbotRepository } from "../infrastructure/repositories/chatbot.repository.js"
import { DashboardRepository } from "../infrastructure/repositories/dashboard.repository.js"
import { HealthRepository } from "../infrastructure/repositories/health.repository.js"
import { KnowledgeRepository } from "../infrastructure/repositories/knowledge.repository.js"
import { MessagesRepository } from "../infrastructure/repositories/messages.repository.js"
import { ModerationRepository } from "../infrastructure/repositories/moderation.repository.js"
import { RetentionRepository } from "../infrastructure/repositories/retention.repository.js"
import { UiStateRepository } from "../infrastructure/repositories/ui-state.repository.js"

/**
 * Every use-case the presentation layer may call — the single source of truth
 * for what `/trpc`, `/ws` and `/api/health` can reach.
 *
 * The concrete repository classes appear here rather than as domain ports
 * because the repositories ARE the seam in this codebase: each one takes a
 * `DatabaseHandle` in its constructor and every use-case takes its repository
 * as a parameter, which is what rule 3 of the Kana non-negotiables asks for.
 */
export interface UseCases {
	analysis: AnalysisService
	chatbot: ChatbotService
	dashboard: DashboardService
	health: HealthService
	knowledge: KnowledgeService
	messages: MessagesService
	moderation: ModerationService
	uiState: UiStateService
}

const analysisSettings = (): AnalysisSettings => ({
	monitorGuildId: config.MONITOR_GUILD_ID,
})

const aiLlmSettings = (): AiLlmSettings => ({
	apiKey: config.AI_LLM_API_KEY,
	baseUrl: config.AI_LLM_BASE_URL,
	model: config.AI_LLM_MODEL,
})

/** Build the graph. Call only after `initializeDatabase()` has resolved. */
export function buildUseCases(): UseCases {
	const db = getDatabase()

	return {
		analysis: new AnalysisService(
			new AnalysisRepository(db),
			analysisSettings(),
		),
		chatbot: new ChatbotService(new ChatbotRepository(db), aiLlmSettings()),
		dashboard: new DashboardService(new DashboardRepository(db)),
		health: new HealthService(new HealthRepository(db)),
		knowledge: new KnowledgeService(new KnowledgeRepository(db)),
		messages: new MessagesService(new MessagesRepository(db)),
		moderation: new ModerationService(new ModerationRepository(db)),
		uiState: new UiStateService(new UiStateRepository(db)),
	}
}

/**
 * Retention runs in the gateway lifecycle rather than per-request, so it is
 * wired separately — but from the same place, with the same construction rule.
 */
export function buildRetentionDeps(): RetentionDeps {
	return {
		retention: new RetentionRepository(getDatabase()),
		settings: {
			intervalMs: config.RETENTION_CLEANUP_INTERVAL_MS,
			messagesDays: config.RETENTION_MESSAGES_DAYS,
			attachmentsDays: config.RETENTION_ATTACHMENTS_DAYS,
		},
	}
}
