"use client"

import { QueryClientProvider } from "@tanstack/react-query"
import { Outlet } from "@tanstack/react-router"
import { Chatbot } from "@/components/chatbot/chatbot"
import {
	CommandPalette,
	openCommandPalette,
} from "@/components/command/command-palette"
import { ErrorBoundary } from "@/components/shared/error-boundary"
import { MobileNav } from "@/components/shell/mobile-nav"
import { NavRail } from "@/components/shell/nav-rail"
import { QueueRibbon } from "@/components/shell/queue-ribbon"
import { Topbar } from "@/components/shell/topbar"
import { getQueryClient } from "@/lib/query-client"
import { WsProvider } from "@/lib/ws/context"

/**
 * Client shell: providers, chrome, and the route content slot.
 *
 * This is the pathless layout route in `@/router`, so the routed page renders
 * through `<Outlet />` instead of a `children` prop. Because it sits ABOVE the
 * route elements, the chrome never remounts on navigation and the `/ws` socket
 * stays open — which is what the App Router's root layout did.
 *
 * `QueryClientProvider` sits here rather than in `main.tsx` for the same
 * reason: it must be ABOVE `<Outlet />` so a route element mounted through the
 * outlet can read the cache. This is also where the "everything the dashboard
 * needs is provided here" boundary already is — one place to look when a hook
 * reports a missing provider.
 *
 * The old doc comment claimed "the SSR payload arrives as already-rendered
 * markup, so the first paint has real data and only the interactive parts
 * hydrate". There is no SSR and no hydration any more; each route now blocks
 * its own render on `useRouteSeed` until its data arrives.
 */
export function Providers() {
	// `getQueryClient()` returns the browser singleton, so calling it on every
	// render of this component is free — it does not construct a second cache.
	const queryClient = getQueryClient()

	return (
		<QueryClientProvider client={queryClient}>
			<WsProvider>
				<Shell />
			</WsProvider>
		</QueryClientProvider>
	)
}

function Shell() {
	return (
		<div className="ambient-bg relative min-h-dvh">
			<AmbientBackground />

			{/* The topbar and the ribbon are one sticky group: the ribbon reports a
          live failure, and a strip that scrolls out of view the moment you
          scroll down would defeat the point. Putting the ribbon as a sibling
          of the sticky header would leave it static. */}
			<div className="sticky top-0 z-30">
				<Topbar onOpenPalette={openCommandPalette} />
				{/* Queue ribbon (W3): a 3px strip carrying the gateway's live analysis
            state, on every route. */}
				<QueueRibbon />
			</div>

			<div className="flex">
				<NavRail />
				{/*
          Reading-width container (W5). The shell had no max-width at all, so on
          a 2560px display the grid stretched edge to edge and every ranked bar
          became an unreadable 2000px hairline. `mx-auto` centres the column
          between the rail and the right edge; `w-full` keeps it fluid below the
          cap, so a laptop is unaffected.

          `route-in` is the shared W7 entrance. It lives on this single <main>
          rather than inside each view, so all seven routes get identical motion
          from one declaration — and because the animation is pure CSS on mount
          it starts on the first painted frame, with no JS tick and no flash of
          un-animated content.
        */}
				<main className="route-in launcher-clearance measure mx-auto min-w-0 flex-1 px-4 pt-4 pb-24 lg:pb-8">
					<ErrorBoundary>
						<Outlet />
					</ErrorBoundary>
				</main>
			</div>

			<MobileNav />
			<Chatbot />
			<CommandPalette />
		</div>
	)
}

/**
 * Ambient background: drifting colour blobs, rising motes, and a vignette.
 *
 * Pure CSS and GPU-composited via `transform` only — the animations already
 * exist in globals.css and are disabled under `prefers-reduced-motion`. This
 * is the decorative layer the old `three.js` constellation was reverted to.
 * `aria-hidden` because it carries no information.
 */
function AmbientBackground() {
	// A fixed set of motes with deterministic positions: randomising them per
	// render would remount and restart the animation on every navigation.
	const motes = [
		{ left: 12, delay: 0, duration: 11 },
		{ left: 27, delay: 2.4, duration: 14 },
		{ left: 44, delay: 5.1, duration: 9 },
		{ left: 61, delay: 1.2, duration: 12 },
		{ left: 78, delay: 3.7, duration: 15 },
		{ left: 91, delay: 6.3, duration: 10 },
	]

	return (
		<div
			className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
			aria-hidden
		>
			<div className="ambient-blob ambient-blob-1" />
			<div className="ambient-blob ambient-blob-2" />
			<div className="ambient-blob ambient-blob-3" />

			<div className="ambient-motes">
				{motes.map((mote) => (
					<span
						key={mote.left}
						className="mote ambient-mote"
						style={
							{
								"--mote-left": `${mote.left}%`,
								"--mote-delay": `${mote.delay}s`,
								"--mote-duration": `${mote.duration}s`,
							} as React.CSSProperties
						}
					/>
				))}
			</div>

			<div className="ambient-wash absolute inset-0" />
			<div className="ambient-vignette absolute inset-0" />
		</div>
	)
}
