import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { type PluginOption, defineConfig } from "vite";

/**
 * Vite build config for the GMW dashboard SPA.
 *
 * Replaces `next build`. Two things this must get right:
 *
 *  - `@/*` resolves to `./src/*`, matching tsconfig's `paths`. Next did this
 *    through its own resolver; Vite needs it declared explicitly or every
 *    `@/components/...` import fails at build.
 *  - Tailwind runs as a Vite plugin, NOT through postcss.config.mjs. Vite
 *    auto-loads any root `postcss.config.*` it finds, so keeping both would
 *    run Tailwind twice over the same stylesheet.
 */

/**
 * Dev-only backend target for the `server.proxy` rules below. Defaults to the
 * port the deployed backend listens on; override to point the dev server at a
 * side-by-side build.
 */
const devBackend = `ws://127.0.0.1:${process.env.GMW_DEV_BACKEND_PORT ?? "4001"}`;

export default defineConfig({
  plugins: [
    // `src/routes` replaces `src/app`; the old `(dashboard)` group directory
    // is an App Router convention TanStack does not share. Kept off
    // autoCodeSplitting deliberately: `routeTree.gen.ts` is gitignored and
    // regenerated per build, and the dashboard refetches over `/ws` anyway, so
    // per-route chunks would buy nothing here.
    //
    // The cast is because @tanstack/router-plugin ships Vite-5-era plugin types
    // and Vite 8's `PluginOption` does not structurally match. Runtime is fine —
    // the plugin is a normal Vite plugin; only the declared type disagrees.
    tanstackRouter({
      targetDirectory: "src/routes",
      autoCodeSplitting: false,
    }) as PluginOption,
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    // The systemd unit serves dist/ from the current release checkout, so
    // the output must be self-contained and predictable.
    outDir: "dist",
    sourcemap: false,
    // Discord avatars/attachments come from cdn.discordapp.com as plain
    // <img> tags now (no next/image optimizer), so nothing here needs the
    // image pipeline.
    assetsInlineLimit: 4096,
  },
  server: {
    port: 5173,
    proxy: {
      // Dev-only convenience so `bun run dev` talks to a real backend without
      // a rebuild. Production goes through nginx; these are never shipped.
      //
      // The port is overridable because a hardcoded target silently defeats
      // verification: a side-by-side backend on another port is easy to start,
      // but the proxy would keep serving the old one and the browser would show
      // a stale-data crash that looks exactly like a failed fix.
      //
      //   GMW_DEV_BACKEND_PORT=4101 bun run dev
      //
      // ws:true covers both the oRPC WebSocket upgrade and plain HTTP requests
      // on the same target, which is why the scheme is ws:// and not http://.
      "/trpc": { target: devBackend, ws: true },
      "/ws": { target: devBackend, ws: true },
    },
  },
});
