"use client";

import { cn } from "cn";
import { useMemo } from "react";
import { EmptyState } from "@/components/shared/states";
import { formatCompact } from "@/lib/format";

export interface SeriesPoint {
  label: string;
  value: number;
  flagged?: number;
}

/**
 * Time-series area chart, hand-rolled on SVG.
 *
 * Why not recharts: the package is installed, but this dashboard needs exactly
 * one chart shape, and the design system already provides the pieces
 * (`.chart-frame` for the measured box, `--color-signal` for the stroke). A
 * hand-built path keeps the palette on tokens, keeps the bundle small, and
 * avoids fighting a charting library's default colour palette (which the oxlint
 * raw-colour rule would reject anyway).
 *
 * Values are plotted against a real numeric x-axis using the index, so a gap in
 * days cannot silently compress the timeline.
 */
export function AreaChart({
  data,
  height = 120,
  className,
}: {
  data: SeriesPoint[];
  height?: number;
  className?: string;
}) {
  const geometry = useMemo(() => {
    if (data.length === 0) return null;

    const width = 100; // viewBox units; the frame scales to the container
    const max = Math.max(1, ...data.map((d) => d.value));
    const step = data.length > 1 ? width / (data.length - 1) : 0;

    const points = data.map((d, i) => ({
      x: i * step,
      // Inset by 4% top and bottom so the extremes are not clipped.
      y: 96 - (d.value / max) * 88,
      datum: d,
    }));

    const line = points
      .map(
        (p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`,
      )
      .join(" ");

    const area = `${line} L${width},100 L0,100 Z`;

    return { points, line, area, max };
  }, [data]);

  if (!geometry || data.length === 0) {
    return <EmptyState title="No activity in this window" />;
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div
        className="chart-frame w-full"
        style={{ "--chart-height": `${height}px` } as React.CSSProperties}
      >
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="h-full w-full"
          role="img"
          aria-label={`Messages per day, peak ${formatCompact(geometry.max)}`}
        >
          <defs>
            <linearGradient id="area-fill" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor="var(--color-signal)"
                stopOpacity="0.28"
              />
              <stop
                offset="100%"
                stopColor="var(--color-signal)"
                stopOpacity="0"
              />
            </linearGradient>
          </defs>

          {/*
            Two horizontal references at 50% and 100% of the peak.

            The chart has no y-axis labels, and adding them is not an option:
            `preserveAspectRatio="none"` stretches the viewBox, so text drawn
            inside it would be distorted by the container's aspect ratio. The
            peak stated below the chart therefore has to do the labelling, and
            these lines are what make it actionable — they let a reader place a
            valley or a shoulder against the peak instead of eyeballing it off
            an empty field.

            `vectorEffect="non-scaling-stroke"` keeps them 1px despite the
            non-uniform scale, and they sit under the data so they never
            obscure it. 50% is y=52, 100% is y=8 — the same 8-unit top inset the
            plot itself uses, so "100%" and "peak" mean the same line.
          */}
          <g
            stroke="var(--chart-grid)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          >
            <line x1="0" y1="8" x2="100" y2="8" />
            <line x1="0" y1="52" x2="100" y2="52" />
          </g>

          <path d={geometry.area} fill="url(#area-fill)" />
          <path
            d={geometry.line}
            fill="none"
            stroke="var(--color-signal)"
            strokeWidth="0.8"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      </div>

      {/*
        The peak is stated as text rather than left for the reader to estimate
        off the curve. This chart is the ONLY place the daily series appears —
        there is no table beneath it — so the panel used to render a headline
        number above an unlabelled area with no scale at all. The peak is the
        one magnitude a reader actually wants, and an unlabelled area chart
        cannot give it.
      */}
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-ink-muted">
          Peak{" "}
          <span className="font-mono text-ink-soft">
            {formatCompact(geometry.max)}
          </span>
        </span>
        <span className="font-mono text-micro text-ink-faint">
          {formatCompact(data.reduce((total, point) => total + point.value, 0))}{" "}
          total
        </span>
      </div>

      {/* Axis labels only at the ends and middle: on a narrow tile more than
          three labels collide, and the peak above now carries the magnitude. */}
      <div className="flex justify-between font-mono text-micro text-ink-faint">
        <span>{data[0]?.label}</span>
        <span>{data[Math.floor(data.length / 2)]?.label}</span>
        <span>{data[data.length - 1]?.label}</span>
      </div>
    </div>
  );
}
