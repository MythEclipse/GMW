/**
 * The slice of the process config {@link isMonitoredGuild} actually reads.
 *
 * Declared HERE instead of imported as `AppConfig` from
 * `infrastructure/config`: `domain/` must not depend on `infrastructure/`, so
 * the scope rule states the two fields it needs and `AppConfig` satisfies this
 * structurally — every existing call site compiles unchanged.
 */
export interface GuildScopeConfig {
	/** Explicit allow-list. Empty means "not configured" and matches nothing. */
	EFFECTIVE_MONITOR_GUILD_IDS: string[]
	/** Single-guild fallback, used only when the list above is empty. */
	MONITOR_GUILD_ID?: string
}

/**
 * Decides whether a guild is in scope for capture.
 *
 * WHY a shared predicate rather than a local copy per module: five capture
 * modules (thread, channel-topic, presence, member-events, reaction) each
 * carried a byte-identical private `isMonitoredGuild`. A copy that only has to
 * agree with the other four copies it does not import is free to drift, and when
 * guild scope changes, five edits disagree in five different ways.
 *
 * The scope rule itself: the explicit list wins when it has entries; otherwise
 * fall back to the single-guild setting. An empty list means "no scope
 * configured" and matches nothing — a misconfigured gateway stays silent rather
 * than capturing a guild the operator did not ask for.
 */
export function isMonitoredGuild(
	config: GuildScopeConfig,
	guildId: string | null | undefined,
): boolean {
	if (!guildId) return false
	const guildIds = config.EFFECTIVE_MONITOR_GUILD_IDS
	if (guildIds.length === 0) return config.MONITOR_GUILD_ID === guildId
	return guildIds.includes(guildId)
}
