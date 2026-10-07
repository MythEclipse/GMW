/**
 * Public surface of the moderation module.
 *
 * Deliberately tiny. v1's barrel exported 9 symbols across 56 files, which
 * meant callers could reach any layer and the module's real shape was
 * invisible from outside. Everything here is a deliberate seam.
 */

export {
	createDefaultGateway,
	HttpLlmGateway,
	LlmUnavailableError,
} from "./llmGateway.js"
export {
	buildMemoryTags,
	buildRecallQuery,
	DEFAULT_MEMORY_BANK_CONFIG,
	extractMemoryAuthor,
	extractMemoryContext,
	filterByTags,
	formatMemoryContent,
	formatMemoryContext,
	type MemoryAuthor,
	type MemoryBankConfig,
	type MemoryContext,
	type MemoryMessage,
	ModerationMemoryBank,
} from "./memoryBank.js"
export {
	type BuildPromptOptions,
	buildSystemPrompt,
	CHANNEL_CONTEXT_RULES,
	clearPromptCache,
	POLICY_VERSION,
	type PromptMode,
} from "./policy.js"
export {
	normaliseAction,
	type ParseBatchResult,
	type ParsedVerdict,
	parseVerdicts,
	VERDICT_ACTIONS,
	type VerdictAction,
} from "./verdictParser.js"
export {
	assertLeaseCoversLlmTimeout,
	type ClaimedMessage,
	DEFAULT_WORKER_CONFIG,
	ModerationWorker,
	type WorkerConfig,
	type WorkerStats,
} from "./worker.js"
