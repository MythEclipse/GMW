# GMW — Guild Moderation Watcher

A self-hosted watcher for a Discord guild: it captures every message (and the
evidence around it), judges each one against a written policy with an LLM,
deletes what violates it, and shows the whole thing on a dashboard.

It is one Node process, one PostgreSQL database, and one Redis. Everything —
the HTTP dashboard, the Discord capture, and the moderation worker — runs in
`apps/backend/src/index.ts`.

```
┌────────────────────────────── GMW (one process) ──────────────────────────────┐
│                                                                               │
│  Discord ──► capture ──► messages (ai_status = 'pending')                      │
│              │                                                                │
│              │        worker: claim_messages() lease ──► prompt + policy.ts    │
│              │                                        │                       │
│              │                                        ▼                       │
│              │                              LLM (OpenAI-compatible)           │
│              │                                        │                       │
│              │                                        ▼                       │
│              │                              verdicts (clean|deleted|error)    │
│              │                                        │                       │
│              │              verdictNotifier ──► Redis ──► WS ──► dashboard     │
│              │                                        │                       │
│              └──── auto-delete enforcer (polls verdicts) ──► Discord delete    │
│                                            │                                  │
│                                            └──► moderation_actions (audit)    │
└───────────────────────────────────────────────────────────────────────────────┘
```

Two properties the whole design is built around:

- **Capture never waits on the model.** A message is queued by simply being
  written to Postgres with `ai_status = 'pending'`. The worker claims rows with
  a time-boxed lease (`claim_messages()`), so a slow or dead model can never
  stall capture, and a worker killed mid-batch loses nothing — a peer or the
  next boot reclaims the lease.
- **The dashboard never hides an outage.** The HTTP surface starts first and a
  failure in Discord capture or in the worker is logged, not fatal: a process
  that exits takes the dashboard down with it, and a dashboard that is down
  hides the fact that moderation is down.

---

## What gets captured

Wired in `apps/backend/src/presentation/gateway/lifecycle.ts`:

| Module | Captures |
|---|---|
| `message-capture` | message create / update / delete, edits, threads, channel location (name + topic), embeds, link previews |
| `reaction-tracking` | reactions and reactors |
| `thread-tracking` | thread creation and metadata |
| `user-presence` | presence changes |
| `channel-topic` | channel topic edits |
| `guild-member-events` | joins, leaves, nickname changes |
| `event-broadcaster` | publishes all of the above to Redis for the dashboard |

Background schedulers started alongside: the auto-delete enforcer, verdict
notifier, retention sweep, and the weekly moderation digest.

Capture is filtered by configuration, in three distinct tiers:

| Env | Effect |
|---|---|
| `EXCLUDED_CHANNEL_IDS` / `EXCLUDED_THREAD_IDS` | never stored, never on the dashboard |
| `AI_SKIP_ANALYSIS_CHANNEL_IDS` / `_THREAD_IDS` / `_USER_IDS` | stored and visible, but terminal `skipped` — never judged, never re-claimed |
| `BOT_EXCLUDED_CHANNEL_IDS` | bot messages ignored in those channels; bot detection stays on elsewhere |

A thread stores its **parent's** id in `channel_id`, so listing a channel in a
skip list also exempts every thread under it — but a skip list cannot address a
single thread by its own id through the channel list. Use
`AI_SKIP_ANALYSIS_THREAD_IDS` for that.

---

## The moderation model

### Two columns, two different questions

| Column | Answers |
|---|---|
| `messages.ai_status` | *Where is this in the queue?* `pending → claimed → analyzed`, plus `retry_wait`, `dead`, `skipped`. Enforced by a CHECK constraint in the schema. |
| `verdicts.status` | *What did the judge decide?* `clean` \| `deleted` \| `error`. |

`ai_status` never carries the outcome. A consumer that needs "judged clean"
versus "not judged yet" must join `verdicts` — filtering on `ai_status` for a
judgement reads the wrong column and returns nothing.

There is no severity tier and no review tier. `verdicts.status` **is** the
decision, and `verdicts.reason` is required (non-empty) whenever the status is
`deleted`, so every deletion is auditable and appealable. `error` is not a
middle tier: it means the model could not read the message, and it never
authorises a deletion.

### Enforcement

