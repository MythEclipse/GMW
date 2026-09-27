# GMW Gateway Redesign — Audit & Target Architecture

> Status: design proposal, nothing implemented yet.
> Baseline captured 2026-09-27 on `main` @ `2e2e27c2`: `bun test tests/` = **135 pass / 7 skip / 0 fail**, `bun typecheck` clean.
> Diagrams: `gmw-gateway-redesign.drawio` (3 pages, editable) + `-p1/-p2/-p3.png`.

---

## 1. Why the flow is bad — it is not a style problem

The service is 19,039 LOC. `src/modules/ai-moderation/` is ~50 files in one flat
directory, and the git history is a record of *one workaround being added per
incident*:

| commit | what it added | churn |
|---|---|---|
| `e34dcd6b` | split text/media lanes so a slow image stops blocking text | +692 / −205 |
| `80daa9f0` | un-claim "budget overflow" messages stuck in `processing` | +148 / −14 |
| `045cdf1f` | realign stuck-recovery threshold 300s → 120s | +10 / −2 |
| `c888f239` | auto-delete severity eligibility fix | +104 / −10 |
| `b9bba643` → `c7f53e4f` | add a whole second analyzer (Jev), then delete it | +1217 → −1158 |
| `2b6ec592` | remove embedding cache + Qdrant | +42 / −1988 |

Every one of those was a *correct* local fix. The structure invited them: a
claim that could strand rows, and a scheduler whose state lived in RAM.

**98 config vars**, **31 of them `AI_*`**. Each new knob is a defect that hasn't
been designed out yet.

---

## 2. Root cause of the symptom you reported

You said messages get stuck / never get a verdict. Here is the exact path.

`messagesAnalysis.ts:215` — `getPendingMessagesByConversation()` claims **every
pending row in a conversation** with `FOR UPDATE SKIP LOCKED` and flips them all
to `ai_status='processing'`. That part is correct.

`batchScheduler.ts:122` — the scheduler then filters that claimed set down to
**this lane only** via `splitMessagesByLane()`. The other lane's rows are now
invisible to the process: they are not `pending` any more, so no timer will ever
pick them up.

`batchBudget.ts:57` — `computeBudgetOverflowMessages()` only sees the rows that
were *filtered into this lane*, so it cannot un-claim the orphans. The safety net
added in `80daa9f0` does not cover this case.

`messagesCleanup.ts:57` — the sweeper reverts rows stuck in `processing`, but only
after **120,000 ms**, and `AI_ANALYSIS_RECOVERY_INTERVAL_MS` is 10,000 ms, so
recovery lags by up to ~2 minutes per wave.

**Result:** any conversation mixing text and media stalls for ~2 minutes, and can
re-stall on the next wave. It is fully reproducible from the code.

*(Diagram page 3 traces this.)*

### The lane split does not actually work (D2)

The `e34dcd6b` commit (+692/−205) added text/media lanes so a slow image would
never block text. It fails to achieve that:

- `batchScheduler.ts:58,77-82` — when called **without** a lane (the normal path
  from `aiAnalyzer.ts:73` and `recovery-worker.ts:105`) it arms **two timers with
  the same delay**. Both call `getPendingMessagesByConversation`, whose
  `SELECT … FOR UPDATE SKIP LOCKED` is **lane-agnostic** — it claims *every*
  pending row for that conversation. Whichever transaction commits first takes
  the whole batch; the other gets `[]` and exits at `:126`. The `AnalysisLane`
  type, the per-lane lock records, and the two Piscina pools are all defeated on
  the common path. **Media messages can be analysed on `textWorkerPool`.**
- `analysisLanes.ts:17` — `laneOfMessage` calls `hasMediaContent(message)` with
  **no attachments argument**, so it sees only `metadata` evidence. The
  orchestrator itself passes loaded `attachments`
  (`moderationOrchestrator.ts:102`), so the two disagree about what "media" means.

### Full verified defect list

