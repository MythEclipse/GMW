import { createFileRoute } from "@tanstack/react-router";
import { MessagesPage } from "@/app/(dashboard)/messages/page";

/**
 * /messages
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
 *
 * `validateSearch` types the drill-down contract. Every stat tile on the
 * dashboard links here with `?status=` or `?verdict=`, so those keys are the
 * app's URL API — declaring them here makes a typo a compile error rather than a
 * filter that silently does nothing.
 *
 * Both values are read as `string | undefined`, NOT narrowed to an enum: the
 * allow-list check is `filterFromUrl(value, PIPELINE_STATUSES, ANY)` inside the
 * view, and it must stay there. Narrowing here would reject an unknown value
 * with a router error instead of falling back to `ANY`, which is what lets a
 * hand-edited or stale `?status=` degrade to "unfiltered" rather than erroring.
 */
export const Route = createFileRoute("/messages")({
  validateSearch: (search: Record<string, unknown>) => ({
    status: typeof search.status === "string" ? search.status : undefined,
    verdict: typeof search.verdict === "string" ? search.verdict : undefined,
  }),
  component: MessagesPage,
});
