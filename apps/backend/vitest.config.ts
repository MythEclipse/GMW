import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

/**
 * Vitest replaces `bun test` as the runner (skill §7).
 *
 * ## setupFiles is the faithful translation of bunfig.toml's `preload`
 *
 * `tests/setup-env.ts` assigns `process.env.*` BEFORE any test module imports
 * `src/shared/config/index.ts`, whose `loadConfig()` zod schema evaluates at
 * import time. That ordering IS the mechanism — drop it and 17 gateway tests
 * fail on `DISCORD_TOKEN: expected string, received undefined`. Keep the file
 * byte-identical; only its registration point moved.
 *
 * Do NOT "improve" setup-env.ts into a dotenv load. `dotenv.config()` does not
 * override already-set vars, which is exactly why its hardcoded assignments
 * win — and why tests stay hermetic regardless of the host environment.
 */
export default defineConfig({
	/**
	 * `@/*` → `./src/*`, mirroring `tsconfig.json`'s `paths`.
	 *
	 * bun resolved this alias natively, so nothing in the repo declared it for
	 * any other tool. Vitest does not — without this, 16 of the 29 test files
	 * fail at import time with "Cannot find package '@/shared/logger/index'".
	 * This must stay in sync with tsconfig.json; `vite-tsconfig-paths` is the
	 * drop-in alternative if the alias ever grows more entries.
	 */
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},

	test: {
		setupFiles: ["./tests/setup-env.ts"],
		include: ["tests/**/*.test.ts", "tests-gateway/**/*.test.ts"],

		/**
		 * `forks`, not `threads`.
		 *
		 * The config singleton, `discord.js-selfbot-v13`, and `sharp`'s native
		 * bindings are a poor fit for worker threads — native modules loaded in a
		 * thread pool leak handles across test files. `forks` matches bun's
		 * process-per-file isolation, which is what the suite was green under.
		 */
		pool: "forks",

		/**
		 * ONE worker, because 11 of the 29 files are real-Postgres integration
		 * tests and 10 of those TRUNCATE shared tables in `beforeAll`
		 * (worker, nsfw-channel-skip, memoryBank, kbbiWiring, conversationHistory,
		 * autoDeleteMarker, channelContextWiring, linkEmbedWiring, verdictNotifier,
		 * skipped-channel).
		 *
		 * bun ran files sequentially, so they were safe by accident of the
		 * runner. Vitest parallelises by default, and the files then wipe each
		 * other's rows mid-run — `worker.test.ts` passes 31/31 alone and fails
		 * in the full suite for exactly this reason. Serialising restores the
		 * semantics the suite was written against instead of rewriting 10 files
		 * to use per-file schemas.
		 *
		 * The pure-logic files are unaffected either way; they just queue behind
		 * the DB ones. Suite runtime is ~12s, which is the price of correctness.
		 */
		fileParallelism: false,

		/**
		 * The integration suite (P1b characterization tests) needs a REAL pool,
		 * so it runs under a separate config that bypasses setup-env.ts — that
		 * file hardcodes `postgres://localhost:6432/test` precisely so a unit
		 * test that accidentally opens a pool fails loudly. See
		 * vitest.integration.config.ts.
		 */
	},
})
