# Bete Frontend

React 19 + Vite SPA dashboard untuk Discord Moderation Watcher.

**Stack:** React 19, Vite, react-router, TypeScript strict, Tailwind v4, shadcn/ui, base-ui, lucide-react.

## Dev

```bash
bun run dev        # vite dev — port 5173 (proxy /trpc + /ws ke backend 4001)
bun run build      # tsc + vite build — output ke dist/
bun run lint       # Biome check + oxlint
bun run start      # serve.mjs — serve dist/ di 127.0.0.1:4017 (prod lokal)
```

## Architecture

```
src/
├── main.tsx               # React entry (mount #root, ThemeProvider)
├── router.tsx             # Route table (react-router, redirect / ke /dashboard)
├── app/
│   └── (dashboard)/       # Route components — satu per halaman + view.tsx
├── components/            # UI (primitives, shell, charts, chatbot, command)
├── hooks/                 # Shared hooks (use-route-seed, config, auth)
└── lib/
    ├── orpc/client.ts     # oRPC over WebSocket (/trpc, partysocket)
    ├── ws/                # Typed event socket (/ws) + React context
    └── api/browser.ts     # Browser-side fetcher untuk live ops
```

## API

Backend berjalan di port 4001. Frontend mengakses API via `window.location` (same-origin atau proxy).

WebSocket terhubung otomatis ke `/ws` di host yang sama.
