import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        // The app's badges default to a quiet tinted chip rather than shadcn's
        // solid brand fill, so neutral is both a variant and the default here.
        neutral: "border-hairline bg-surface-2 text-ink-soft",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
        // App tones the stock set has no equivalent for. `destructive` already
        // covers vermilion (both resolve to --color-danger), so only the rest
        // are added -- shadcn's docs call for a new variant exactly when the
        // design needs a treatment none of the stock variants provides. Every
        // value below is a declared theme token, not a raw palette color. Vermilion is
        // kept rather than aliased to `destructive` because the app's severity and
        // risk helpers return this vocabulary directly.
        signal:
          "border-signal/30 bg-signal/15 text-signal [a]:hover:bg-signal/25",
        success:
          "border-success/30 bg-success/15 text-success [a]:hover:bg-success/25",
        amber: "border-amber/30 bg-amber/15 text-amber [a]:hover:bg-amber/25",
        vermilion:
          "border-vermilion/30 bg-vermilion/15 text-vermilion [a]:hover:bg-vermilion/25",
      },
      // Type treatment, independent of tone so `variant` stays free for colour.
      // The app's badges are overwhelmingly small monospace labels for metrics,
      // IDs and verdicts -- a treatment shadcn's stock `text-xs font-medium`
      // does not cover.
      type: {
        default: "",
        mono: "font-mono text-2xs",
        monoUpper: "font-mono text-2xs uppercase",
        monoMicro: "font-mono text-micro",
        upper: "uppercase",
      },
    },
    defaultVariants: {
      variant: "neutral",
      type: "default",
    },
  },
);

function Badge({
  className,
  variant = "neutral",
  type = "default",
  dot = false,
  render,
  children,
  ...props
}: useRender.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { dot?: boolean }) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant, type }), className),
        children: dot ? (
          <>
            <span aria-hidden className="size-1.5 rounded-full bg-current" />
            {children}
          </>
        ) : (
          children
        ),
      },
      props,
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  });
}

export { Badge, badgeVariants };
