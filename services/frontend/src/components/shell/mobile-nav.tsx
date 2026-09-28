"use client";

import { cn } from "cn";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { navItems } from "@/lib/navigation";

/**
 * Mobile bottom dock.
 *
 * Two fixes that the previous implementation needed and that are preserved
 * here as requirements, not accidents:
 *
 *  1. It lists ALL seven destinations, not a four-item subset. A partial dock
 *     made three pages unreachable on a phone.
 *  2. The bar is horizontally scrollable with scroll-snap, so all seven fit on
 *     a narrow screen instead of overflowing or being clipped.
 *
 * `bottom-safe-nav-rail` (defined in globals.css) keeps the bar clear of the
 * home indicator on iOS.
 */
export function MobileNav() {
  const pathname = usePathname();
  const normalized = pathname.replace(/\/+$/, "") || "/";

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-hairline bg-canvas/90 backdrop-blur-md lg:hidden"
      aria-label="Primary"
    >
      <ul className="no-scrollbar flex snap-x snap-mandatory gap-1 overflow-x-auto px-2 py-1.5">
        {navItems.map((item) => {
          const active = item.href === normalized;
          return (
            <li key={item.href} className="snap-start">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "nav-dock-item flex min-w-16 flex-col items-center gap-0.5 rounded-md px-3 py-1.5 text-micro-lg transition-colors",
                  active
                    ? "bg-surface text-ink"
                    : "text-ink-muted hover:text-ink-soft",
                )}
              >
                <span
                  className={cn(
                    "h-0.5 w-5 rounded-full transition-colors",
                    active ? "bg-signal" : "bg-transparent",
                  )}
                  aria-hidden
                />
                {item.shortLabel}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="bottom-safe-nav-rail" aria-hidden />
    </nav>
  );
}
