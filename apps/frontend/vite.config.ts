import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
      "/trpc": { target: "ws://127.0.0.1:4001", ws: true },
      "/ws": { target: "ws://127.0.0.1:4001", ws: true },
    },
  },
});
