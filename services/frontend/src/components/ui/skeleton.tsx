import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

const skeletonVariants = cva("animate-pulse bg-muted", {
  variants: {
    shape: {
      default: "rounded-md",
      // A skeleton mirrors whatever is loading, so its shape is caller-chosen:
      // round for an avatar, the default bar for a line of text.
      circle: "rounded-full",
    },
  },
  defaultVariants: {
    shape: "default",
  },
});

function Skeleton({
  className,
  shape,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof skeletonVariants>) {
  return (
    <div
      data-slot="skeleton"
      className={cn(skeletonVariants({ shape }), className)}
      {...props}
    />
  );
}

export { Skeleton };
