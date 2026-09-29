"use client";

import { CornerDownLeft, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { searchNavItems } from "@/lib/navigation";

/**
 * ⌘K / Ctrl+K palette for jumping between the seven sections.
 *
 * The listener lives here and nowhere else, and the shell exposes an imperative
 * `open` through a custom window event rather than lifting palette state into
 * the layout. One keyboard binding, one implementation.
 */
const OPEN_EVENT = "gmw:open-palette";

export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function CommandPalette() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    const onOpen = () => setOpen(true);

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  const results = useMemo(() => searchNavItems(query), [query]);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      setQuery("");
      navigate(href);
    },
    [navigate],
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      title="Go to"
      description="Jump to a dashboard section"
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Search sections…"
      />
      <CommandList>
        <CommandEmpty>
          <span className="flex items-center justify-center gap-2 py-6 text-sm text-ink-muted">
            <Search className="size-4" aria-hidden />
            No sections match
          </span>
        </CommandEmpty>
        <CommandGroup heading="Sections">
          {results.map((item) => (
            <CommandItem
              key={item.href}
              value={`${item.label} ${item.keywords.join(" ")}`}
              onSelect={() => go(item.href)}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm text-ink">{item.label}</span>
                <span className="truncate text-xs text-ink-muted">
                  {item.description}
                </span>
              </span>
              <CornerDownLeft
                className="ml-auto size-3.5 shrink-0 text-ink-faint"
                aria-hidden
              />
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
