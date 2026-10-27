import { Link, useLocation } from "@tanstack/react-router"
import { cn } from "cn"
import { navItems } from "#/libs/navigation"

/**
 * Desktop navigation rail.
 *
 * The nav metaphor is intentionally the plain, familiar vertical rail the
 * project guide asks us to keep — a previous attempt replaced it with a
 * constellation metaphor that shipped green and was then rejected for hurting
 * usability. Do not replace this.
 *
 * What the rail does carry from the console language: a mono index (`01`, `02`,
 * `03`) instead of an icon, because there are three destinations and an index
 * tells the reader how many there are. The active item is marked by the left
 * signal rule, a surface step and a signal-coloured index — three cues that all
 * survive a monochrome screenshot, unlike a tint alone.
 */
export function NavRail() {
	const { pathname } = useLocation()
	const normalized = pathname.replace(/\/+$/, "") || "/"

	return (
		<nav
			className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-hairline px-3 py-4 lg:flex"
			aria-label="Primary"
		>
			<p className="field-label px-3 pb-2">Console</p>

			{navItems.map((item, index) => {
				const active = item.href === normalized
				return (
					<Link
						key={item.href}
						to={item.href}
						aria-current={active ? "page" : undefined}
						className={cn(
							"group relative flex gap-2.5 rounded-md px-3 py-2 transition-colors",
							active
								? "bg-surface text-ink"
								: "text-ink-muted hover:bg-surface-2 hover:text-ink-soft",
						)}
					>
						{/* Active marker: a left rule, not a fill. Keeps the monochrome
                palette intact and reads at a glance in a long rail. */}
						<span
							className={cn(
								"absolute top-1/2 left-0 h-5 w-0.5 -translate-y-1/2 rounded-full bg-signal transition-opacity",
								active ? "opacity-100" : "opacity-0",
							)}
							aria-hidden
						/>
						{/* The index is the rail's icon. Tabular figures keep the three
                numbers in a column even though `01` and `03` differ in width. */}
						<span
							className={cn(
								"mt-0.5 font-mono text-micro tabular-nums transition-colors",
								active ? "text-signal" : "text-ink-faint",
							)}
							aria-hidden
						>
							{String(index + 1).padStart(2, "0")}
						</span>
						<span className="min-w-0">
							<span className="block text-sm font-medium">{item.label}</span>
							{/*
                Two lines, not one. The rail is a fixed width and the descriptions
                run 43–56 characters, so `line-clamp-1` cut them mid-word — which
                reads as broken rather than as summarised. Clamping at two lines
                fits every description at this width and still bounds the rail's
                height.

                The descriptions are left intact rather than shortened, because
                they double as the search index for the command palette
                (`navigation.ts` matches against `description`), and trimming them
                to fit a pixel width would quietly degrade search.
              */}
							<span className="mt-0.5 line-clamp-2 block text-xs leading-snug text-ink-faint">
								{item.description}
							</span>
						</span>
					</Link>
				)
			})}
		</nav>
	)
}
