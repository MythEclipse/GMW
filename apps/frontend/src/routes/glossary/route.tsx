import { createFileRoute } from "@tanstack/react-router"
import { GlossaryPage } from "@/app/(dashboard)/glossary/page"

/**
 * /glossary
 *
 * The page component is unchanged and still lives in `src/app/(dashboard)`.
 * TanStack's file-based routing needs a route MODULE per path, and this is it;
 * moving the page itself would churn seven files for no behavioural gain. The
 * `(dashboard)` group directory in the old tree is an App Router convention —
 * TanStack does not use one, which is why routes live in `src/routes` directly.
 *
 * A distinct module per route gives a distinct component INSTANCE per route,
 * which is the second invariant the old `router.tsx` doc comment warned about.
 * Hoisting a page into a shared const reused across routes would make React
 * reconcile by component type, and MessagesView's local
 * guildId/channelId/search/tab state would survive navigation instead of
 * resetting.
 */
export const Route = createFileRoute("/glossary")({
	component: GlossaryPage,
})
