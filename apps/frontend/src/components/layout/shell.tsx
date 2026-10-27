import { Outlet } from "@tanstack/react-router"
import { Chatbot } from "#/components/features/chatbot"
import {
	CommandPalette,
	openCommandPalette,
} from "#/components/features/command-palette"
import { ErrorBoundary } from "#/components/layout/error-boundary"
import { MobileNav } from "#/components/layout/mobile-nav"
import { NavRail } from "#/components/layout/nav-rail"
import { QueueRibbon } from "#/components/layout/queue-ribbon"
import { Topbar } from "#/components/layout/topbar"

/**
 * The dashboard chrome: topbar, navigation, chatbot, palette, and the route
 * content slot.
 *
 * WHY THIS MOVED OUT OF `__root`
 *
 * kana §3.1 asks for a layout to be a file + sibling-folder pair, and
 * `routes/_authenticated.tsx` is that file. Mounting the chrome there instead of
 * on the root route makes `__root.tsx` a bare route node and puts the visible
 * shell where a guard would live — so the day a guard is added, it wraps the
 * chrome and the content together instead of sitting above an empty outlet.
 *
 * WHY THIS IS SAFE. A layout route's component persists across navigations of
 * its children, so the chrome still does not remount on navigation — the same
 * guarantee the root route gave it. The provider stack does not move at all:
 * `QueryClientProvider` and `WsProvider` remain on `__root` (see
 * `#/components/layout/providers`), which is what actually keeps `/ws` open.
 *
 * Mounting this on `_authenticated` rather than the root also means `/` never
 * paints it: `routes/index.tsx` redirects in `beforeLoad`, before any component
 * renders.
 */
export function Shell() {
	return (
		<div className="relative min-h-dvh">
			{/* The console's ground. Fixed, behind everything, pure CSS: a 32px cell
          grid that dissolves before it reaches the content, plus two accent
          blooms marking where live data enters the page. `-z-10` keeps it under
          the sticky chrome and the content without either of them needing a
          background of its own. */}
			<div className="field-grid -z-10" aria-hidden />
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
