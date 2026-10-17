import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { createAppRouter } from "#/router.tsx"

/**
 * Renders real routes and asserts each one paints ITS OWN page.
 *
 * Why a render test and not a matching test: `matchRoutes` returns the correct
 * chain even when a parent swallows its children, so matching cannot see this
 * bug at all. It can only be observed as output.
 *
 * WHAT TO ASSERT — the trap this file was rewritten around. The obvious
 * assertion (`expect(html).toContain("Moderation")`) is VACUOUS here: the shell
 * chrome is rendered on every route and the nav rail already contains the words
 * "Moderation", "Messages", "Channels" and so on. It passes even when the child
 * page never renders, so it cannot detect the bug it was written for. Verified
 * by rendering and inspecting: `/moderation` matched "Moderation" while its
 * `<main>` contained only `Loading moderation…`.
 *
 * The reliable signal is the text INSIDE `<main>` — the outlet's content — which
 * is per-route. Without a populated query cache each route renders its own
 * `<LoadingState label=…/>`, and those labels are unique per route. So this
 * asserts against `<main>` content only, never against the whole document.
 *
 * Two further traps avoided:
 *
 *  1. `await router.load()` BEFORE rendering. Without it `RouterProvider` has
 *     no matches and `renderToStaticMarkup` returns `""` — and an empty string
 *     makes `not.toContain(...)` pass vacuously. Every test asserts something
 *     that must be PRESENT, and the first asserts the render is non-empty.
 *
 *  2. A real `QueryClient` (no fetch mocking), which keeps this hermetic and
 *     DOM-free: `environment: "node"` is sufficient for `renderToStaticMarkup`.
 */
async function renderRoute(url: string): Promise<string> {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	})
	const router = createAppRouter()
	router.update({
		history: createMemoryHistory({ initialEntries: [url] }),
	})

	// REQUIRED: without this the provider has no matches and renders "".
	await router.load()

	return renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	)
}

/** The outlet's content: everything between `<main …>` and `</main>`, as text. */
function mainText(html: string): string {
	const afterOpen = html.split("<main")[1] ?? ""
	const body = afterOpen.slice(afterOpen.indexOf(">") + 1).split("</main>")[0]
	return body
		.replace(/<[^>]*>/g, "")
		.replace(/\s+/g, " ")
		.trim()
}

describe("feature routes render their own page", () => {
	/**
	 * Each route's own `<main>` content. The labels come from each route's
	 * `LoadingState`, so a route that fails to render shows up as either an
	 * empty `<main>` or another route's label.
	 */
	const ROUTES: Array<[string, string]> = [
		["/dashboard", "Loading overview"],
		["/messages", "Loading messages"],
		["/moderation", "Loading moderation"],
		["/channels", "Loading channels"],
		["/users", "Loading members"],
		["/analysis", "Loading analysis"],
		["/glossary", "Loading glossary"],
	]

	for (const [url, label] of ROUTES) {
		test(`${url} renders its own outlet content`, async () => {
			const html = await renderRoute(url)

			// Guard the empty-render trap before asserting anything else: an
			// empty string would make the assertion below vacuous.
			expect(html.length, "render produced no output").toBeGreaterThan(0)

			const text = mainText(html)
			expect(text, `${url} <main> is empty — no child rendered`).not.toBe("")
			expect(text, `${url} rendered another route's content`).toContain(label)
		})
	}

	test("the shell chrome wraps the outlet", async () => {
		const html = await renderRoute("/moderation")

		// The chrome lives ABOVE the outlet, so its presence plus non-empty
		// outlet content proves the parent/child relationship is intact.
		expect(html).toContain("Guild Moderation Watcher")
		expect(mainText(html)).not.toBe("")
	})

	test("distinct URLs render distinct outlet content", async () => {
		const seen = new Map<string, string>()
		for (const [url] of ROUTES) {
			seen.set(url, mainText(await renderRoute(url)))
		}

		// A parent that renders in place of its children yields ONE identical
		// page for every URL. This asserts the property directly rather than
		// only per-route, so a shared page cannot pass by accident.
		const distinct = new Set(seen.values())
		expect(
			distinct.size,
			`${ROUTES.length} routes produced only ${distinct.size} distinct <main> content(s)`,
		).toBe(ROUTES.length)
	})
})
