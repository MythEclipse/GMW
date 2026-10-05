import { getDatabase } from "@/shared/database/drizzle"
import { NotFoundError, ValidationError } from "@/shared/errors/index"
import { createChildLogger } from "@/shared/logger/index"
import type { EditPageResult, ReviewPageResult } from "./messages.repository.js"
import { MessagesRepository } from "./messages.repository.js"
import type { MessageQuery } from "./messages.schema.js"

const logger = createChildLogger("messages.service")

export class MessagesService {
	constructor(private readonly repository: MessagesRepository) {}

	async listMessages(
		query: MessageQuery,
	): Promise<Awaited<ReturnType<MessagesRepository["findMany"]>>> {
		if (!query.channelId && !query.guildId) {
			throw new ValidationError("Either channelId or guildId is required")
		}

		logger.debug({ query }, "Listing messages")
		return this.repository.findMany(query)
	}

	/**
	 * Stream messages one at a time (no 50-row batch). The WS handler iterates
	 * this generator and emits one `message_snapshot` frame per message.
	 */
	streamMessages(query: MessageQuery, pageSize = 50) {
		return this.repository.streamMany(query, pageSize)
	}

	async getMessagesByChannel(
		channelId: string,
		query: MessageQuery,
	): Promise<Awaited<ReturnType<MessagesRepository["findByChannel"]>>> {
		if (!channelId) {
			throw new ValidationError("channelId is required")
		}

		logger.debug({ channelId, query }, "Getting messages by channel")
		return this.repository.findByChannel(channelId, query)
	}

	async getMessageById(id: string): Promise<
		NonNullable<Awaited<ReturnType<MessagesRepository["findById"]>>> & {
			edit_count: number
			edit_history: Awaited<ReturnType<MessagesRepository["getEditHistory"]>>
			/**
			 * Every analysis attempt, oldest first. Present so the detail view can
			 * explain a message that never got a verdict — that message has no row
			 * in `verdicts`, so without this the failure is invisible in the UI.
			 */
			analysis_attempts: Awaited<
				ReturnType<MessagesRepository["getAnalysisAttempts"]>
			>
		}
	> {
		if (!id) {
			throw new ValidationError("message ID is required")
		}

		const [message, editHistory, analysisAttempts] = await Promise.all([
			this.repository.findById(id),
			this.repository.getEditHistory(id),
			this.repository.getAnalysisAttempts(id),
		])

		if (!message) {
			throw new NotFoundError(`Message with ID ${id} not found`)
		}

		return {
			...message,
			edit_count: editHistory.length,
			edit_history: editHistory,
			analysis_attempts: analysisAttempts,
		}
	}

	async getAttachmentsByChannel(
		channelId: string,
		query: MessageQuery,
	): Promise<
		Awaited<ReturnType<MessagesRepository["getAttachmentsByChannel"]>>
	> {
		if (!channelId) {
			throw new ValidationError("channelId is required")
		}

		logger.debug({ channelId, query }, "Getting attachments by channel")
		return this.repository.getAttachmentsByChannel(channelId, query)
	}

	async getImageMessages(
		guildId: string,
		limit?: number,
	): Promise<ReturnType<MessagesRepository["getImageMessages"]>> {
		if (!guildId) {
			throw new ValidationError("guildId is required")
		}

		logger.debug({ guildId, limit }, "Getting image messages")
		return this.repository.getImageMessages(guildId, limit)
	}

	async getReviewMessages(
		channelId?: string,
		limit?: number,
		cursor?: string,
	): Promise<ReviewPageResult> {
		logger.debug({ channelId, limit, cursor }, "Getting review messages")
		return this.repository.getReviewMessages(channelId, limit, cursor)
	}

	async getActivity(
		days = 30,
	): Promise<Awaited<ReturnType<MessagesRepository["getActivity"]>>> {
		return this.repository.getActivity(days)
	}

	async getRecentEdits(
		limit = 50,
		channelId?: string,
		cursor?: string,
	): Promise<EditPageResult> {
		logger.debug({ limit, channelId, cursor }, "Getting recent message edits")
		return this.repository.getRecentEdits(limit, channelId, cursor)
	}

