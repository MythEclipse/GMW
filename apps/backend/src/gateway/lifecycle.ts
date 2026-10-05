import type { Client } from "discord.js-selfbot-v13"
import type { Logger } from "@/shared/logger/index.js"
import { startVerdictNotifier } from "../modules-gateway/ai-moderation/verdictNotifier.js"
import { registerChannelTopicCapture } from "../modules-gateway/channel-topic/index.js"
import type { CommandHandler } from "../modules-gateway/command-handler/commandHandler.js"
import type { EventBroadcaster } from "../modules-gateway/event-broadcaster/index.js"
import { registerGuildMemberEvents } from "../modules-gateway/guild-member-events/index.js"
import {
	registerMessageCapture,
	setEventBroadcaster as setMessageCaptureEventBroadcaster,
	setModerationEventBroadcaster,
} from "../modules-gateway/message-capture/index.js"
import { startDigestScheduler } from "../modules-gateway/monitor/digestScheduler.js"
import { registerReactionCapture } from "../modules-gateway/reaction-tracking/index.js"
import { registerThreadCapture } from "../modules-gateway/thread-tracking/index.js"
import { registerPresenceCapture } from "../modules-gateway/user-presence/index.js"
import { startRetentionCleanup } from "./retention.js"

export interface GatewayLifecycleOptions {
	client: Client
	eventBroadcaster: EventBroadcaster
	commandHandler: CommandHandler
	logger: Logger
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

	startRetentionCleanup()
	// Weekly moderation digest (public, automated)
	startDigestScheduler()
}
