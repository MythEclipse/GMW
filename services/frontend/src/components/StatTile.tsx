"use client";

import { cn } from "cn";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router";

/**
 * Statistic tile.
 *
 * `linear-tile` is the layout hook declared in globals.css; the surface is a
 * HUD card so a tile matches the panels around it.
 *
 * -- Why `to` exists (W2) ----------------------------------------------
 * A headline number is a claim about a list. "In queue 419" is only useful if
 * 419 is one click from the 419 rows that make it up, and every tile on the
 * dashboard used to be inert text -- including the one existing drill-down link
 * in the app, which pointed at a filter the target view did not read.
 *
 * So a tile WITH a `to` renders as a `Link` and becomes a control; a tile
 * WITHOUT one stays a `div`. The chevron appears only in the navigable case,
 * because an affordance that shows on a non-interactive element teaches the
 * user that affordances here mean nothing.
 *
 * The `hint` is folded into the accessible name so a screen reader announces
 * the context, not just the number.
 */
export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
  to,
  /** The exact, unabbreviated number. See "Why `exact` exists" below. */
  exact,
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "positive" | "warning" | "danger";
  /** When set, the whole tile becomes a link to this route. */
  to?: string;
  /**
   * The exact value behind an abbreviated `value`, e.g. `"49.724"` for
   * `"49,7 rb"`. Rendered as a native tooltip on the number and announced
   * after it for assistive tech.
   */
  exact?: string;
  className?: string;
}) {
  const valueTone = {
    neutral: "text-ink",
    positive: "text-ink-soft",
    warning: "text-amber",
    danger: "text-vermilion",
  }[tone];

  const body = (
    <>
      <p className="truncate text-xs tracking-wide text-ink-muted uppercase">
        {label}
      </p>
      {/*
        `exact` exists because the headline numbers are abbreviated with
        `Intl.NumberFormat("id-ID")` compact notation, which renders 49,724 as
        "49,7 rb" — "rb" being *ribu*, Indonesian for thousand. That is correct
        localisation and correct at a glance, but it is a real comprehension
        barrier for anyone who does not read the suffix, and it is the one thing
        on this dashboard that stops a number from being verifiable at a glance.

        The exact figure goes in `title` (hover, and the native tooltip on
        keyboard focus) and in `sr-only` text, so it reaches both sighted users
        and screen readers without making the visual value any longer. Only
        emitted when the caller actually has a different string to show, so a
        tile that is not abbreviated does not gain a redundant tooltip.
      */}
      <p
        className={cn("metric mt-1 text-2xl", valueTone)}
        {...(exact ? { title: exact } : {})}
      >
        {value}
        {exact && <span className="sr-only"> ({exact})</span>}
      </p>
      {hint && <p className="mt-0.5 text-xs text-ink-faint">{hint}</p>}
      {/* The chevron marks the tile as a control. It is aria-hidden because the
          link's own accessible name already carries label + value + hint. */}
      {to && (
        <ChevronRight
          className="absolute top-1/2 right-3 size-4 -translate-y-1/2 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden
        />
      )}
    </>
  );

  if (to) {
    return (
      <Link
        to={to}
        className={cn(
          "linear-tile hud-card group block px-4 py-3 transition-colors hover:border-hairline-focus",
          className,
        )}
        aria-label={`${label}: ${value}${exact ? ` (${exact})` : ""}${hint ? `. ${hint}` : ""}`}
      >
        {body}
      </Link>
    );
  }

  return (
    <div className={cn("linear-tile hud-card px-4 py-3", className)}>
      {body}
    </div>
  );
}

export function StatGrid({
  children,
  cols = 4,
}: {
  children: React.ReactNode;
  cols?: 2 | 3 | 4;
}) {
  const grid = {
    2: "grid-cols-2",
    3: "grid-cols-2 lg:grid-cols-3",
    4: "grid-cols-2 lg:grid-cols-4",
  }[cols];

  return <div className={cn("grid gap-3", grid)}>{children}</div>;
}
