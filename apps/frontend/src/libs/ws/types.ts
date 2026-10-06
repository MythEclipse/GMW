/**
 * Event types broadcast on the `/ws` socket.
 *
 * The backend's redis bridge maps each gateway Redis channel to one of these
 * names (see `DISCORD_CHANNEL_TO_WS_EVENT` in apps/backend). Two extra
 * socket-originated frames exist alongside the gateway events:
 *
 *  - `message_snapshot` / `message_snapshot_end` — replayed by the backend when
 *    the browser sends a `stream_messages` command.
 *  - `heartbeat` — a 30s keepalive the client ignores.
 *
 * The payload is the gateway event's `data` field, already unwrapped from the
 * `{type, data, timestamp, source}` envelope by the backend.
 */
export type TWsEventType =
	| "message_created"
	| "message_updated"
	| "message_deleted"
	| "message_analyzed"
	| "attachment_created"
	| "attachment_uploaded"
	| "analysis_queue_status"
	| "reaction_added"
	| "reaction_removed"
	| "thread_created"
	| "thread_deleted"
	| "thread_updated"
	| "channel_topic_updated"
	| "presence_updated"
	| "guild_member_added"
	| "guild_member_removed"
	| "moderation_action"
	| "message_snapshot"
	| "message_snapshot_end"
	| "ui_state"
	| "user_state"
	| "heartbeat"

export interface IWsEvent<T = unknown> {
	type: TWsEventType
	data: T
	timestamp: string
}

/** Payload of `analysis_queue_status`, straight from the gateway worker. */
export interface IAnalysisQueueStatus {
	queuedConversations: number
	activeRequests: number
	activeIndividualRequests: number
	individualInFlightCount: number
	individualCircuitBreakerActive: boolean
	lastError: string | null
	activeTextRequests?: number
	activeMediaRequests?: number
}

/** Payload of `message_snapshot_end` — end of a streamed replay. */
export interface IMessageSnapshotEnd {
	sent: number
	nextCursor: string | null
	error?: boolean
}

/**
 * `message_deleted` sends an OBJECT, not a bare id string. Reading it as a
 * string silently yields "undefined" in the UI.
 */
export interface IMessageDeletedPayload {
	id: string
	deleted_at?: number
}

export type TConnectionStatus =
	| "connecting"
	| "connected"
	| "reconnecting"
	| "error"
