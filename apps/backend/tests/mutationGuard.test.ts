import { createRouterClient } from "@orpc/server"
import { describe, expect, it } from "vitest"
import { config } from "../src/infrastructure/config/index.js"
import { mutationProcedure } from "../src/presentation/orpc/mutation-guard.js"

/**
 * The write guard, exercised through oRPC's own router client so the assertions
 * are about real procedure dispatch rather than a re-implementation of the
 * check.
 *
 * This is the test that was missing when `uiState.update` was reachable without
 * authentication: nothing asserted that a write required anything.
 *
 * WHY `createRouterClient` AND NOT `call`: with a bare `os` procedure the
 * initial context is typed `Record<never, never>` and `call()` DROPS the
 * `context` option entirely — the middleware sees `{}` no matter what is
 * passed. Context reaches `os.use` only when it is supplied at the router
 * layer, which is exactly how both real transports do it (http/app.ts passes it
 * to RPCHandler.handle; orpc/ws.ts to handler.upgrade). Using `call()` here
 * tested a path the server never takes, and the positive cases failed for
 * exactly that reason.
 *
 * WHY THE TOKEN IS MUTATED RATHER THAN SET THROUGH THE ENVIRONMENT: `config` is
 * a singleton evaluated at import time, and `vi.resetModules()` does not
 * reliably produce a fresh one. Writing the property the guard actually reads is
 * simpler, and honest about there being one config per process.
 */

const TOKEN = "correct-horse-battery-staple"

const router = { write: mutationProcedure.handler(() => ({ ok: true })) }

const invoke = async (headers: Record<string, string>) => {
	const client = createRouterClient(router, {
		context: { headers: new Headers(headers) },
	})
	return client.write()
}

const withToken = async (token: string, run: () => Promise<void>) => {
	const previous = config.MUTATION_TOKEN
	config.MUTATION_TOKEN = token
	try {
		await run()
	} finally {
		config.MUTATION_TOKEN = previous
	}
}

describe("mutation guard", () => {
	it("rejects a write when MUTATION_TOKEN is unset on the server", async () => {
		await withToken("", async () => {
			await expect(invoke({ "x-mutation-token": "anything" })).rejects.toThrow(
				/Writes are disabled/,
			)
		})
	})

	it("rejects a write with no token supplied", async () => {
		await withToken(TOKEN, async () => {
			await expect(invoke({})).rejects.toThrow(/x-mutation-token/)
		})
	})

	it("rejects a write with the wrong token", async () => {
		await withToken(TOKEN, async () => {
			await expect(invoke({ "x-mutation-token": "wrong" })).rejects.toThrow(
				/x-mutation-token/,
			)
		})
	})

	it("rejects a write whose token is a prefix of the real one", async () => {
		// A naive `startsWith` comparison would let this through; the guard uses
		// timingSafeEqual, which is why the length check comes first.
		await withToken(TOKEN, async () => {
			await expect(
				invoke({ "x-mutation-token": TOKEN.slice(0, 13) }),
			).rejects.toThrow(/x-mutation-token/)
		})
	})

	it("rejects a token that merely extends the real one", async () => {
		await withToken(TOKEN, async () => {
			await expect(
				invoke({ "x-mutation-token": `${TOKEN}-and-more` }),
			).rejects.toThrow(/x-mutation-token/)
		})
	})

	it("accepts a write with the correct token", async () => {
		await withToken(TOKEN, async () => {
			await expect(invoke({ "x-mutation-token": TOKEN })).resolves.toEqual({
				ok: true,
			})
		})
	})

	it("accepts the token as an Authorization: Bearer header", async () => {
		await withToken(TOKEN, async () => {
			await expect(
				invoke({ authorization: `Bearer ${TOKEN}` }),
			).resolves.toEqual({
				ok: true,
			})
		})
	})

	it("fails closed when a transport supplies no headers at all", async () => {
		// The guard must not throw a TypeError on a missing context, and must not
		// fall open — a future transport that forgets to pass headers gets a
		// rejection, never an accidental success.
		await withToken(TOKEN, async () => {
			const client = createRouterClient(router, { context: {} })
			await expect(client.write()).rejects.toThrow(/x-mutation-token/)
		})
	})
})
