/**
 * Type-only barrel for the API surface.
 *
 * The frontend imports from HERE, and only as types — it never reaches into
 * `apps/backend/src` for runtime code. `AppRouter` describes the RPC surface and
 * `AppRouterClient` is the client type derived from it, which is what lets
 * `apps/frontend/src/libs/api/browser.ts` drop its hand-written mirror of the
 * router shape and get the real one instead.
 *
 * Named `api-types.ts`, not `index.ts`: this repo's `src/index.ts` is the process
 * entrypoint (`main()` plus the graceful-shutdown ladder), and a type barrel
 * cannot share that path.
 *
 * TYPE-ONLY ON PURPOSE. Every export below is erased at compile time. Importing
 * a VALUE from this module into the frontend would drag `drizzle`, `pg`,
 * `discord.js` and `sharp` into the browser bundle — which is exactly why the
 * frontend reaches the backend for types only, never for runtime.
 */
import type { InferClientOutputs } from "@orpc/client"
import type { RouterClient } from "@orpc/server"
import type { buildRouter } from "./presentation/orpc/router.js"

export type { buildRouter, InferClientOutputs as InferClientOutput }
export type AppRouter = ReturnType<typeof buildRouter>

/**
 * The typed client the frontend gets from `createORPCClient`.
 *
 * `RouterClient` is oRPC's own router→client mapping, so this is the REAL shape
 * of the API rather than a hand-written mirror of it. A procedure added to the
 * backend appears here with no type to update — which is the drift that made
 * the old `lib/types/rpc.ts` possible in the first place, where a 170-line
 * mirror had to be kept in step with the router by hand and was cast through
 * `as unknown as` to boot.
 *
 * The client context is `Record<never, never>` because the dashboard has no
 * auth: `context: {}` is what both HTTP transports pass.
 */
export type AppRouterClient = RouterClient<AppRouter>
