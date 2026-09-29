@../../AGENTS.md

# Bete Frontend — Project Overview

React 19 + Vite SPA, TypeScript strict, Tailwind v4, shadcn/ui, base-ui.

Key points:
- **Client-rendered SPA** — `bun run build` emits `dist/`; `serve.mjs`
  (node builtins only) serves it on :4017 with an SPA fallback to
  index.html. First paint blocks on the per-route seed fetch
  (`useRouteSeed`), not on a server render.
- **Data layer** is browser-only: oRPC over WebSocket via partysocket at
  `src/lib/orpc/client.ts` (`/trpc`), typed events at `src/lib/ws/`
  (`/ws`). Same-origin through the reverse proxy in production.
- **Routing** in `src/router.tsx` (react-router): one element per route so
  navigation remounts the view and discards page-local state.
- **No authentication**: all endpoints are public

## Data flow (match these — do not invent endpoints)

```
Discord → discord-gateway → Redis pub/sub → backend (Express :4001) ←→ SPA browser
                                                ↑ REST /api/*        (via nginx proxy)
                                                └ WS /ws (events + PCM binary)
                                                      ↑ browser WS (same-origin /ws + /trpc)
```

- **Rendering**: `gmw-proxy` nginx (:4009) proxies `/` → static server
  (:4017, `node serve.mjs`), and `/api` + `/ws` + `/trpc` → backend :4001.
  Public host: `imphnen.asepharyana.my.id` (Caddy reverse proxy → :4009).
- **Seed pattern**: each route component fetches its initial data via
  `useRouteSeed` (blocking first paint) and passes it to its `view.tsx`;
  SWR takes over for revalidation afterwards.
- Local dev override: `VITE_WS_URL` for the browser sockets;
  `vite.config.ts` proxies `/trpc` + `/ws` to 127.0.0.1:4001.
- **Never hardcode a host** in api/ws clients — same-origin/env only.

## Backend response shapes that bite

- `GET /api/chat/history` → `{ history: ChatbotHistoryRow[], total }` where
  each row is `{ id, user_id, user_message, bot_response, context, created_at }`.
  Map rows to display messages in `chatbot-context.tsx`.
- `message_deleted` WS payload → `{ id, deleted_at }` (an object, not a string).
- Dashboard endpoints: `/api/dashboard/stats|users|channels` (+ `/:id` details).
- Channel/guild names live inside `message.metadata` JSON (`channel.channelName`),
  not top-level.

