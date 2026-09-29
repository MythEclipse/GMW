"use client";

import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { DEFAULT_ROUTE } from "@/lib/navigation";

/**
 * Catch-all for unmatched paths (`path: "*"` in `@/router`).
 *
 * The static host answers an unknown deep link with `index.html` rather than a
 * 404, so without this route a mistyped URL would boot the whole SPA and land
 * the user on an empty shell with no explanation.
 */
export function NotFoundPage() {
  return (
    <div className="flex flex-col items-center gap-3 py-20 text-center">
      <p className="font-display text-xl font-semibold tracking-tight text-ink">
        Page not found
      </p>
      <p className="max-w-md text-xs text-ink-muted">
        That route does not exist in this dashboard. Use the rail, the bottom
        dock, or ⌘K to jump to a section.
      </p>
      {/*
        base-ui's composition prop is `render`, not Radix's `asChild` — the
        same convention ModeToggle uses for DropdownMenuTrigger. The design gate
        keeps styling on the primitive, so the Link is rendered through it
        rather than wrapping it.
      */}
      <Button variant="outline" size="sm" render={<Link to={DEFAULT_ROUTE} />}>
        Back to overview
      </Button>
    </div>
  );
}
