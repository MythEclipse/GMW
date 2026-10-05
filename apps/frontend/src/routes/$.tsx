import { createFileRoute } from "@tanstack/react-router"
import { NotFoundPage } from "@/app/not-found"

/**
 * `*` — the catch-all. The static host answers an unknown deep link with
 * index.html, so a bad URL renders here rather than at the server's 404.
 *
 * `$` is TanStack's splat; `notFoundComponent` is what the ROOT's notFound
 * handler also renders, so both paths land on the same component.
 */
export const Route = createFileRoute("/$")({
	notFoundComponent: NotFoundPage,
})