`autoDeleteEnforcer.ts` polls `verdicts` every 5s (bounded batch of 10), never
the worker and never Redis, so the two halves stay decoupled: the gateway reads,
the worker writes, neither waits on the other. A row is considered exactly
once, recorded in a sentinel column on the verdict itself so the decision
survives a restart and is visible on the dashboard.

Auto-delete has no dry-run and no disable switch, but it does have gates:

- `AUTO_DELETE_MIN_CONFIDENCE` (default `0.5`)
- `AUTO_DELETE_ALLOWED_CATEGORIES`, `AUTO_DELETE_EXCLUDED_CHANNEL_IDS`,
  `AUTO_DELETE_EXCLUDED_USER_IDS`
- a verdict of `error` is never eligible
- a bare-link post with no resolved preview is not judgeable and is not deleted
- a message whose sender set `SUPPRESS_EMBEDS` carries no evidence at all and
  is never deleted, at any confidence
- nickname violations reset the nickname instead of deleting the message when
  the evidence supports it (`AUTO_NICKNAME_RESET_COOLDOWN_MS`)

Every attempt writes a `moderation_actions` row (`pending` / `executed` /
`failed`) — that table, not `messages.deleted_at`, is how you tell what the
bot did. `deleted_at` is written only from Discord's own delete event and fires
for moderator deletions too; `verdicts.auto_delete_state` is what identifies
the bot as the deleter.

### Evidence must reach the prompt

The commonest defect class in this codebase is not a bad model — it is
evidence that was captured, stored, and never interpolated into the prompt.
The rules, the few-shot examples, and the machine-checkable output contract all
live in `ai-moderation/policy.ts`. Nothing imports `OUTPUT_CONTRACT` at runtime
— it is prose for the model — so the guard is the prompt-wiring tests, which
assert the *captured prompt* actually carries the evidence:
`tests-gateway/linkEmbedEvidence.test.ts`,
`tests-gateway/channelContextWiring.test.ts`,
`tests-gateway/memoryBank.test.ts`.

When adding a new evidence source, follow the shape the link fix established:
capture into `metadata`, add a `format*ForPrompt` helper next to the other
capture→prompt helpers, **select the column in the claim query**, interpolate
it, and add a rule block to `policy.ts` — then assert on the *prompt*, because
a unit test on the formatter alone passes while the feature stays inert.

---

## Repository layout

```
apps/
  backend/
    src/
      index.ts                     process entry: HTTP → capture → worker, reverse on shutdown
      domain/                      framework-free types and rules
      application/                 use cases, composed by presentation/composition.ts
      infrastructure/
        config/                    zod config schema (validates at import time)
        database/                  drizzle schema, pool, migrations, claim SQL
        modules-gateway/           capture, ai-moderation, event-broadcast, retention …
        repositories/              read/write projections
      presentation/
        http/                      hono + oRPC + /ws
        gateway/                   Discord bootstrap and lifecycle
        worker/                    moderation worker bootstrap
    drizzle/migrations/            0000_baseline.sql = the schema of record
    tests/  tests-gateway/         vitest suites (unit + Postgres-backed)
  frontend/
    src/routes/                    TanStack Router routes (the seven dashboard pages)
    src/libs/navigation.ts         single source of truth for nav + command palette
infra/
  systemd/  nginx/  docker/        deploy definitions
scripts/                           deploy, reset, migration helpers
.github/workflows/                 ci.yml (PRs) and deploy.yml (push to main)
```

Layering rule: `infrastructure/modules-gateway/` may import `domain/` and other
infrastructure siblings, never `application/` or `presentation/`. `drizzle-orm`
does not appear in `src/domain/`, `getDatabase()` does not appear in
`src/application/`, and nothing in `src/infrastructure/` imports from
`presentation/`.

---

## The dashboard

Seven destinations, one per router the backend exposes. `navItems` in
`apps/frontend/src/libs/navigation.ts` is the only source of truth — the rail,
the mobile dock and the command palette all read it.

| Route | What it shows |
|---|---|
| `/dashboard` | guild-wide moderation health, activity, top channels |
| `/messages` | live message stream with verdict and queue state |
| `/moderation` | verdicts, enforcement actions, trends, coverage |
| `/channels` | per-channel volume, flagged rate, and culture |
| `/users` | most active members and their moderation profile |
| `/analysis` | search across analysed messages and their verdicts |
| `/glossary` | channel slang, term glossary, and flagged domains |