| # | Sev | Location | Problem |
|---|---|---|---|
| D1 | HIGH | `batchScheduler.ts:64-66` + `conversationState.ts:232-246` | The hard circuit-breaker gate is **unreachable** — the counter resets to 0 the moment it reaches 5, so no reader ever observes `>= 5`. The comment describes behaviour that does not exist. |
| D2 | HIGH | `batchScheduler.ts:58,77-82` | Lane-agnostic claim defeats the whole text/media split. *(above)* |
| D3 | MED | `analysisLanes.ts:16-18` vs `visionAnalyzer.ts:107-122` | Lane assignment ignores the `attachments` table. *(above)* |
| D4 | MED | `batchProcessor.ts:423-432` | Cooldown early-return releases the lock but never reverts the already-claimed `processing` rows → silent 120 s delay, then re-analysis. **Duplicated LLM bill.** |
| D5 | MED | `batchScheduler.ts:78-79` | A locked lane `continue`s with **no log and no re-arm**. The identical condition inside the timer *is* logged (`:100-104`). |
| D6 | MED | `moderationOrchestrator.ts:80` + `cacheStore.ts:28-47` | A connection factory is buried inside the orchestrator; it runs per `runModerationAnalysis`, lazily opening one ioredis client per Piscina thread, never closed. |
| D7 | MED | `batchProcessor.ts:247` vs `:354` vs `:379` | Three writes to `conversationErrorCooldown` with **two different merge semantics** — `:247` overwrites unconditionally and can *shorten* a longer cooldown set by the other lane. |
| D8 | MED | `mediaBatchProcessor.ts:85-88` vs `AI_ANALYSIS_PROCESSING_TIMEOUT_MS` | Media budget is `min(max(120s, 120s×N), 300s)` but the stuck threshold is 120 s. Any media batch with N≥3 is **legally in flight past the point where recovery reverts its rows** — two waves race, and the first overwrites the second's verdicts. |
| **D10** | **HIGH** | `moderationResponseParser.ts:243-247,253-257` + `llmCaller.ts:297-309` | A duplicate `message_id` **or any single deferral-analysis sentence** throws out of the whole-batch parser. One non-compliant message discards 59 valid verdicts → JSON repair → 4 full re-requests → **all 60 marked `analysis_parse_failed`** → 60 individual fallbacks. Verified in source: `parsed = targetIds.map(… status:"error")`. A ~120× cost multiplier from one sentence. |

Infrastructure findings from the same pass:

| # | Sev | Location | Problem |
|---|---|---|---|
| I1 | **Critical** | `shared/database/pool.ts:15-18` | Pools built with only `{min,max}` and **no `pool.on("error")` anywhere**. `pg-pool` emits `error` on idle-client failure; unhandled, `process-guards.ts:29-46` turns it into a full gateway shutdown. |
| I2 | High | `circuitBreaker.ts:40,54` + `ai-analysis-worker.ts:36-44` | **7 pg pools at runtime** (main + 6 Piscina threads; `minThreads` defaults high enough that all spawn eagerly), worst case 70 connections against a PgBouncer `default_pool_size=20`. |
| I3 | High | `app/lifecycle.ts:42-43,47-51` | 8 broadcaster injection points, every consumer `if (_broadcaster)`-guarded. A missed injection **silently drops live dashboard events** with no log. |
| I4 | High | `schema.ts` (4 tables) | `message_reviews`, `message_edits`, `moderation_actions`, `message_reactions` have `message_id` with **no FK** to `messages.id`. `retention.ts:65` deletes message rows, permanently orphaning all four — including the moderation audit trail. |
| I5 | Medium | `reactionCapture.ts:62,78,81` | Reaction PK is `${message_id}-${emoji}-${user_id}` with `onConflictDoNothing` on both add and remove → **re-adding an emoji is silently dropped**; history is permanently wrong. |
| I6 | Medium | `app/metrics-collector.ts:14,59,66` | Reads `pool._poolState`, a private Piscina field absent in piscina 5.3.2 (real API: `pool.threads`/`pool.utilization`). The `if` guard means **these gauges are never emitted**; `ARCHITECTURE.md:177-178` is wrong. |
| I7 | Medium | `shared/database/init.ts:95-104` | `executeAll` returns `result.rows` (an array) but `pruneExpiredTexts` casts to `{rowCount}` and reads `.rowCount` → always `undefined` → always `0`. The 6-hourly cache sweep **does nothing**; `text_analysis_cache` grows unbounded. |

