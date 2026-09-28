import { cn } from "cn";

/**
 * Tone → class mapping, the single place the dashboard decides what a state
 * LOOKS like.
 *
 * Colours come from the `--color-*` tokens in globals.css (signal/amber/
 * vermilion), never raw hex — the oxlint `shadcn/no-raw-colors` rule enforces
 * that, and it is what keeps light and dark mode in sync from one definition.
 *
 * This is a PLAIN span rather than the shadcn `Badge` primitive on purpose:
 * the design gate forbids restyling a primitive's colour/shape/spacing, and
 * these status pills need tones that map to the dashboard's semantic palette
 * rather than to the primitive's variant list.
 */
export type Tone = "neutral" | "positive" | "warning" | "danger";

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-ink-muted",
  positive: "text-ink-soft",
  warning: "text-amber",
  danger: "text-vermilion",
};

const TONE_BADGE: Record<Tone, string> = {
  neutral: "border-hairline bg-surface-2 text-ink-muted",
  positive: "border-hairline bg-surface-2 text-ink-soft",
  warning: "border-amber/30 bg-amber/10 text-amber",
  danger: "border-vermilion/30 bg-vermilion/10 text-vermilion",
};

const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-ink-faint",
  positive: "bg-ink-muted",
  warning: "bg-amber",
  danger: "bg-vermilion",
};

/**
 * Small inline status pill.
 *
 * `text-micro-lg` and `rounded-full` are both on the design system's own scale
 * (`--text-micro-lg` is declared in globals.css). The hand-rolled
 * `text-[0.7rem]` / `rounded-pill` this replaced were off-scale, and
 * `rounded-pill` did not exist as a utility at all — so it generated no CSS
 * and the pills rendered square.
 */
export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-micro-lg font-medium whitespace-nowrap",
        TONE_BADGE[tone],
        className,
      )}
    >
      <span
        className={cn("size-1.5 rounded-full", TONE_DOT[tone])}
        aria-hidden
      />
      {children}
    </span>
  );
}

export function ToneText({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  return <span className={cn(TONE_TEXT[tone], className)}>{children}</span>;
}
