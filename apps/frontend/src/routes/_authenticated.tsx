import { createFileRoute } from "@tanstack/react-router"
import { Shell } from "#/components/layout/shell"

/**
 * Pathless layout wrapping every dashboard feature route.
 *
 * The file + sibling-folder pair is what kana §3.1 asks for: this file is the
 * guard slot, `_authenticated/` holds the children rendered inside it.
 *
 * THIS GUARD IS DELIBERATELY EMPTY. GMW is single-tenant and has no auth — it
 * is a private reverse-proxy dashboard gated by the reverse proxy itself, so
 * there is no session to check and no role to require. The pair exists so the
 * structure is correct the day a guard is needed, not to imply one is here.
 *
 * It is pathless: `_authenticated` contributes no URL segment, so /dashboard
 * stays /dashboard. TanStack reserves `_` for exactly this — its own config
 * rejects "_" as routeFileIgnorePrefix: "reserved ... to denote a pathless
 * route".
 *
 * `Shell` renders its own `<Outlet />`, so there is no wrapper element here.
 * Mounting the chrome on a layout route rather than on `__root` is what lets the
 * root stay a bare route node; see `#/components/layout/shell` for why that is
 * safe (a layout route's component persists across child navigations, and the
 * provider stack never moved off the root).
 *
 * The splat (`$.tsx`) lives inside this folder on purpose: NotFoundPage must
 * render inside the chrome, exactly as it did before the split.
 */
export const Route = createFileRoute("/_authenticated")({
	component: Shell,
})
