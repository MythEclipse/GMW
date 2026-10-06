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
		 * PARALLELISM IS BACK, because the coupling that forced it off is gone.
		 *
		 * This used to read `fileParallelism: false`. Eleven files are real-Postgres
		 * tests and ten of those TRUNCATE shared tables, so under Vitest's default
		 * parallelism they wiped each other's rows mid-run — `worker.test.ts` passed
		 * 31/31 alone and failed in the suite for exactly that reason. Serialising
		 * restored the semantics the suite was written against instead of removing
		 * the coupling, and cost ~12s on every run.
		 *
		 * Every one of those files now takes a per-file Postgres schema via
		 * `tests-gateway/isolated-pool.ts`: a fresh `t_<label>_<random>` schema with
		 * structural copies of the ten tables they touch, and `search_path` pinned
		 * on the pool so the unqualified table names in the existing SQL resolve
		 * into it. The SQL in those files is unchanged.
		 *
		 * Measured, not assumed. With `--fileParallelism --maxWorkers=4`:
		 *   before — Test Files 5 failed | 27 passed, Tests 34 failed | 376 passed
		 *   after  — Test Files 32 passed,              Tests 410 passed
		 *
		 * If a new DB-backed test file is added, it MUST call
		 * `tryCreateIsolatedPool` rather than `new pg.Pool` against the shared
		 * schema, or it will reintroduce the failure this flag was covering for.
		 *
		 * `pool: "forks"` above is still load-bearing and unrelated: that one is
		 * about native modules leaking across worker threads, not the database.
		 */
		fileParallelism: true,

		/**
		 * The characterization harnesses under tests/integration/ need a REAL pool
		 * and so are NOT vitest suites — they are standalone tsx scripts run by the
		 * `backend:test-integration` moon task, which is why they do not appear in
		 * the counts above.
		 *
		 * There is no `vitest.integration.config.ts`; an earlier version of this
		 * comment referred to one. The isolation between this suite and those
		 * scripts is `setupFiles`: it hardcodes `postgres://localhost:6432/test`, a
		 * dead port, so a unit test that accidentally opens a pool fails loudly
		 * instead of touching a real database.
		 */
	},
})