Backend routers: `dashboard`, `messages`, `moderation`, `analysis`, `chatbot`,
`knowledge`, `config`, `uiState`. Reads are public; the two writing procedures
(`uiState.update`, `chatbot.clearHistory`) require the `x-mutation-token`
header — `presentation/orpc/mutation-guard.ts`.

Realtime: capture publishes to Redis, `presentation/ws/server.ts` republishes to
the browser, and `verdictNotifier` polls `verdicts` so badges update live
instead of freezing at their server-rendered value.

---

## Getting started

Requirements: Node ≥ 22.12, pnpm 10, PostgreSQL, Redis.

```bash
pnpm install
cp .env.example .env               # fill in the required values
set -a; source .env; set +a        # the server reads process.env directly —
                                   # only the migration CLI (migrate.ts) does
                                   # `import "dotenv/config"`. Without this,
                                   # `pnpm run dev` boots with no config.
pnpm run dev                       # backend (tsx watch) + frontend (vite), both
                                   # projects
```

`.env` is gitignored. Everything it should contain is documented in
`.env.example`; production values live in secrets, not in the file.

Minimum configuration to boot:

| Var | Why |
|---|---|
| `DISCORD_TOKEN` | required — the capture client cannot start without it |
| `MONITOR_GUILD_ID` | the guild being watched |
| `DATABASE_URL` (or `POSTGRES_*`) | required |
| `REDIS_URL` | event bus and command channel |
| `AI_LLM_API_KEY` | **required** — the gateway refuses to start without LLM credentials. There is no on/off switch for moderation: a half-applied env must not leave the queue silently unmoderated, which is indistinguishable from "nothing was violating" |

Migrations run automatically at gateway bootstrap (`runMigrations()`), so a
fresh database needs no manual step.

Ports — note the mismatch before you debug a blank dashboard:

| Where | Port |
|---|---|
| backend HTTP/WS (`WEBSERVER_PORT`) | **4001** in every deployed environment (nginx upstream, `docker-compose.yml`, CI health check, and the Vite dev proxy). The zod schema's default is `3001`, so a local run must set `WEBSERVER_PORT=4001` or the Vite proxy will be talking to nothing |
| Vite dev server | `5173`, proxying `/trpc` and `/ws` to `GMW_DEV_BACKEND_PORT` (default `4001`) |
| frontend preview | `4017` |
| nginx (`infra/nginx/nginx.conf`) | `4009` — the public entry: `/api`, `/ws` and `/trpc` go to the backend on 4001, everything else to the frontend on 4017 |
| metrics (`METRICS_PORT`) | `9090` |

---

## Verification

Five gates, all must exit 0:

```bash
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run build
pnpm run lint:design
```

Or as the CI runs them, from the repo root: `pnpm run typecheck; pnpm run lint;
pnpm run test; pnpm run build; pnpm run lint:design`.

Every gate goes through `pnpm run`, never a bare `moon` — `moon` is not on PATH
in the runner's shell, so a raw `moon run :typecheck` dies with exit 127 before
any check runs.

One extra task, `pnpm exec moon run backend:db-check`, exits 2 **by design**:
the repo has no drizzle baseline snapshot, so it cannot evaluate migration
drift. CI marks it `continue-on-error`. That is not a failure.

### Tests

`apps/backend` runs vitest (`tests/**` and `tests-gateway/**`).
`tests/setup-env.ts` sets synthetic env *before* any module imports the config
singleton — that ordering is load-bearing, since `loadConfig()` validates at
import time — and points `DATABASE_URL` at a dead port on purpose so a unit test
that accidentally opens a pool fails loudly.

Postgres-backed files take their own throwaway schema via
`tests-gateway/isolated-pool.ts`. To run them you need a real test database and
`TEST_DATABASE_URL` set (see `.env.test.example`); in CI,
`GMW_REQUIRE_TEST_DB=1` makes a file that cannot build its schema **fail**
rather than skip, because a missing database used to read as 21 silently
skipped files against a green run.

---

## Deployment

CI is the deploy path. `.github/workflows/deploy.yml` runs on every push to
`main`: test → build → ship to the VPS, restarting the services and failing the
step if the backend is not active afterwards. `.github/workflows/ci.yml` runs
the same checks on pull requests and on pushes to any other branch — it is the
gate in front of the deploy.

