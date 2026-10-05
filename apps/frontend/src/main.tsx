import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./app/globals.css";

import { createRouter, RouterProvider } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { routeTree } from "./routeTree.gen";

/**
 * SPA entry point — replaces `src/app/layout.tsx`, then `src/router.tsx`.
 *
 * There is no server render and no hydration, so the concerns that file
 * carried are redistributed:
 *
 *  - Metadata / viewport / favicon → `index.html` (static, per-build).
 *  - Fonts → `@fontsource-variable/*`, imported above. They used to come from
 *    `next/font/google`, which downloaded woff2 at BUILD time; the npm package
 *    ships them in-tree, so the sandboxed Nix build fetches nothing.
 *  - ThemeProvider → here, but its no-flash script is duplicated as a blocking
 *    inline script in `index.html`. `ThemeProvider` cannot do this job in a
 *    plain SPA: the module script is deferred, so anything React does at mount
 *    runs after first paint.
 *  - `suppressHydrationWarning` on <html> is gone — nothing hydrates.
 */

/**
 * One router for the SPA, built from the generated tree.
 *
 * Created here rather than exported from a module so the boot-failure handler
 * below can still catch a throw during module evaluation — a router constructed
 * at import time would kill the bundle before React mounts.
 */
const router = createRouter({ routeTree, defaultPreload: false });

const container = document.getElementById("root");

if (!container) {
  throw new Error("[gmw] #root missing from index.html");
}

/**
 * A module that throws during evaluation — a bad `import.meta.env` read, a
 * broken alias — kills the whole bundle before React ever mounts. Without this
 * the page is blank white with an error only in a console nobody opens.
 */
function showBootFailure(container: HTMLElement, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  container.innerHTML = "";
  const box = document.createElement("div");
  box.setAttribute("role", "alert");
  box.style.cssText =
    "margin:3rem auto;max-width:32rem;padding:1.5rem;border:1px solid currentColor;border-radius:.5rem;font:14px/1.6 system-ui,sans-serif";
  const title = document.createElement("p");
  title.textContent = "The dashboard failed to load.";
  title.style.cssText = "margin:0 0 .5rem;font-weight:600";
  const detail = document.createElement("p");
  detail.textContent = message;
  detail.style.cssText = "margin:0;opacity:.7;word-break:break-word";
  box.append(title, detail);
  container.append(box);
  console.error("[gmw] boot failure", error);
}

try {
  createRoot(container).render(
    /*
     * attribute="class" is what makes the `dark:` variants in the shadcn
     * primitives and the .dark token block in globals.css apply.
     *
     * defaultTheme/storageKey are deliberately left at their next-themes
     * defaults — the inline script in index.html reads the same `theme` key,
     * and changing either side discards every saved theme on deploy.
     */
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {/* Generated from src/routes — see vite.config.ts's tanstackRouter(). */}
      <RouterProvider router={router} />
    </ThemeProvider>,
  );
} catch (error) {
  showBootFailure(container, error);
}

// A rejected seed inside an await chain, or an error thrown after mount, is
// otherwise completely silent. Log both with a consistent prefix.
window.addEventListener("unhandledrejection", (event) => {
  console.error("[gmw] unhandled rejection", event.reason);
});
window.addEventListener("error", (event) => {
  console.error("[gmw] uncaught error", event.error ?? event.message);
});
