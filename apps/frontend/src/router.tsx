import { createRouter } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen.ts"

/**
 * Router construction, in its own module as kana §1's layout asks for.
 *
 * WHY A FACTORY, NOT AN INSTANCE
 *
 * The instance has to be built inside `main.tsx`'s boot-failure `try` block: a
 * module that throws during evaluation kills the whole bundle before React ever
 * mounts, and that handler is the only thing that turns a blank white page into
 * a readable message. Exporting a factory gives this file its own module (§1)
 * while leaving construction under the caller's `try` — which is strictly safer
 * than the module-scope `createRouter(...)` call it replaces.
 *
 * WHY THE `Register` AUGMENTATION IS HERE, AND WHY IT MATTERS
 *
 * TanStack types `useSearch({ from })`, `Link to` and `navigate({ to })` against
 * `RegisteredRouter`. When nothing implements `Register`, that degrades to
 * `AnyRouter` and every one of those fields becomes a bare `string` — so a
 * route id can drift and the compiler says nothing.
 *
 * That is not hypothetical. Adding the pathless `_authenticated` layout left
 * `/messages` intact as a URL but rewrote its route ID to
 * `/_authenticated/messages`. `useSearch({ from: "/messages" })` kept compiling
 * and threw `Invariant failed` at runtime instead, blanking the route behind an
 * ErrorBoundary panel. Typed registration turns that class of mistake into a
 * `tsc` failure.
 *
 * It also has to live in a module `main.tsx` imports — the augmentation is
 * global once this file is in the program, so every file in `src/` gets it.
 */
export function createAppRouter() {
	return createRouter({ routeTree, defaultPreload: false })
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof createAppRouter>
	}
}