Service definitions live in `infra/systemd/`:

| Unit | Role |
|---|---|
| `gmw-backend` | HTTP/oRPC/WS + Discord capture + moderation worker; env from Bitwarden via `bws-exec gmw` |
| `gmw-frontend` | the built SPA |
| `gmw-proxy` | nginx, port 4009 |

Production config is declarative: the runtime env file is written by CI from
secrets. Do not hand-edit env on the server — the next deploy overwrites it.

`RESET_RUNTIME_DATA` stays **unset**. Every deploy wipes the runtime data by
design; the post-reset state (`guilds = []` while `monitorGuildId` still comes
from env) is a normal production state that every view must render, not a bug to
be softened with a flag.

---

## Observability

- **Logs** — pino, child loggers per subsystem (`capture`, `ai-moderation`,
  `auto-delete-enforcer`, `command-handler`). `LOG_LEVEL` sets the level,
  `VERBOSE=true` emits every `discord.js` debug line instead of only
  errors/streams.
- **Metrics** — prom-client on `METRICS_PORT` (9090): the backend registry plus
  the gateway's own pipeline gauges, in one process.
- **Trace** — each judged batch carries a `traceId()`, the last 12 characters of
  a snowflake. A `WHERE id IN (...)` lookup on it returns nothing; query
  `right(id, 12)` instead.

### Quick diagnosis

| Symptom | Look here |
|---|---|
| Results "disappeared" from the dashboard | almost never data loss. Query the join the dashboard reads (`messages ⨝ verdicts` where `ai_status = 'analyzed'`), then the worker log for a repeating `claimed-batch` with the same ids and a growing `avgWaitMs` — that is queue starvation, not loss |
| Empty analysis queue | `claim_messages()` only picks up rows with `deleted_at IS NULL`, so a message deleted in Discord while still pending is correctly skipped, not stalled. Retention (`RETENTION_MESSAGES_DAYS`, default `0` = off) hard-deletes expired rows outright rather than marking them |
| A verdict reads as nonsense | evidence that never reached the prompt. In order: is the column in the claim SELECT, does the formatter have a caller, is it interpolated into the prompt body |
| Everything comes back `clean` | the writer, not the prompt — check what `verdicts.status` was bound to, not what the model said |
| The bot deleted nothing | count the audit rows: `SELECT count(*) FROM moderation_actions`. A feature that has never produced a row is not working |
| Config throws at import | `loadConfig()` refuses to boot when `NODE_ENV=production` and `MUTATION_TOKEN` is missing or under 16 chars; a missing secret crash-loops the unit |

---

## Design invariants

Do not undo these without an argument that addresses why they were introduced:

1. **One decision column.** `verdicts.status` is the whole judgement. Do not
   re-add `severity`, `recommended_action`, or any second field encoding the
   same decision — two fields for one decision is what forced an arbitration
   function to exist the first time. `reason` is different in kind: it is
   evidence about a deletion, not a competing verdict.
2. **The queue is the database.** No in-process `Map`, scheduler, or cooldown
   may become load-bearing. Correctness is enforced by `claim_messages()` and
   the deferred trigger, not by control flow in `worker.ts`.
3. **A message we cannot read is never auto-deleted**, at any confidence —
   including `SUPPRESS_EMBEDS` and a link whose preview Discord never resolved.
   The model handed a blank still emits a confident verdict.
4. **Memory and dictionary are references, never verdict drivers.** The prompt
   says so explicitly: past verdicts carried in the memory block cannot change
   status, action, score, confidence or flags, and dictionary absence is not
   suspicious. Keep the anti-invention half intact when reworking it.
5. **Two dispositions only.** A message that should be judged again is
   rescheduled with a cap and a backoff; a message that will never be judged is
   `skipped`. There is deliberately no uncapped release — adding one back is how
   six rows reached 3000+ attempts and starved the queue.
6. **Evidence is rendered as attributes of `<message>`, never as a sibling
   element**, and it degrades to `""` per attribute rather than to an empty
   value that asserts "this channel has no purpose".
7. **The system prompt is built last** — after vision descriptions, memory
   recall and dictionary lookups resolve — because every one of those flags is
   part of the prompt cache key.
8. **`RESET_RUNTIME_DATA` stays unset.**
