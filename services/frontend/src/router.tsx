import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { AnalysisPage } from "@/app/(dashboard)/analysis/page";
import { ChannelsPage } from "@/app/(dashboard)/channels/page";
import { DashboardPage } from "@/app/(dashboard)/dashboard/page";
import { GlossaryPage } from "@/app/(dashboard)/glossary/page";
import { MessagesPage } from "@/app/(dashboard)/messages/page";
import { ModerationPage } from "@/app/(dashboard)/moderation/page";
import { UsersPage } from "@/app/(dashboard)/users/page";
import { NotFoundPage } from "@/app/not-found";
import { Providers } from "@/components/providers";
import { DEFAULT_ROUTE } from "@/lib/navigation";

/**
 * The route table — replaces the App Router's file-system routing, and
 * `src/app/page.tsx`'s server redirect.
 *
 * Two invariants that are easy to break and hard to notice:
 *
 *  1. **Each route needs its OWN element.** React reconciles by component
 *     type, so distinct elements per route are what makes navigating
 *     /messages → /users unmount `MessagesView` and discard its local
 *     `guildId` / `channelId` / `search` / filter / tab state. The App Router
 *     gave that for free. Hoisting a view to a shared module-level const reused
 *     across routes would make those filters persist across navigation — the
 *     single most likely unnoticed regression here.
 *
 *  2. **`Providers` sits on a pathless layout route, above the Outlet.** The
 *     chrome (WsProvider, Topbar, NavRail, MobileNav, Chatbot,
 *     CommandPalette, AmbientBackground) must never remount, or the `/ws`
 *     socket reconnects on every navigation.
 *
 * Routes are NOT lazy-loaded here. This is a private ops dashboard behind a
 * reverse proxy where every page refetches over the WebSocket anyway; splitting
 * would add Suspense boundaries and per-route loading questions for no
 * measurable gain. Revisit if the bundle grows past a few hundred KB gzipped.
 */
const router = createBrowserRouter([
  {
    element: <Providers />,
    children: [
      // Replaces the deleted src/app/page.tsx server redirect. `replace` so
      // Back does not bounce through "/" and re-trigger it.
      { path: "/", element: <Navigate to={DEFAULT_ROUTE} replace /> },

      // One entry per destination in src/lib/navigation.ts.
      { path: "/dashboard", element: <DashboardPage /> },
      { path: "/messages", element: <MessagesPage /> },
      { path: "/moderation", element: <ModerationPage /> },
      { path: "/channels", element: <ChannelsPage /> },
      { path: "/users", element: <UsersPage /> },
      { path: "/analysis", element: <AnalysisPage /> },
      { path: "/glossary", element: <GlossaryPage /> },

      // The static host answers an unknown deep link with index.html, so a bad
      // URL lands here rather than at the server's 404.
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
