import type { Client } from "discord.js-selfbot-v13"
import type { RetentionDeps } from "../../application/gateway/retention.js"
import { startRetentionCleanup } from "../../application/gateway/retention.js"
import type { Logger } from "../../infrastructure/logger/index.js"
import { startVerdictNotifier } from "../../infrastructure/modules-gateway/ai-moderation/verdictNotifier.js"
import { registerChannelTopicCapture } from "../../infrastructure/modules-gateway/channel-topic/index.js"
import type { CommandHandler } from "../../infrastructure/modules-gateway/command-handler/commandHandler.js"
import type { EventBroadcaster } from "../../infrastructure/modules-gateway/event-broadcaster/index.js"
import { registerGuildMemberEvents } from "../../infrastructure/modules-gateway/guild-member-events/index.js"
import {
	registerMessageCapture,
	setEventBroadcaster as setMessageCaptureEventBroadcaster,
	setModerationEventBroadcaster,
} from "../../infrastructure/modules-gateway/message-capture/index.js"
import { startDigestScheduler } from "../../infrastructure/modules-gateway/monitor/digestScheduler.js"
import { registerReactionCapture } from "../../infrastructure/modules-gateway/reaction-tracking/index.js"
import { registerThreadCapture } from "../../infrastructure/modules-gateway/thread-tracking/index.js"
import { registerPresenceCapture } from "../../infrastructure/modules-gateway/user-presence/index.js"

export interface GatewayLifecycleOptions {
	client: Client
	eventBroadcaster: EventBroadcaster
	commandHandler: CommandHandler
	logger: Logger
	/** Built by the composition root; drives the retention sweep. */
	retention: RetentionDeps
}

/**
 * Wires everything that must start once Discord is connected.
 *
 * Ordering matters:
 *  1. Inject the event broadcaster into the modules that publish events —
 *     they must be able to publish before their listeners are registered.
 *  2. Register the Discord event listeners (capture modules).
 *  3. Start the background workers/schedulers.
 */
export function startGatewayLifecycle({
	client,
	eventBroadcaster,
	commandHandler,
	logger,
	retention,
}: GatewayLifecycleOptions): void {
	// 1. Inject broadcaster first so no captured event is dropped.
	setMessageCaptureEventBroadcaster(eventBroadcaster)
	setModerationEventBroadcaster(eventBroadcaster)

	// 2. Discord event listeners.
	registerMessageCapture(client)
	registerReactionCapture(client, eventBroadcaster)
	registerThreadCapture(client, eventBroadcaster)
	registerPresenceCapture(client, eventBroadcaster)
	registerChannelTopicCapture(client, eventBroadcaster)
	registerGuildMemberEvents(client, eventBroadcaster)

	// 3. Background schedulers.
	//
	// Moderation is NOT started here — src/index.ts starts it, after this
	// process's HTTP surface is up. Messages land in the queue simply by being
	// captured: `ai_status` defaults to 'pending' and the worker claims from
	// there, so nothing on this path ever waits on a model call. Capture keeps
	// no moderation state in memory, which is why a restart mid-flight strands
	// nothing.
	commandHandler.start(client)
	logger.info("Command handler started")

	// The worker is database-only, so it announces no verdicts. This polls
	// `verdicts` and republishes each new judgement as `message_analyzed`,
	// which is what makes the dashboard's badges update live instead of
	// freezing at the server-rendered values and showing "unjudged" for every
	// message captured after the page loaded.
	startVerdictNotifier(eventBroadcaster)

	startRetentionCleanup(retention)
	// Weekly moderation digest (public, automated)
	startDigestScheduler()
}
