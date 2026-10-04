import { cn } from "cn";
import { Badge as BadgePrimitive } from "@/components/ui/badge";

/**
 * Status pill for moderation state.
 *
 * Built ON the shadcn `Badge` primitive rather than as hand-rolled markup: the
 * primitive owns padding, radius, focus ring and font, and this only maps the
 * dashboard's four semantic tones onto its variant vocabulary.
 *
 * shadcn's Badge has no "warning" variant, so warning and danger both map to
 * `destructive` and are told apart by the token-coloured dot and label. The
 * token classes sit on CHILD spans, not on the primitive, because the shadcn
 * design gate forbids restyling a primitive's own colour.
 */
export type Tone = "neutral" | "positive" | "warning" | "danger";

const TONE_VARIANT = {
  neutral: "outline",
  positive: "secondary",
  warning: "destructive",
  danger: "destructive",
} as const satisfies Record<Tone, "outline" | "secondary" | "destructive">;

const TONE_DOT = {
  neutral: "bg-ink-faint",
  positive: "bg-ink-muted",
  warning: "bg-amber",
  danger: "bg-vermilion",
} as const satisfies Record<Tone, string>;

const TONE_TEXT = {
  neutral: "text-ink-muted",
  positive: "text-ink-soft",
  warning: "text-amber",
  danger: "text-vermilion",
} as const satisfies Record<Tone, string>;

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
    <BadgePrimitive variant={TONE_VARIANT[tone]} className={className}>
      <span className="flex items-center gap-1.5">
        <span
          className={cn("size-1.5 rounded-full", TONE_DOT[tone])}
          aria-hidden
        />
        <span className={TONE_TEXT[tone]}>{children}</span>
      </span>
    </BadgePrimitive>
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
