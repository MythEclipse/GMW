"use client";

import { Link, useLocation } from "@tanstack/react-router";
import { Command, Hash, Search, ShieldAlert, Sparkles } from "lucide-react";
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
  const { pathname } = useLocation();
  const current = activeNavItem(pathname);

  return (
    // The header is NOT itself sticky: the shell wraps it and the queue ribbon
    // in a single `sticky top-0` group, so two nested sticky elements would
    // fight over the same offset. Height and chrome are unchanged.
    <header className="flex h-14 items-center gap-3 border-b border-hairline bg-canvas/80 px-4 backdrop-blur-md">
      {/*
        The brand mark is a 28px square, and the shield inside it is decorative.
        the `min-h-11 min-w-11` makes the whole home link a real target on touch widths —
        a 28px tappable logo is the classic mis-tap, especially one-handed.
        `sr-only` is added because with the padding the link no longer contains
        any visible text on a phone (the wordmark is `sm:inline`), so without it
        the link has no accessible name at all.
      */}
      <Link
        to="/dashboard"
        className="-m-2.5 flex min-h-11 min-w-11 items-center gap-2.5 p-2.5 sm:-m-0 sm:min-h-0 sm:min-w-0 sm:p-0"
        aria-label="Guild Moderation Watcher, home"
      >
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

      <div className="ml-auto flex items-center gap-1 sm:gap-3">
        <StatusDot className="hidden md:flex" />

        {/* Theme control. Always visible, on every breakpoint — it is a global
            preference, not a per-page one. */}
        <ModeToggle />

        {/*
          No colour/radius overrides on the Button itself: the design gate gives
          the primitive ownership of that, and `outline` already reads correctly
          against the chrome.

          The one thing overridden is the hit area, and only on touch widths.
          The `sm` button variant is `h-7` (28px), under the 44px touch
          minimum. This cannot be fixed with padding: `h-7` is `border-box`, so
          extra padding shrinks the icon inside a box that never grows, and
          margins are not part of the hit area at all. The box has to be sized —
          `min-h-11` (44px) below `sm`, back to the primitive's own `h-7` from
          `sm` up, where a mouse makes target size moot.

          These are plain Tailwind sizing utilities, not a custom
          `globals.css` class, and that is deliberate: `shadcn/no-restyle`
          rejects any class its grammar cannot reason about on a primitive, and
          a custom class is exactly that. Its stated fix — "put it on a parent
          element" — is wrong for this case, because a 44px wrapper holding a
          32px button is still a 32px target; the button never leaves the
          wrapper's inner box.

          On a phone the label and the kbd hint are both hidden, which would
          otherwise leave a bare magnifier whose only affordance was a ⌘K that a
          touch device does not have. So the trigger carries its own accessible
          name, and the `⌘K` chip is desktop-only — shown only where the
          shortcut genuinely exists.
        */}
        <Button
          variant="outline"
          size="sm"
          onClick={onOpenPalette}
          aria-label="Search sections"
          title="Search sections (⌘K)"
          className="min-h-11 min-w-11 sm:min-h-7 sm:min-w-0"
        >
          <Search aria-hidden />
          <span className="hidden sm:inline">Search</span>
          <kbd className="hidden items-center gap-0.5 rounded-sm border border-hairline bg-surface-2 px-1 font-mono text-micro lg:inline-flex">
            <Command className="size-2.5" aria-hidden />K
          </kbd>
        </Button>

        {/*
          Phone-only shortcut to Moderation.

          This used to wrap a `<Button>` in a `<Link>`, which made a control
          inside a control: the anchor carried the `aria-label` while the button
          inside it was a separate 28×28 tab stop that screen readers announced
          as an unlabelled button. The button is now gone and the icon is painted
          on the link itself — one target, one name, one tab stop.

          `min-h-11 min-w-11` plus the negative margin keeps the 44px box without
          moving the icon; `sm:` drops back to the primitive spacing once a mouse
          is in play.
        */}
        <Link
          to="/moderation"
          className="-m-2.5 flex min-h-11 min-w-11 items-center justify-center p-2.5 text-ink-soft transition-colors hover:text-ink sm:-m-0 sm:min-h-0 sm:min-w-0 sm:p-0 md:hidden"
          aria-label="Open moderation"
        >
          <Sparkles className="size-4" aria-hidden />
        </Link>
      </div>
    </header>
  );
}