Also: `individualFallbackProcessor.ts:54` keeps **one global** error counter for all
conversations (a single slow vision call pushes it toward the threshold of 50 and
silences every conversation's fallback); 33 config vars are missing from
`.env.example` and 12 disagree with the Zod default; three docs disagree on the
metrics port (4016 / 4018 / 9090); `README.md` + `AGENTS.md` still say
**pnpm + vitest** while `package.json` runs `bun test` (contradicted by `7be069d7`).

### Contract findings that change the migration

- **The backend sends ZERO commands.** `publishCommandNoReply` is imported once
  (`backend/src/orpc/router.ts:13`) and never called; `publishCommand`,
  `getCommandPublisher`, `subscribe` have 0 call sites; `startCommandBridge` is
  never called. All three gateway command handlers (`guilds:list`,
  `guilds:text-channels`, `moderation:action`) are **unreachable today** — which
  is why the dashboard answers guild/channel questions from the DB archive
  instead of the live client. The whole `backend:command` channel is free to
  redesign, but it must be **built** to move delete/DM to the backend, not reused.
- **The WS `timestamp` is rewritten.** Gateway sends `number`
  (`redis-channels.ts:52`); the backend re-stamps an ISO string
  (`ws/server.ts:205`). Do not assume the number survives the hop.
- **`moderation-types.ts` has drifted 8 ways.** The dangerous pair is
  `username`/`server_nick` on `ModerationAction` — present in the gateway type,
  absent from the backend's, yet selected by backend raw SQL *and* required by
  the frontend. Consolidate to one shared package.
- **Three tables the backend reads via hand-written SQL** (`moderation_actions`,
  `message_reactions`, `message_edits`) have no Drizzle model on that side, so
  column drift there is undetectable at compile time. Largest untyped boundary
  in the system.
- **`messages` is dual-written in code** (backend `messages.repository.ts:271,327,386`
  has insert/update/delete). Zero call sites today, so it is latent — but
  activating any backend write on `messages` creates real split-brain. Delete it.

---

## 3. Decisions taken (from your answers)

- **Greenfield rewrite.** DB schema and Redis contracts may change; you migrate.
- **Moderation becomes its own process.** Stateless, N replicas.
- **The backend executes deletes and DMs**, using a separate official bot token.
  The selfbot no longer performs actions against users.

Unchanged constraint: the selfbot stays **one process with one Discord
connection** — that is a Discord condition, not a design choice.

---

## 4. Target architecture

*(Diagram page 1.)*

```
Discord ──► discord-gateway ──► PostgreSQL ──► moderation-worker ──► verdict
            (capture only)     (state machine)  (stateless, N×)        │
                                                                    ▼
                                              backend ──► delete / DM (bot token)
                                                     └──► dashboard API + WS
```

Three properties do the real work:

1. **The gateway never judges and never schedules.** It normalises and persists.
   If it crashes, unsent messages are simply not captured — no half-owned work.
2. **The worker is stateless.** All coordination is a `FOR UPDATE SKIP LOCKED`
   claim. Scale to N replicas by starting more processes; a restart loses nothing.
3. **Postgres is the only scheduler.** There is no debounce timer, no lane lock,
   no cooldown map, no sweeper.

### The claim is per-row, and that is the fix

```sql
UPDATE messages SET
    status       = 'claimed',
    lease_until  = now() + interval '90 seconds',
    attempts     = attempts + 1,
    worker_id    = $1
WHERE id IN (
  SELECT id FROM messages
  WHERE status = 'pending'
    AND ready_for_work_at <= now()
    AND deleted_at IS NULL
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 40
)
RETURNING *;
```

The text/media distinction becomes a `WHERE` clause, not a post-claim filter. A
row is never claimed by a worker that cannot process it, so the entire
budget-overflow + stuck-sweeper class disappears.

State machine *(diagram page 2)*:

```
captured → pending → claimed → analyzed
             ↑          │
             │          ├─ error → retry_wait → pending (backoff)
             │          │                  └→ dead (attempts ≥ max, visible)
             └──────────┴─ lease expired → pending   (worker crashed)
```

### What this makes impossible

- A stuck message: `pending` is a *query*, not a schedule.
- A leaked lock: a lease is a timestamp; an expired one is simply re-claimable.
- Double-processing: `SKIP LOCKED` is the atomic claim, not a RAM flag.
- Silent data loss: `dead` is a real terminal state you can see and requeue.

---

## 5. Why not a smaller change

The tempting middle path is "keep one process, replace the in-memory state with
a DB-backed one." Rejected because the user-visible bugs are all *cross-restart*
bugs: today, every restart drops in-flight work into a hole only the sweeper can
find, and the sweeper lags 120 s. Splitting the process makes that structurally
impossible rather than merely better-tuned. You already authorised the split.

Rejected alternatives, kept here so they are not re-proposed:

| rejected | why | revive if |
|---|---|---|
| Keep one process, DB-backed state | fixes coordination, leaves the gateway crashing on LLM/network faults and taking capture down with it | you later want a single deployable unit |
| Keep Piscina, add a queue in front | keeps 6 hidden DB pools and the N×10 connection blowup | never — this is a pure cost |
| Fix only the lane-claim bug | +10 LOC, removes this one instance; the four sibling bugs survive | you reject the process split |
| Drop the debounce, batch by time window | simpler, but re-bills every message from cold cache when a burst spans a window | latency target loosens |

---

## 6. Migration plan

Each step is independently deployable and the old service keeps running until
step 4.

1. **New DB tables** — `messages` gains `status`, `lease_until`, `attempts`,
   `ready_for_work_at`, `worker_id`, `last_error`; add
   `INDEX (status, lease_until)`. Verdict columns move to a `verdicts` table
   (1 row per message, not 10 nullable columns on `messages`).
2. **Backfill** — `pending` for everything currently `pending`/`processing`;
   drop rows already `clean`/`warn`/`flagged` into `verdicts`.
3. **Ship `moderation-worker`** in parallel. It claims only rows tagged
   `owner='worker-v2'`; the old pipeline keeps its rows. Compare verdict parity
   on the same messages.
4. **Cut over** — gateway writes `owner='worker-v2'`, old worker drains, then
   delete `conversationState.ts`, `batchScheduler.ts`, `individualFallbackProcessor.ts`,
   `recovery-worker.ts`, `circuitBreaker.ts`, `ai-analysis-worker.ts` and ~1,300
   LOC of in-memory coordination.
5. **Move actions to the backend** — this needs the `backend:command` path
   *built*, not reused: it currently sends zero commands. Add an official bot
   token, wire `recommended_action` → `delete`/`DM`, and write a
   `moderation_actions` audit row per execution. Add the missing
   `pool.on("error")` handler while touching `pool.ts` (I1).
6. **Prune** — 98 config vars → ~8. Remove the two dead channels
   (`discord:attachment:uploaded`, `discord:analysis:queue_status` have zero
   publish call sites). Fix the pnpm/vitest doc drift.

---

## 7. Contracts that must not break

Verified against both sides of the wire:

- **17 Redis channel names** — byte-identical in
  `discord-gateway/src/shared/redis-channels.ts:12-28` and
  `backend/src/shared/redis-channels.ts:12-28`. The backend subscribes by
  `Object.keys()` of its own map, so a renamed channel is silently dropped.
  Keep the names; payloads may gain fields.
- **Channel → WS event mapping** — `DISCORD_CHANNEL_TO_WS_EVENT` in
  `redis-channels.ts:82-99` is duplicated in the backend. Keep in sync.
- **Gateway owns all DDL.** The backend has no migrations; the gateway's
  `drizzle/migrations/` is the sole schema authority. A greenfield schema means
  the gateway must keep owning migrations.
- **Live Discord event stream** — only the selfbot can produce it. Reactions,
  presence, threads, members, topics stay in the gateway.
- **`moderation-types.ts` is hand-duplicated** in both services and drifts by
  field. Replace the copy with a generated/shared contract in step 1.
- **Safe to change:** `attachment_uploaded` and `analysis_queue_status` (dead —
  no publisher), the ad-hoc `Record` payloads for topic/presence/member events,
  and the queue-status WS shape.

---

## 8. Open questions for you

1. **Batch policy.** The new claim is per-row. Do you still want conversation
   batching (cheaper: 1 LLM call per 20 messages), or per-message judging
   (accurate, ~20× the cost)? My recommendation: keep conversation batching, but
   batch *after* claiming — group by `channel_id` in the worker, never in the claim.
2. **Cache.** Keep exact-hash content+context caching, or drop it for v1 and
   measure LLM spend first? It is currently a source of correctness risk
   (cross-channel "clean" reuse) and roughly 1,200 LOC.
3. **Retention.** Confirm the new `messages`/`verdicts` split is acceptable, or
   keep verdicts inline for simpler dashboard queries.
