import type {
	Client,
	MessageReaction,
	PartialMessageReaction,
	PartialUser,
	User,
} from "discord.js-selfbot-v13"
import { isMonitoredGuild } from "../../../domain/config/guildScope.js"
import { config } from "../../config/index.js"
import { getDatabase } from "../../database/drizzle.js"
import { reactionsTable } from "../../database/schema.js"
import { createChildLogger } from "../../logger/index.js"
import type { EventBroadcaster } from "../event-broadcaster/eventBroadcaster.js"

const logger = createChildLogger("reaction-tracking")

// ─── Helpers ─────────────────────────────────────────────────────────────

function getEmojiIdentifier(
	reaction: MessageReaction | PartialMessageReaction,
): {
	emoji: string
	emojiId: string | null
	animated: boolean
} {
	const emoji = reaction.emoji
	if (emoji.id) {
		return {
			emoji: emoji.name ?? emoji.id,
			emojiId: emoji.id,
			animated: Boolean((emoji as any).animated),
		}
	}
	return {
		emoji: emoji.name ?? "unknown",
		emojiId: null,
		animated: false,
	}
}

// ─── Event Handlers ──────────────────────────────────────────────────────

/**
 * Stable row id for one (message, emoji, user) reaction event.
 *
 * The type is part of the key on purpose. `message_reactions.id` is the primary
 * key and every insert uses `onConflictDoNothing()`, so if an add and a remove
 * derived the SAME id the remove would collide with the existing add row and be
 * dropped without a word — no `remove` row would ever exist, and every
 * net-reaction calculation (adds minus removes) would silently over-count.
 * Keying by type keeps the intended de-duplication (a repeated add is still one
 * row) while letting the removal of a reaction be recorded at all.
 */
export function reactionRowId(
	reaction: MessageReaction | PartialMessageReaction,
	emojiKey: string,
	userId: string,
	reactionType: "add" | "remove",
): string {
	return `${reaction.message.id}-${emojiKey}-${userId}-${reactionType}`
}

/**
 * `user.username` is typed `string | null` on a partial user, and
 * `message_reactions.username` is NOT NULL. Fall back rather than pass null
 * through: the row is a reaction audit trail, and a placeholder username is
 * worth more than a discarded event.
 */
function reactionUsername(user: User | PartialUser): string {
	return user.username ?? "unknown"
}

async function handleReactionAdd(
	reaction: MessageReaction | PartialMessageReaction,
	user: User | PartialUser,
): Promise<void> {
	const guildId = reaction.message.guildId
	// Narrowed before the scope check so `guild_id` below is a `string`: a DM
	// reaction has no guild, and the insert column is NOT NULL.
	if (!guildId) return
	if (!isMonitoredGuild(config, guildId)) return
	if (user.bot) return

	const { emoji, emojiId, animated } = getEmojiIdentifier(reaction)
	const now = Date.now()
	const id = reactionRowId(reaction, emojiId ?? emoji, user.id, "add")

	try {
		const db = getDatabase()
		await db
			.insert(reactionsTable)
			.values({
				id,
				message_id: reaction.message.id,
				channel_id: reaction.message.channelId,
				guild_id: guildId,
				user_id: user.id,
				username: reactionUsername(user),
				emoji,
				emoji_id: emojiId,
				animated,
				reaction_type: "add",
				created_at: now,
			})
			.onConflictDoNothing()

		logger.debug(
			{ messageId: reaction.message.id, emoji, userId: user.id },
			"Reaction recorded",
		)
	} catch (error) {
		logger.error(
			{ messageId: reaction.message.id, error: String(error) },
			"Failed to record reaction",
		)
	}
}

async function handleReactionRemove(
	reaction: MessageReaction | PartialMessageReaction,
	user: User | PartialUser,
): Promise<void> {
	const guildId = reaction.message.guildId
	if (!guildId) return
	if (!isMonitoredGuild(config, guildId)) return
	if (user.bot) return

	const { emoji, emojiId, animated } = getEmojiIdentifier(reaction)
	const now = Date.now()
	const id = reactionRowId(reaction, emojiId ?? emoji, user.id, "remove")

	try {
		const db = getDatabase()
		await db
			.insert(reactionsTable)
			.values({
				id,
				message_id: reaction.message.id,
				channel_id: reaction.message.channelId,
				guild_id: guildId,
				user_id: user.id,
				username: reactionUsername(user),
				emoji,
				emoji_id: emojiId,
				animated,
				reaction_type: "remove",
				created_at: now,
			})
			.onConflictDoNothing()

		logger.debug(
			{ messageId: reaction.message.id, emoji, userId: user.id },
			"Reaction removal recorded",
		)
	} catch (error) {
		logger.error(
			{ messageId: reaction.message.id, error: String(error) },
			"Failed to record reaction removal",
		)
	}
}

// ─── Registration ────────────────────────────────────────────────────────

export function registerReactionCapture(
	client: Client,
	eventBroadcaster: EventBroadcaster,
): void {
	logger.info("Registering reaction capture")

	client.on(
		"messageReactionAdd",
		async (
			reaction: MessageReaction | PartialMessageReaction,
			user: User | PartialUser,
		) => {
			await handleReactionAdd(reaction, user)

			const guildId = reaction.message.guildId
			if (!isMonitoredGuild(config, guildId)) return

			const { emoji, emojiId, animated } = getEmojiIdentifier(reaction)

			eventBroadcaster
				.reactionAdded({
					message_id: reaction.message.id,
					channel_id: reaction.message.channelId,
					guild_id: guildId,
					user_id: user.id,
					username: user.username,
					emoji,
					emoji_id: emojiId,
					animated,
					created_at: Date.now(),
				})
				.catch(() => {})
		},
	)

	client.on(
		"messageReactionRemove",
		async (
			reaction: MessageReaction | PartialMessageReaction,
			user: User | PartialUser,
		) => {
			await handleReactionRemove(reaction, user)

			const guildId = reaction.message.guildId
			if (!isMonitoredGuild(config, guildId)) return

			const { emoji, emojiId, animated } = getEmojiIdentifier(reaction)

			eventBroadcaster
				.reactionRemoved({
					message_id: reaction.message.id,
					channel_id: reaction.message.channelId,
					guild_id: guildId,
					user_id: user.id,
					username: user.username,
					emoji,
					emoji_id: emojiId,
					animated,
					created_at: Date.now(),
				})
				.catch(() => {})
		},
	)
}
