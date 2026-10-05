"use client"

import { Link, useLocation } from "@tanstack/react-router"
import { cn } from "cn"
import { navItems } from "@/lib/navigation"

/**
 * Mobile bottom dock (W4).
 *
 * Two properties the previous implementation needed, preserved here as
 * requirements rather than as accidents:
 *
 *  1. It lists ALL seven destinations, not a four-item subset. A partial dock
 *     made three pages unreachable on a phone.
 *  2. Every destination is reachable WITHOUT a horizontal scroll.
 *
 * (2) is the change. The old dock was a scroll-snap strip: a user had to
 * discover that the bar scrolls to learn that Channels, Analysis and Glossary
 * existed at all, and the active item could sit off-screen after a tap. Seven
 * labels do not fit across a 375px phone at a legible size, so this splits the
 * destinations by weight instead: the four an operator checks constantly are
 * always on screen as real tabs, and the three reference/audit surfaces move
 * into a "More" sheet behind one button. Nothing is removed from navigation and
 * nothing is more than one tap away — the requirement is reachability, not a
 * shorter bar.
 *
 * The split is derived from `navItems` rather than hardcoded twice, so adding a
 * route means editing `navigation.ts` and nothing else: anything not in PRIMARY
 * lands in the sheet automatically.
 */

/** Tabs that always sit on the bar. */
const PRIMARY = new Set(["/dashboard", "/messages", "/moderation", "/users"])

export function MobileNav() {
	const { pathname } = useLocation()
	const normalized = pathname.replace(/\/+$/, "") || "/"

	const primary = navItems.filter((item) => PRIMARY.has(item.href))
	const overflow = navItems.filter((item) => !PRIMARY.has(item.href))
	const overflowActive = overflow.some((item) => item.href === normalized)

	return (
		<nav
			className="fixed inset-x-0 bottom-0 z-40 border-t border-hairline bg-canvas/90 backdrop-blur-md lg:hidden"
			aria-label="Primary"
		>
			<ul className="grid grid-cols-5 gap-0.5 px-2 pt-1.5">
				{primary.map((item) => {
					const active = item.href === normalized
					return (
						<li key={item.href}>
							<Link
								to={item.href}
								aria-current={active ? "page" : undefined}
								className={cn(
									"nav-dock-item flex min-w-0 flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-micro transition-colors",
									active ? "text-ink" : "text-ink-muted hover:text-ink-soft",
								)}
							>
								{/*
                  A top rule rather than a filled pill: at this size a filled
                  background turns the whole bar into a row of buttons and
                  competes with the page. The rule is the same mark the desktop
                  rail uses, so active state is one shape across breakpoints.
                */}
								<span
									className={cn(
										"h-0.5 w-5 rounded-full transition-colors",
										active ? "bg-signal" : "bg-transparent",
									)}
									aria-hidden
								/>
								<span className="w-full truncate text-center">
									{item.shortLabel}
								</span>
							</Link>
						</li>
					)
				})}

				<li>
					{/*
            A <details> disclosure rather than a stateful popover: it opens and
            closes with no JS state, stays keyboard- and screen-reader-accessible
            for free, and cannot be left stranded open behind a route change.
          */}
					<details className="group/more relative">
						<summary
							className={cn(
								"nav-dock-item flex min-w-0 cursor-pointer list-none flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-micro transition-colors [&::-webkit-details-marker]:hidden",
								overflowActive
									? "text-ink"
									: "text-ink-muted hover:text-ink-soft",
							)}
						>
							<span
								className={cn(
									"h-0.5 w-5 rounded-full transition-colors",
									overflowActive ? "bg-signal" : "bg-transparent",
								)}
								aria-hidden
							/>
							More
						</summary>

						<ul className="glass absolute right-0 bottom-full mb-1 w-44 overflow-hidden p-1">
							{overflow.map((item) => {
								const active = item.href === normalized
								return (
									<li key={item.href}>
										<Link
											to={item.href}
											aria-current={active ? "page" : undefined}
											className={cn(
												// `min-h-11` for the same 44px reason as the dock items
												// themselves. These rows are the ONLY route to three of
												// the seven sections on a phone, so they are the least
												// forgiving targets in the app.
												"block min-h-11 truncate rounded-sm px-2 py-2 text-micro-lg transition-colors",
												active
													? "bg-accent text-accent-foreground"
													: "text-ink-soft hover:bg-accent hover:text-accent-foreground",
											)}
										>
											{item.label}
										</Link>
									</li>
								)
							})}
						</ul>
					</details>
				</li>
			</ul>
			{/* Keeps the bar clear of the iOS home indicator. The class is defined in
          globals.css; it was previously referenced under a name that did not
          exist, which made this a no-op. */}
			<div className="bottom-safe-nav-rail" aria-hidden />
		</nav>
	)
}
