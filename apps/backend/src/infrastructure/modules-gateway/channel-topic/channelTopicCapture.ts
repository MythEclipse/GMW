import type { Client, TextChannel } from "discord.js-selfbot-v13"
import { isMonitoredGuild } from "../../../domain/config/guildScope.js"
import { config } from "../../config/index.js"
import { createChildLogger } from "../../logger/index.js"
import type { EventBroadcaster } from "../event-broadcaster/eventBroadcaster.js"

const logger = createChildLogger("channel-topic")

export function registerChannelTopicCapture(
	client: Client,
	eventBroadcaster: EventBroadcaster,
): void {
	logger.info("Registering channel topic capture")

	client.on("channelUpdate", async (oldChannel, newChannel) => {
		// Only care about text channels
		if (newChannel.type !== "GUILD_TEXT") return
		if (!isMonitoredGuild(config, newChannel.guildId)) return

		const oldText = oldChannel as TextChannel
		const newText = newChannel as TextChannel

		const oldTopic = oldText.topic ?? ""
		const newTopic = newText.topic ?? ""

		if (oldTopic === newTopic) return

		const data = {
			channel_id: newText.id,
			guild_id: newText.guildId,
			channel_name: newText.name,
			old_topic: oldTopic || null,
			new_topic: newTopic || null,
			updated_at: Date.now(),
		}

		logger.info(
			{ channelId: newText.id, channelName: newText.name },
			"Channel topic updated",
		)
		await eventBroadcaster.channelTopicUpdated(data).catch(() => {})
	})
}
