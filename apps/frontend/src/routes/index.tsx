import { createFileRoute, redirect } from "@tanstack/react-router";
import { DEFAULT_ROUTE } from "@/lib/navigation";

/**
 * `/` — redirects to the first nav destination.
 *
 * Replaces react-router's `<Navigate to={DEFAULT_ROUTE} replace />`.
 * `replace: true` is TanStack's equivalent of `replace`, so Back does not
 * bounce through "/" and re-trigger the redirect.
 */
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: DEFAULT_ROUTE, replace: true });
  },
});
