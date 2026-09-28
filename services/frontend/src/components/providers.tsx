"use client";

import type { ReactNode } from "react";
import { Chatbot } from "@/components/chatbot/chatbot";
import {
  CommandPalette,
  openCommandPalette,
} from "@/components/command/command-palette";
import { ErrorBoundary } from "@/components/shared/error-boundary";
import { MobileNav } from "@/components/shell/mobile-nav";
import { NavRail } from "@/components/shell/nav-rail";
import { Topbar } from "@/components/shell/topbar";
import { WsProvider } from "@/lib/ws/context";

/**
 * Client shell: providers, chrome, and the content slot.
 *
 * `page.tsx` stays a server component and renders `children` here — the SSR
 * payload arrives as already-rendered markup, so the first paint has real data
 * and only the interactive parts hydrate.
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <WsProvider>
      <Shell>{children}</Shell>
    </WsProvider>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="ambient-bg relative min-h-dvh">
      <AmbientBackground />

      <Topbar onOpenPalette={openCommandPalette} />

      <div className="flex">
        <NavRail />
        <main className="min-w-0 flex-1 px-4 pt-4 pb-24 lg:pb-8">
          <ErrorBoundary>{children}</ErrorBoundary>
        </main>
      </div>

      <MobileNav />
      <Chatbot />
      <CommandPalette />
    </div>
  );
}

/**
 * Ambient background: drifting colour blobs, rising motes, and a vignette.
 *
 * Pure CSS and GPU-composited via `transform` only — the animations already
 * exist in globals.css and are disabled under `prefers-reduced-motion`. This
 * is the decorative layer the old `three.js` constellation was reverted to.
 * `aria-hidden` because it carries no information.
 */
function AmbientBackground() {
  // A fixed set of motes with deterministic positions: randomising them per
  // render would remount and restart the animation on every navigation.
  const motes = [
    { left: 12, delay: 0, duration: 11 },
    { left: 27, delay: 2.4, duration: 14 },
    { left: 44, delay: 5.1, duration: 9 },
    { left: 61, delay: 1.2, duration: 12 },
    { left: 78, delay: 3.7, duration: 15 },
    { left: 91, delay: 6.3, duration: 10 },
  ];

  return (
    <div
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
      aria-hidden
    >
      <div className="ambient-blob ambient-blob-1" />
      <div className="ambient-blob ambient-blob-2" />
      <div className="ambient-blob ambient-blob-3" />

      <div className="ambient-motes">
        {motes.map((mote) => (
          <span
            key={mote.left}
            className="mote ambient-mote"
            style={
              {
                "--mote-left": `${mote.left}%`,
                "--mote-delay": `${mote.delay}s`,
                "--mote-duration": `${mote.duration}s`,
              } as React.CSSProperties
            }
          />
        ))}
      </div>

      <div className="ambient-wash absolute inset-0" />
      <div className="ambient-vignette absolute inset-0" />
    </div>
  );
}
