"use client";

import { cn } from "cn";

/**
 * Statistic tile.
 *
 * `linear-tile` is the layout hook declared in globals.css; the surface is a
 * HUD card so a tile matches the panels around it.
 */
export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "positive" | "warning" | "danger";
  className?: string;
}) {
  const valueTone = {
    neutral: "text-ink",
    positive: "text-ink-soft",
    warning: "text-amber",
    danger: "text-vermilion",
  }[tone];

  return (
    <div className={cn("linear-tile hud-card px-4 py-3", className)}>
      <p className="truncate text-xs tracking-wide text-ink-muted uppercase">
        {label}
      </p>
      <p
        className={cn(
          "reactor-count mt-1 font-display text-2xl font-semibold",
          valueTone,
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-ink-faint">{hint}</p>}
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
