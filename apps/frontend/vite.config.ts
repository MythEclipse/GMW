import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type PluginOption } from "vite"

/**
 * Vite build config for the GMW dashboard SPA.
 *
 * Replaces `next build`. Two things this must get right:
 *
 *  - `#/*` resolves to `./src/*`, matching tsconfig's `paths`. Next did this
 *    through its own resolver; Vite needs it declared explicitly or every
 *    `#/components/...` import fails at build.
 *    Only the FIRST entry of tsconfig's `paths` is mirrored here. The second
 *    (`../backend/src/*`) is reachable solely through `import type`, which
 *    tsc erases before bundling — giving Vite a second root would let a
 *    frontend file resolve into backend source and ship server code.
 *  - Tailwind runs as a Vite plugin, NOT through postcss.config.mjs. Vite
 *    auto-loads any root `postcss.config.*` it finds, so keeping both would
 *    run Tailwind twice over the same stylesheet.
 */

/**
 * Dev-only backend target for the `server.proxy` rules below. Defaults to the
 * port the deployed backend listens on; override to point the dev server at a
 * side-by-side build.
 */
const devBackend = `ws://127.0.0.1:${process.env.GMW_DEV_BACKEND_PORT ?? "4001"}`

export default defineConfig({
	plugins: [
		// File-based routing over `src/routes`. The seven feature routes live under
		// the `_authenticated` layout pair (`_authenticated.tsx` +
		// `_authenticated/`), which is kana §3.1's file + sibling-folder shape; the
		// former Next.js `src/app/(dashboard)` tree was folded into it.
		//
		// autoCodeSplitting follows §3.1's default of `true`, which supersedes the
		// earlier rationale for leaving it off (gitignored routeTree + a
		// /ws-driven dashboard). The trade is deliberate: per-route chunks cost a
		// request on first navigation to each route in exchange for a smaller
		// entry bundle — the single index chunk was ~729 kB before this.
		//
		// The cast is because @tanstack/router-plugin ships Vite-5-era plugin types
		// and Vite 8's `PluginOption` does not structurally match. Runtime is fine —
		// the plugin is a normal Vite plugin; only the declared type disagrees.
		tanstackRouter({
			targetDirectory: "src/routes",
			// Keep non-route helpers out of the generated tree. The generator
			// applies this to each DIRECTORY ENTRY'S BASENAME (see
			// @tanstack/router-generator getRouteNodes.ts:89 — `d.name.match(...)`)
			// rather than to a path relative to routesDirectory, and it filters
			// before recursing, so `^` anchors correctly at any depth: a folder
			// named `_components` is dropped at its parent and never walked.
			// Without this, `_authenticated/messages/_components/view.tsx` would
			// register as a route at `/view`.
			routeFileIgnorePattern: "^(_apis|_components|_data|_hooks)",
			autoCodeSplitting: true,
		}) as PluginOption,
		react(),
		tailwindcss(),
	],
	resolve: {
		alias: {
			"#": path.resolve(import.meta.dirname, "./src"),
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
		// §3.6 asks for manual vendor chunks. kana names that option
		// `rollupOptions.output.manualChunks`; this Vite is Rolldown-backed
		// (8.3.2), where `rollupOptions` is deprecated in favour of
		// `rolldownOptions` and `manualChunks` is deprecated in favour of
		// `codeSplitting` — setting both means `manualChunks` is ignored. Same
		// intent, current API.
		//
		// Targets are this app's actual heavy vendors, not the skill's sample
		// list (posthog-js / tabler / zod / recharts are not installed here):
		// lucide-react is 41 MB unpacked and @base-ui/react 18 MB, and together
		// they dominate the 557 kB entry chunk.
		rolldownOptions: {
			output: {
				codeSplitting: {
					groups: [
						{ name: "icons", test: /node_modules\/lucide-react/ },
						{ name: "base-ui", test: /node_modules\/@base-ui/ },
						{
							name: "react",
							test: /node_modules\/(react|react-dom|scheduler)\//,
						},
						{ name: "tanstack", test: /node_modules\/@tanstack\// },
					],
				},
			},
		},
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
})
