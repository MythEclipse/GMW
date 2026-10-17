import { describe, expect, test } from "vitest"
import { createAppRouter } from "#/router.tsx"

/**
 * Guards the route-tree shape, not any route's behaviour.
 *
 * A route that has children AND declares a `component` renders that component
 * INSTEAD of its children unless the component renders an `<Outlet/>`. TanStack
 * Router resolves a match to `route.options.component ?? defaultComponent`, and
 * only falls back to a passthrough `<Outlet/>` when there is no component:
 *
 *   const Comp = route.options.component ?? router.options.defaultComponent
 *   return Comp ? jsx(Comp, {}) : jsx(Outlet, {})
 *
 * So a component-bearing parent with no outlet makes every deep URL render the
 * PARENT's page — the section index instead of the item that was opened.
 *
 * That failure is invisible to this repo's gates. It throws nothing, warns
 * nothing, and `matchRoutes` returns the CORRECT chain the whole time, so a
 * matching assertion cannot see it. It presents as a plausible page, which is
 * why it reads as a data problem rather than a routing one. The only reliable
 * check is on the tree shape itself, plus an actual render (see
 * `routes-render.test.tsx`).
 *
 * GMW has exactly two routes with children:
 *   - `__root__`      → `Providers` renders `<Outlet/>`
 *   - `/_authenticated` → `Shell`     renders `<Outlet/>`
 *
 * Both are legitimate. This test does not forbid the shape; it requires that a
 * NEW parent be added deliberately, together with a matching entry below.
 */
describe("route tree shape", () => {
	/** Parents whose component renders an `<Outlet/>`, so children still mount. */
	const PARENTS_WITH_OUTLET = new Set(["__root__", "/_authenticated"])

	test("every route with children renders an outlet, or is a known layout", () => {
		const router = createAppRouter()

		const parents = Object.values(router.routesById).filter((route) => {
			const children = (route.children ?? []) as unknown[]
			return children.length > 0
		})

		// The check is worthless if it silently walks an empty tree — assert the
		// scan actually found the two layouts GMW has.
		expect(parents.length).toBeGreaterThanOrEqual(2)

		for (const route of parents) {
			expect(
				PARENTS_WITH_OUTLET.has(route.id),
				`route "${route.id}" has children but is not a known outlet-rendering ` +
					`layout. Either it declares a component that renders no <Outlet/>, ` +
					`which would render instead of its children, or a new layout was ` +
					`added and must be registered in PARENTS_WITH_OUTLET with an ` +
					`<Outlet/> in its component.`,
			).toBe(true)

			// A pathless layout route must NOT carry a hard-coded path prefix, or
			// its children's public URLs stop matching what the nav links to.
			expect(
				route.options.component,
				`${route.id} lost its component`,
			).toBeTruthy()
		}
	})

	test("the feature routes are children of the layout, not siblings of it", () => {
		const router = createAppRouter()
		const authenticated = router.routesById["/_authenticated"]
		expect(authenticated).toBeDefined()

		const childIds = ((authenticated?.children ?? []) as { id: string }[]).map(
			(c) => c.id,
		)
		for (const expected of [
			"/_authenticated/dashboard",
			"/_authenticated/messages",
			"/_authenticated/moderation",
			"/_authenticated/channels",
			"/_authenticated/users",
			"/_authenticated/analysis",
			"/_authenticated/glossary",
		]) {
			expect(childIds, `${expected} is not under the layout`).toContain(
				expected,
			)
		}
	})
})
