import { createFileRoute } from "@tanstack/react-router"
import { NotFoundPage } from "#/components/layout/not-found"

/**
 * `*` — the catch-all. The static host answers an unknown deep link with
 * index.html, so a bad URL renders here rather than at the server's 404.
 *
 * `component` is what actually paints: an unmatched path matches this splat
 * NORMALLY, so the route renders rather than throwing. `notFoundComponent` is a
 * different code path — TanStack only uses it when someone calls `notFound()`,
 * and nothing in this app does. Declaring only that option left unknown URLs
 * rendering an empty <main> with no console output at all. Both are set so
 * either path lands on the same component, matching the root's handler.
 */
export const Route = createFileRoute("/_authenticated/$")({
	component: NotFoundPage,
	notFoundComponent: NotFoundPage,
})
