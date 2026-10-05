import { timingSafeEqual } from "node:crypto"
import { ORPCError, os } from "@orpc/server"
import { config } from "../shared/config/index.js"

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` throws when the two buffers differ in LENGTH, so the length
 * has to be compared first. Comparing lengths with `===` leaks only the length,
 * which is not a secret worth protecting here — the token's length is fixed by
 * the production check in loadConfig().
 */
function safeEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a, "utf8")
	const bufB = Buffer.from(b, "utf8")
	if (bufA.length !== bufB.length) return false
	return timingSafeEqual(bufA, bufB)
}

/**
 * The context shape the guard requires.
 *
 * `os.use` infers `TCurrentContext` from the builder it is called on, and a bare
 * `os` starts from an empty context — so `context.headers` fails to typecheck
 * until the requirement is stated. Declaring it here also documents the
 * contract: any handler mounting this router must supply these headers, and the
 * RPCHandler in http/app.ts does.
 */
export interface MutationContext {
	headers: Headers
}

/**
 * The only gate on write procedures.
 *
 * WHY A SHARED SECRET AND NOT A USER MODEL: the dashboard has no users and no
 * session. Adding one is a product decision, not a security patch. Every read
 * procedure stays public — that is the existing, intentional posture, and this
 * change does not touch it. What it does is stop the two procedures that WRITE
 * to the database from being reachable by anyone who can reach the port.
 *
 * WHY A HEADER AND NOT A QUERY PARAMETER: a token in a query string lands in
 * access logs, browser history, and Referer headers. A header does not.
 *
 * FAIL-CLOSED: when MUTATION_TOKEN is unset, every write is rejected. Treating
 * "unset" as "no auth required" is the exact bug this replaces, so it is not an
 * option. In production loadConfig() refuses to boot without a token, so the
 * unset case only arises in development.
 *
 * The browser client cannot satisfy this gate: it would have to hold the token
 * in the bundle, where anyone can read it. That is acceptable because nothing in
 * the dashboard calls a write procedure (verified 2026-10-06 — `uiState.update`
 * and `chatbot.clearHistory` have no frontend consumer). If a UI ever needs
 * one, the right shape is a real user model behind a session, not a token
 * shipped to the browser.
 */
export const mutationProcedure = os.use(async ({ next, context }) => {
	// `os` is typed with an empty context, so the headers are read through the
	// declared shape. Both transports populate it (http/app.ts from the fetch
	// Request, orpc/ws.ts from the upgrade IncomingMessage), and the optional
	// chaining keeps a future transport that forgets from crashing here — it
	// fails closed below instead.
	const { headers } = context as MutationContext

	const expected = config.MUTATION_TOKEN
	const provided =
		headers?.get("x-mutation-token") ??
		(() => {
			const auth = headers?.get("authorization")
			return auth?.startsWith("Bearer ") ? auth.slice(7) : undefined
		})()

	if (!expected || !provided || !safeEqual(provided, expected)) {
		throw new ORPCError("UNAUTHORIZED", {
			message: expected
				? "This procedure writes to the database and requires a valid x-mutation-token header."
				: "Writes are disabled: MUTATION_TOKEN is not configured on the server.",
		})
	}

	return next()
})
