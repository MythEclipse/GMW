import { createRootRoute } from "@tanstack/react-router"
import { Providers } from "@/components/providers"

/**
 * Root route. Was `router.tsx`'s pathless `<Providers />` layout route.
 *
 * `Providers` already renders its own `<Outlet />`, so this file is only the
 * root node in the generated tree — no wrapper element, no children prop.
 *
 * Why it must stay at the ROOT rather than becoming a per-route layout:
 * `Providers` owns the TanStack Query client, the `/ws` socket, and the chrome
 * (Topbar, NavRail, MobileNav, Chatbot, CommandPalette). Were it mounted inside
 * a child route, every navigation would remount it and the `/ws` WebSocket
 * would reconnect each time. That was the first of the two invariants the old
 * `router.tsx` doc comment warned about, and it is preserved by construction
 * here rather than by discipline.
 */
export const Route = createRootRoute({
	component: Providers,
})
