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
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="icon" aria-label="Change theme" />
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
