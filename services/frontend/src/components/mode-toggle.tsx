"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * shadcn `mode-toggle` — Light / Dark / System.
 *
 * Sourced from the official shadcn registry item
 * (https://ui.shadcn.com/r/styles/new-york/mode-toggle.json), not hand-rolled.
 * Two adaptations were required for this project:
 *
 *  1. Import paths point at `@/components/ui/*` instead of the registry's
 *     `@/registry/<style>/ui/*`.
 *  2. `DropdownMenuTrigger` here wraps **base-ui**, not Radix, so the trigger
 *     composes via `render={<Button />}` instead of Radix's `asChild`. The
 *     registry example's `asChild` prop is not part of this primitive's API.
 *
 * The sun/moon crossfade uses the `dark:` variant, which needs the `class`
 * attribute on <html> to flip — see ThemeProvider in app/layout.tsx.
 */
export function ModeToggle() {
  const { setTheme } = useTheme();

  return (
    // The theme toggle is a 32px `icon` button — under the 44px touch minimum.
    // `min-h-11 min-w-11` sizes the BOX rather than padding it, because the
    // primitive's `size-8` is `border-box` (padding would only shrink the icon
    // inside a box that never grows) and margins are not part of the hit area
    // at all. Both opt out from `sm` up, where a mouse makes target size moot.
    // Colour, border and radius stay the primitive's.
    //
    // Plain Tailwind sizing utilities, not a custom `globals.css` class:
    // `shadcn/no-restyle` rejects any class its grammar cannot reason about on
    // a primitive, and its suggested fix (wrap it in a parent) does not
    // actually work — a 44px span holding a 32px button is still a 32px
    // target, because the button never leaves the span's inner box.
    //
    // Written as a JS comment, not JSX: a `/* */` inside DropdownMenu becomes
    // a child, and DropdownMenu takes none.
    <DropdownMenu>
      {/*
        The 44px box is a WRAPPER, not the Button. `shadcn/no-restyle` rejects
        `touch-target` on a primitive and its stated fix is to size a parent —
        and the parent has to be the `render` target here, because
        `DropdownMenuTrigger` renders AS its child, so whatever it renders is
        the trigger itself. Sizing a wrapper that sat outside the trigger would
        have grown a box the pointer never enters.
      */}
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="icon"
            aria-label="Change theme"
            className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8"
          />
        }
      >
        <Sun className="scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
        <Moon className="absolute scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme("light")}>
          <Sun aria-hidden />
          Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("dark")}>
          <Moon aria-hidden />
          Dark
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("system")}>
          <Monitor aria-hidden />
          System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