	/** Distinct guilds present in the message archive (guild picker). */
	async getGuilds(): Promise<
		Awaited<ReturnType<MessagesRepository["listGuilds"]>>
	> {
		return this.repository.listGuilds()
	}

	/** Text channels for a guild (channel picker). */
	async getTextChannels(
		guildId: string,
	): Promise<Awaited<ReturnType<MessagesRepository["listTextChannels"]>>> {
		return this.repository.listTextChannels(guildId)
	}
}

/**
 * Lazily constructed, not built at import time.
 *
 * `createMessagesService()` calls `getDatabase()`, which throws until
 * `initializeDatabase()` has run. Deferring construction to first call keeps
 * importing this file free of a database, which is what lets a unit test
 * import the service and pass its own repository.
 *
 * Still one instance per process, which is what the oRPC router and the
 * gateway assume when they import `messagesService`.
 */
let instance: MessagesService | undefined

export const createMessagesService = () =>
	new MessagesService(new MessagesRepository(getDatabase()))

export const messagesService: Pick<
	MessagesService,
	| "listMessages"
	| "streamMessages"
	| "getMessagesByChannel"
	| "getMessageById"
	| "getAttachmentsByChannel"
	| "getImageMessages"
	| "getReviewMessages"
	| "getActivity"
	| "getRecentEdits"
	| "getGuilds"
	| "getTextChannels"
> = {
	listMessages: (...args: Parameters<MessagesService["listMessages"]>) => {
		instance ??= createMessagesService()
		return instance.listMessages(...args) as ReturnType<
			MessagesService["listMessages"]
		>
	},
	streamMessages: (...args: Parameters<MessagesService["streamMessages"]>) => {
		instance ??= createMessagesService()
		return instance.streamMessages(...args) as ReturnType<
			MessagesService["streamMessages"]
		>
	},
	getMessagesByChannel: (
		...args: Parameters<MessagesService["getMessagesByChannel"]>
	) => {
		instance ??= createMessagesService()
		return instance.getMessagesByChannel(...args) as ReturnType<
			MessagesService["getMessagesByChannel"]
		>
	},
	getMessageById: (...args: Parameters<MessagesService["getMessageById"]>) => {
		instance ??= createMessagesService()
		return instance.getMessageById(...args) as ReturnType<
			MessagesService["getMessageById"]
		>
	},
	getAttachmentsByChannel: (
		...args: Parameters<MessagesService["getAttachmentsByChannel"]>
	) => {
		instance ??= createMessagesService()
		return instance.getAttachmentsByChannel(...args) as ReturnType<
			MessagesService["getAttachmentsByChannel"]
		>
	},
	getImageMessages: (
		...args: Parameters<MessagesService["getImageMessages"]>
	) => {
		instance ??= createMessagesService()
		return instance.getImageMessages(...args) as ReturnType<
			MessagesService["getImageMessages"]
		>
	},
	getReviewMessages: (
		...args: Parameters<MessagesService["getReviewMessages"]>
	) => {
		instance ??= createMessagesService()
		return instance.getReviewMessages(...args) as ReturnType<
			MessagesService["getReviewMessages"]
		>
	},
	getActivity: (...args: Parameters<MessagesService["getActivity"]>) => {
		instance ??= createMessagesService()
		return instance.getActivity(...args) as ReturnType<
			MessagesService["getActivity"]
		>
	},
	getRecentEdits: (...args: Parameters<MessagesService["getRecentEdits"]>) => {
		instance ??= createMessagesService()
		return instance.getRecentEdits(...args) as ReturnType<
			MessagesService["getRecentEdits"]
		>
	},
	getGuilds: (...args: Parameters<MessagesService["getGuilds"]>) => {
		instance ??= createMessagesService()
		return instance.getGuilds(...args) as ReturnType<
			MessagesService["getGuilds"]
		>
	},
	getTextChannels: (
		...args: Parameters<MessagesService["getTextChannels"]>
	) => {
		instance ??= createMessagesService()
		return instance.getTextChannels(...args) as ReturnType<
			MessagesService["getTextChannels"]
		>
	},
}
