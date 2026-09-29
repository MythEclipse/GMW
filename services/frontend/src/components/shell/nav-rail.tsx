"use client";

import { cn } from "cn";
import { Link, useLocation } from "react-router";
import { navItems } from "@/lib/navigation";

/**
 * Desktop navigation rail.
 *
 * The nav metaphor is intentionally the plain, familiar vertical rail the
 * project guide asks us to keep — a previous attempt replaced it with a
 * constellation metaphor that shipped green and was then rejected for hurting
 * usability. Do not replace this.
 */
export function NavRail() {
  const { pathname } = useLocation();
  const normalized = pathname.replace(/\/+$/, "") || "/";

  return (
    <nav
      className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-52 shrink-0 flex-col gap-1 overflow-y-auto border-r border-hairline px-3 py-4 lg:flex"
      aria-label="Primary"
    >
      {navItems.map((item) => {
        const active = item.href === normalized;
        return (
          <Link
            key={item.href}
            to={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group relative flex flex-col gap-0.5 rounded-md px-3 py-2 transition-colors",
              active
                ? "bg-surface text-ink"
                : "text-ink-muted hover:bg-surface-2 hover:text-ink-soft",
            )}
          >
            {/* Active marker: a left rule, not a fill. Keeps the monochrome
                palette intact and reads at a glance in a long rail. */}
            <span
              className={cn(
                "absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-pill bg-signal transition-opacity",
                active ? "opacity-100" : "opacity-0",
              )}
              aria-hidden
            />
            <span className="text-sm font-medium">{item.label}</span>
            <span className="text-xs text-ink-faint line-clamp-1">
              {item.description}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
