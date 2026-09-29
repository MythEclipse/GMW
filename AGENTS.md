# GMW — Agent Guide

GMW (Guild Moderation Watcher) is a Discord bot + web dashboard for AI-powered moderation. A monorepo with three services: a selfbot gateway that captures Discord events and runs LLM moderation, an Express/oRPC backend that serves the dashboard API, and a React 19 + Vite SPA frontend. They communicate via Redis pub/sub (gateway→backend) and WebSocket (backend→browser).

## Quick reference

```bash
# Per-service — cd into the service first
bun install              # install deps (bun 1.3.14, not pnpm/npm)
bun typecheck            # tsc --noEmit
bun lint                 # biome check
bun format               # biome format --write
bun build                # gateway/backend: tsc + fix-imports.mjs; frontend: tsc + vite build
bun test                 # bun test tests/ (gateway & backend only — frontend has no tests)
```

No monorepo-level scripts exist. Run each command from inside the service directory.

## Layout

```
services/
├── discord-gateway/   Event-driven selfbot. No HTTP (except :4016 metrics).
│   ├── src/
│   │   ├── app/            Bootstrap, shutdown, retention
│   │   ├── modules/        Feature modules — each self-contained
│   │   └── shared/         Config, DB (Drizzle), logger, errors, utils
│   ├── tests/              Vitest tests (colocated, not inside src/)
│   ├── drizzle/migrations/ DB migrations
│   └── scripts/fix-imports.mjs  Post-build: rewrites @/ aliases → relative .js
│
├── backend/           Express HTTP + WebSocket + oRPC server (:4001).
│   ├── src/
│   │   ├── modules/        Feature modules (schema→repo→service→controller→routes)
│   │   ├── http/           Express app setup
│   │   ├── ws/             WebSocket server + Redis bridge
│   │   ├── orpc/           oRPC router definition
│   │   └── shared/         Config, DB, errors, Redis, logger
│   └── tests/              Vitest tests
│
└── frontend/          React 19 + Vite SPA, Tailwind v4 (:4017).
    ├── src/
    │   ├── src/            Routes — route components under (dashboard)/ + router.tsx
    │   ├── components/     UI components (primitives, shell, charts, etc.)
    │   ├── hooks/          React hooks (incl. use-route-seed for first paint)
    │   ├── lib/            API clients, types, utils, WebSocket, audio
    │   └── main.tsx        React entry (replaces the Next.js app/layout root)
    ```

    ## Conventions

    ### Package manager & runtime

    - **bun** (v1.3.14), package manager + test runner. Lockfiles (`bun.lock`) are committed. Node 22 is still used at runtime for the tsc-built `dist/` (via `fix-imports.mjs`), plus bun for dev/install/test. Bun is NOT the production runtime for gateway/backend — the Nix wrapper execs `node dist/index.js` — so native modules resolve against the Node ABI (e.g. `@discordjs/opus` prebuilds for node-v127).
    - ESM throughout (`"type": "module"` in all package.json files).
    - Test runner: **bun test** (`bun test tests/`). The old vitest configs are replaced by `bunfig.toml` `[test] preload = ["./tests/setup-env.ts"]` — note bun 1.3.14 **ignores `[test] env`**, so env vars for tests go in the preload file. Bun's jest-compat layer aliases most vitest APIs (`vi.fn`→`jest.fn`, `vi.useFakeTimers`→`jest.useFakeTimers`, `vi.spyOn`→`spyOn`, `vi.mock`→`mock.module`), but there is no `vi.waitFor` or `jest` global — use the small `waitForCompat` helper in `tests/placeholder.test.ts`.
- ESM throughout (`"type": "module"` in all package.json files).

### Import style

Source files use `@/*` path aliases (mapped in tsconfig to `./src/*`). Relative imports **must include the `.js` extension** (e.g., `from "./embed.js"`). The `moduleResolution: "bundler"` tsconfig setting allows bare specifiers during dev, but `tsc` emits them as-is. A post-build script (`scripts/fix-imports.mjs`) rewrites both `@/` aliases and extensionless imports in `dist/` so Node ESM can resolve them at runtime.

### Error handling

Both gateway and backend define an `AppError` base class in `@/shared/errors/index` with subclasses: `ValidationError` (400), `NotFoundError` (404), `UnauthorizedError` (401), `DatabaseError` (500), `ConfigError` (500). Services throw these; callers or middleware map them to HTTP status codes.

### Logging

Use `createChildLogger('module-name')` from `@/shared/logger/index`. Never use raw `console`. It wraps pino; in development it pretty-prints via `pino-pretty`.

### Config

Environment variables are validated with Zod at startup in `shared/config/index.ts` of both gateway and backend. Do not read `process.env` directly outside config modules.

### Module boundaries

- Gateway: each feature lives in `src/modules/<name>/` with its own `index.ts` barrel. Modules register event listeners and are composed in `src/app/bootstrap.ts`.
- Backend: `modules/<name>/` follows schema → repository → service → controller → routes. Data flows up only. No cross-module repository imports.
- Frontend: each route component under `src/app/(dashboard)/*/` seeds its first paint via `useRouteSeed` (oRPC over WebSocket through `src/lib/orpc/client.ts`, partysocket-backed) and passes the result to its `view.tsx`. Routes are client-only; there is no server component layer. One element per route in `src/router.tsx` so navigation remounts the view.

### API layer

The backend exposes an oRPC router mounted at `/trpc` (HTTP + WebSocket). The frontend does **not** use a REST `/api/*` layer — all data goes through oRPC procedures, and the dashboard only uses the WebSocket transport: a single RPCLink backed by partysocket for auto-reconnection. Results are asserted to the frontend's local types at each call site (the backend's router type is not imported into the frontend).

### Testing

- **Gateway**: Vitest, tests in `tests/` at the service root. Config sets env vars (`DISCORD_TOKEN`, `DATABASE_URL`, etc.) so tests run without real services.
- **Backend**: Vitest, tests in `tests/` and `src/`. Includes an `e2e.test.ts` excluded from CI (needs a live backend).
- **Frontend**: No test runner configured.
- Tests are pure-function / unit-level. Mock external dependencies; do not start real DB/Redis in tests.

### Formatting

Biome, 2-space indent, spaces. Config at repo root `biome.json`. `lint` uses `--diagnostic-level=error`; `format` auto-writes.

## Pitfalls

1. **Never commit without running `fix-imports.mjs` after `tsc`** — gateway and backend builds will produce ESM that crashes at startup (`ERR_MODULE_NOT_FOUND`).
2. **Don't add `@discordjs/opus` build-from-source flags** — it ships prebuilt binaries for Node 22. Forcing source builds in CI/Nix will fail or add minutes of compile time.
3. **Frontend seed fetches bypass the SWR cache** — `useRouteSeed` fetches fresh on every route mount (the dashboard is live). Do not add caching without understanding the live dashboard requirement.
4. **oRPC types are loosely coupled** — the frontend casts oRPC results to its own types with `as unknown`. Adding a field to the backend schema does not automatically update the frontend type. Update both sides.
5. **Gateway is a selfbot** (`discord.js-selfbot-v13`) — it uses a user token, not a bot token. It must not be deployed as a standard Discord bot.
