import { createRootRoute } from "@tanstack/react-router"
import { NotFoundPage } from "#/components/layout/not-found"
import { Providers } from "#/components/layout/providers"

/**
 * Root route. Was `router.tsx`'s pathless `<Providers />` layout route.
 *
 * `Providers` owns the TanStack Query client and the `/ws` socket, and renders
 * its own `<Outlet />`, so this file is only the root node in the generated
 * tree — no wrapper element, no children prop.
 *
 * WHY PROVIDERS MUST STAY AT THE ROOT: it sits above `<Outlet />` and above
 * every other route, including the ones outside the `_authenticated` pair, so
 * the `/ws` WebSocket outlives navigation instead of reconnecting on each
 * transition. That was the first of the two invariants the old `router.tsx` doc
 * comment warned about, and it is preserved by construction here.
 *
 * WHAT MOVED: the chrome (Topbar, NavRail, MobileNav, Chatbot, CommandPalette)
 * no longer lives here — it is `#/components/layout/shell`, mounted by
 * `routes/_authenticated.tsx`. A layout route's component persists across
 * navigations of its children, so the chrome keeps the same no-remount
 * guarantee it had on the root; only the provider stack had to stay put.
 *
 * `notFoundComponent` is what `routes/_authenticated/$.tsx`'s comment refers to:
 * a `notFound()` thrown anywhere in the tree lands on this handler, so both
 * paths render the same component.
 */
export const Route = createRootRoute({
	component: Providers,
	notFoundComponent: NotFoundPage,
})
