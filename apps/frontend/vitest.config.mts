import path from "node:path"
import { defineConfig } from "vitest/config"

/**
 * Vitest harness for the frontend (kana §7/§9).
 *
 * Wired up without test files on purpose: §9 wants each project to declare a
 * `test` task, and `moon run :test` at the root already aggregates it. Writing
 * the tests themselves is a separate decision — an empty but *correct* harness
 * means the first test added needs no config change, and `moon run :test`
 * passing means "nothing is broken", not "nothing exists".
 *
 * The `#` alias must be repeated here: Vitest does not read `tsconfig.json`
 * paths, so `#/components/ui/button` would fail to resolve in a test even
 * though `tsc` accepts it. Only the frontend root is mapped — the backend
 * `../backend/src/*` entry exists solely for `import type`, which is erased
 * before any test runs, so mapping it would only let a test accidentally import
 * server code.
 *
 * `environment: "node"` rather than jsdom: the leaf modules this harness is for
 * (formatting, navigation, query-key factories) are DOM-free, and jsdom is not
 * a dependency of this package. A component test that needs a DOM should
 * declare it with a `// @vitest-environment jsdom` pragma instead of pulling
 * jsdom into every run.
 */
export default defineConfig({
	resolve: {
		alias: {
			"#": path.resolve(import.meta.dirname, "./src"),
		},
	},
	test: {
		environment: "node",
		// Vitest exits 1 when a run matches zero files, which would make
		// `moon run :test` red for the whole reason this harness exists: the
		// tests have not been written yet. Without this, "no tests" and "tests
		// failed" are the same signal — with it, green means the harness runs.
		passWithNoTests: true,
		include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
		// Colocated tests must not pick up the generated route tree or build output.
		exclude: ["**/node_modules/**", "**/dist/**", "src/routeTree.gen.ts"],
	},
})
