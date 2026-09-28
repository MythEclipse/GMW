import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Per-item delay for the `animate-stagger` reveal, as a CSS length. Call sites
 *  pass it through the `--stagger-delay` custom property (see `.stagger-item`)
 *  rather than an inline `animation-delay`. Steps of 45ms, capped at 600ms so
 *  long lists don't drag the reveal out. */
export function staggerMs(i: number, step = 45, max = 600) {
  return `${Math.min(i * step, max)}ms`;
}
