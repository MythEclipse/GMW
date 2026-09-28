"use client";

import { Command, Hash, Search, ShieldAlert, Sparkles } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ModeToggle } from "@/components/mode-toggle";
import { StatusDot } from "@/components/shell/status-dot";
import { Button } from "@/components/ui/button";
import { activeNavItem } from "@/lib/navigation";

/**
 * Top bar: identity, current section, live status, and the palette trigger.
 *
 * The command palette is opened by a button here AND by ⌘K / Ctrl+K anywhere in
 * the app, so the shortcut is handled once in `CommandPalette` and this only
 * dispatches the event.
 */
export function Topbar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const pathname = usePathname();
  const current = activeNavItem(pathname);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-hairline bg-canvas/80 px-4 backdrop-blur-md">
      <Link href="/dashboard" className="flex items-center gap-2.5">
        <span className="flex size-7 items-center justify-center rounded-md border border-hairline bg-surface">
          <ShieldAlert className="size-4 text-signal" aria-hidden />
        </span>
        <span className="hidden font-display text-sm font-semibold tracking-tight text-ink sm:inline">
          Guild Moderation Watcher
        </span>
      </Link>

      {current && (
        <>
          <span className="text-ink-faint" aria-hidden>
            /
          </span>
          <span className="flex items-center gap-1.5 text-sm text-ink-soft">
            <Hash className="size-3.5 text-ink-faint" aria-hidden />
            {current.label}
          </span>
        </>
      )}

      <div className="ml-auto flex items-center gap-3">
        <StatusDot className="hidden md:flex" />

        {/* Theme control. Always visible, on every breakpoint — it is a global
            preference, not a per-page one. */}
        <ModeToggle />

        {/*
          No colour/spacing overrides here: the design gate gives the Button
          primitive ownership of both, and the `outline` variant already reads
          correctly against the HUD chrome.
        */}
        <Button variant="outline" size="sm" onClick={onOpenPalette}>
          <Search aria-hidden />
          <span className="hidden sm:inline">Search</span>
          <kbd className="hidden items-center gap-0.5 rounded-sm border border-hairline bg-surface-2 px-1 font-mono text-micro lg:inline-flex">
            <Command className="size-2.5" aria-hidden />K
          </kbd>
        </Button>

        <Link href="/moderation" className="md:hidden">
          <Button variant="ghost" size="icon-sm" aria-label="Open moderation">
            <Sparkles aria-hidden />
          </Button>
        </Link>
      </div>
    </header>
  );
}
