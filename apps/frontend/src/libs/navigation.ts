/**
 * Navigation.
 *
 * Exactly three destinations, one per router the frontend still exposes:
 * dashboard, messages and moderation.
 *
 * The four reference/audit pages that used to sit here — channels, users,
 * analysis and glossary — were removed along with their backend routers, so
 * the routes are gone rather than left as dead ends. `href` is the ONLY source
 * of truth — the desktop rail, the mobile dock and the command palette all
 * read this array, so adding a destination once makes it appear everywhere.
 */
export interface INavItem {
	href: string
	label: string
	/** Short label for the mobile dock, where horizontal space is tight. */
	shortLabel: string
	description: string
	keywords: string[]
	/** Higher sorts earlier. */
	order: number
}

export const navItems: readonly INavItem[] = [
	{
		href: "/dashboard",
		label: "Overview",
		shortLabel: "Home",
		description: "Moderation health, leaderboards, and activity",
		keywords: ["home", "overview", "stats", "summary", "dashboard"],
		order: 1,
	},
	{
		href: "/messages",
		label: "Messages",
		shortLabel: "Msgs",
		description: "Live message stream with verdict and queue state",
		keywords: ["message", "chat", "stream", "feed", "live"],
		order: 2,
	},
	{
		href: "/moderation",
		label: "Moderation",
		shortLabel: "Mod",
		description: "Verdicts, enforcement actions, and coverage",
		keywords: ["moderation", "verdict", "flag", "action", "enforce", "delete"],
		order: 3,
	},
] as const

/** The landing route. */
export const DEFAULT_ROUTE = "/dashboard"

/**
 * Resolve a path to its nav item. Trailing slashes are tolerated because the
 * app is built with `trailingSlash: true`, so a visited URL is `/moderation/`
 * while the item href is `/moderation`.
 */
export function activeNavItem(pathname: string): INavItem | null {
	const normalized = pathname.replace(/\/+$/, "") || "/"
	return navItems.find((item) => item.href === normalized) ?? null
}

/** Substring match for the command palette; empty query returns everything. */
export function searchNavItems(query: string): INavItem[] {
	const q = query.trim().toLowerCase()
	if (!q) return [...navItems]

	return navItems.filter((item) => {
		const haystack = [
			item.label,
			item.shortLabel,
			item.description,
			item.href,
			...item.keywords,
		]
			.join(" ")
			.toLowerCase()
		return haystack.includes(q)
	})
}
