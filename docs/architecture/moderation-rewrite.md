# GMW moderation — what was replaced, and why

Status: **implemented and verified.** The old moderation pipeline is deleted, not
deprecated. This file records what went, what replaced it, and what is still open.

Verify with:
```
cd services/discord-gateway
scripts/dev-pg.sh start            # local PostgreSQL 18 on :5433, db gmw_mod
bun test tests/                   # 37 unit + state-machine tests
bun tests/pipeline-e2e.mjs        # 15 end-to-end checks
node tests/claim-concurrency.mjs  # 12 concurrency invariants
bun typecheck && bun lint
```

## The headline

| | before | after |
|---|---|---|
| module | 56 files, 11,248 LOC | 5 files, 1,269 LOC |
| config vars | 42 `AI_*` | 7 `AI_ANALYSIS_*` + 3 `AI_LLM_*` |
| queue | `Map` + timers + lanes + locks + breaker | one Postgres column |
| worker pools | 7 pg Pools (one per Piscina thread) | 1 |
| on restart | in-flight work lost forever | leases expire, work resumes |
| duplicate verdicts | possible | structurally impossible |
| claim on a 300k-row backlog | — | 3.7 ms, `Index Scan using idx_messages_claim`, 4 buffers |

Deleted outright: the batch scheduler, the text/media lanes, the conversation
lock, the cooldown maps, the global circuit breaker, the individual-fallback
processor, the parse-repair loop, the exact-hash cache, the culture and profile
learners, TinyFish/Wikipedia enrichment, and the gateway-side auto-delete path.

## Files

- `drizzle/migrations/0020_moderation_state_machine.sql` — the queue. Adds
  `messages.ai_status`, `lease_until`, `attempts`, `ready_for_work_at`,
  `worker_id`; creates `verdicts` and `analysis_attempts`; defines
  `claim_messages()`, `reclaim_expired_claims()`, and a deferred constraint
  trigger making `analyzed ⇒ verdict exists` unrepresentable otherwise.
- `src/modules/ai-moderation/worker.ts` — claim → prompt → LLM → verdict, in one
  transaction, with backoff and a `dead` terminal state.
- `src/modules/ai-moderation/verdictParser.ts` — per-message defects degrade one
  message; only an unparseable response fails the batch.
- `src/modules/ai-moderation/policy.ts` — the rules, few-shot examples, and the
  machine-checked output contract, in one place.
- `src/modules/ai-moderation/llmGateway.ts` — the only code that talks to the
  model.
- `src/moderation-worker.ts` — the worker as its own process.
- `scripts/dev-pg.sh` — throwaway Postgres so this is verifiable, not asserted.

## The gateway no longer knows moderation exists

`messageCapture.ts` no longer calls anything in the moderation module. A captured
message is `pending` by column default, and the worker claims it on its next
poll. That is the whole integration. Consequences worth stating plainly:

- Restarting the gateway cannot strand analysis work, because it holds none.
- `shutdown.ts` has nothing to tear down; there are no Piscina threads to leak.
- `metrics-collector.ts` now reports queue depth by `GROUP BY` over the table
  rather than reading this process's memory, so the numbers stay correct when
  the gateway is down and several workers are running.

## Bugs the rewrite fixed, each verified

- **Messages stuck in `processing` forever.** v1 claimed a whole conversation
  then filtered it to one lane, so the other lane's messages stopped being
  `pending` and no timer could ever see them. The queue is now a column, so
  there is nothing to strand.
- **One deferral sentence cost ~120×.** `moderationResponseParser.ts` threw on
  any message whose analysis contained "perlu ditinjau", discarding 59 valid
  verdicts, triggering 4 full re-requests, then routing all 60 messages into
  individual fallback. Now only that one message is affected — 1 call, 59
  siblings intact.
- **A routine Postgres restart killed the process.** There was no
  `pool.on("error")` anywhere, so an idle client dropped by the server became an
  unhandled `error` event and Node exited. `pool.ts` now attaches the handler and
  sets `idleTimeoutMillis`.
- **The circuit breaker could never fire.** `conversationState.ts` reset the
  counter to 0 the instant it hit the threshold.
- **The lane split bought nothing.** Two timers armed with the same delay, and
  the `SKIP LOCKED` claim was lane-agnostic. Deleted along with the concept.
- **A lease shorter than the LLM timeout would double-process.** Now rejected at
  boot by config validation *and* at worker construction.

## Bugs I introduced and caught

Recorded because the tests that caught them are the reason to trust the rest.

1. `attempts = attempts + 1` in the failure path, while `claim_messages()`
   already increments it — every retry double-charged and halved the budget.
2. Four invented columns (`author_name`, `model_attempt`, `judged_at`, and a
   `failed` state that is actually `dead`). Postgres rejected each immediately.
3. `sanitizeAiContent` wraps text in `<![CDATA[…]]>`. Correct for bodies, wrong
   for the `id` attribute — it destroyed the tag the model must echo back, so
   nothing parsed at all.
4. The migration added its CHECK constraint *before* the backfill, so existing
   rows violated it and the migration aborted.
5. A concurrency test that asserted `0 === 0` because it read leftovers from a
   drained queue — a test that could not fail.
6. A blanket `v2 → "the new"` rename turned index names into
   `idx_messages_the new_lease`, which is not a legal identifier.
8. **The compiled worker crashed on boot, and no source-level test could have
   found it.** `runMigrations()` opens a pool, migrates, then CLOSES it before
   returning, so the worker's `getPool()` threw "Database not initialized".
   Only `node dist/moderation-worker.js` — real compiled output, real migrator,
   real DB — exposed it.
9. **Migration 0020 was never registered in the Drizzle journal.** Drizzle drives
   `__drizzle_migrations` from `meta/_journal.json`; a hand-written `.sql` file
   that is not in the journal is simply ignored, so production would have booted
   against a schema with no `ai_status` column at all. Now journal-registered
   and proven through the real `migrateCli`, including idempotency.
10. **The new process had no way to start in production.** `flake.nix` only
   installed a wrapper for `dist/index.js`; `dist/moderation-worker.js` was built
   but unlaunchable. Added the `gmw-discord-gateway-worker` wrapper.
11. **The reconciler stamped 0020 applied without running it.**
   `seedDrizzleHistory` decides "is the schema at the latest migration" by
   testing `moderation_actions.server_nick` — a column added at 0019 that every
   production database has. So the sentinel reported "at latest" and INSERTed a
   `<tag>@<when>-reconciled` marker into `__drizzle_migrations` for 0020. The
   gateway booted green, logged "migrations completed successfully", and
   `verdicts` / `analysis_attempts` / `lease_until` / `claim_messages()` did not
   exist. `messages.ai_status` *looked* present only because v1 had an unrelated
   column of that name, which is what made this hard to see. Fixed by testing
   0020's own objects and by deleting stale `%-reconciled` markers whose objects
   are absent — Drizzle never retries a migration it believes it already ran.
12. **The worker had no systemd unit.** The units live on the VPS, not in the
   repo, so deploying the code produced a built process that nothing started and
   moderation silently did nothing. Created
   `gmw-discord-gateway-worker.service` mirroring the gateway unit's sandbox.
7. The first e2e run reported 4 failures that were my assertions being wrong,
   not the code: two `runOnce()` calls drain the queue, so nothing stays
   `pending`. The expectations were corrected; the behaviour was right.

## The schema contract, learned the hard way

- `messages.username`, NOT `author_name`.
- `verdicts.model` (and `updated_at`), NOT `model_attempt` / `judged_at`.
- `verdicts.evidence` is `jsonb` → needs `JSON.stringify(...)` and `$n::jsonb`.
- `analysis_attempts` outcome vocabulary is fixed by a CHECK:
  `success | llm_error | parse_error | abandoned | duplicate`.
- The terminal state is `dead`, not `failed`.
- `attempts` is incremented **inside `claim_messages()`**; the worker must not
  increment it again on failure.
- `created_at` / `ready_for_work_at` / `attempts` are **bigint**, so
  `.toISOString()` does not exist on them, and comparisons need an explicit
  `::text AS alias` (a bare `col::text` keeps the original name, so pg still
  applies the int8 parser and hands back a number).
- Media detection reads the `attachments` table. v1 called
  `hasMediaContent(message)` with no attachments, so the media lane never fired.
- The migration must backfill **before** adding the CHECK constraint.

## The 48,290 "unjudged" messages

After the split, every message the old pipeline had judged showed as
**unjudged** in the dashboard. Not a display bug — migration 0020 set
`ai_status = 'analyzed'` and moved the judgement to the new `verdicts` table,
but never copied the judgement itself. 48,290 of 49,186 messages ended up
`analyzed` with no verdict row, while every field needed to rebuild one was
still sitting untouched in the legacy `messages.ai_*` columns.

Migration `0021_backfill_legacy_verdicts.sql` copies those columns into
`verdicts`. Only two things are synthesised, both marked: `status`, because the
old pipeline recorded severity + recommended_action but no outcome column
(`delete`/`escalate` → flagged, `warn`/`review` → warn, else clean), and
`model = 'legacy'` so reconstructed history is never confused with live worker
output. Everything else is copied verbatim, asserted field-by-field.

`error` is deliberately **not** synthesised: the old pipeline recorded
failures as analysis text with severity `none`, indistinguishable from a clean
verdict, so claiming otherwise would invent data.

Then the backfill shipped as a no-op. The reconciler's `schemaAtLatest` sentinel
tested only 0020's objects, so on a database where 0020 had run but 0021's data
backfill had not, it reported "at latest" — and then **stamped 0021 as applied
without running it**. Drizzle only applies migrations newer than the tracked
max, so 0021 was skipped permanently. The same class of bug the sentinel was
written to prevent, one migration later, and it was silent: the migration
recorded as applied, the rows never appeared.

Three defects, all in `migrate.ts`:

- The sentinel tested the wrong migration. It now also asserts 0021's own
  effect — no judged message missing its verdict — which is precisely what the
  data backfill delivers, and is vacuously true where there is nothing to
  judge.
- The rollback only removed `LIKE '%-reconciled'` rows, i.e. markers it had
  written itself. A plain hash row left by a failed apply looks legitimately
  applied and is skipped forever. It now removes the row outright.
- Having removed the marker it `return`ed, so Drizzle still never ran. The log
  line claimed Drizzle "will now apply it" while guaranteeing it would not.

`tests/reconcile-data-only-migration.mjs` builds that exact poisoned state
(tracking table says 0021 ran, no verdict rows) and drives the real reconciler
and the real migrator over it. `tests/drizzle-skip-behaviour.mjs` proves the
mechanism underneath: Drizzle skips a tracked migration, and applies it once
the row is gone.

Two things only rehearsal caught:

- **`ai_analysis_duration_ms` has no migration behind it.** It exists in
  production as an unmanaged leftover, so referencing it made 0021 fail
  outright on any database built from scratch — while passing happily against
  a copy of production. Duration is left NULL. Run the *real* migrator against
  a clean DB, not just a replica.
- **The journal entry did not land.** An earlier attempt to append 0021 to
  `meta/_journal.json` reported success but never wrote, so Drizzle saw 20
  files and silently skipped the migration. Verify the entry is on disk and
  that `readMigrationFiles` sees the new `folderMillis`.

## Auto-delete was dead for the whole rewrite

The rewrite deleted 894 lines of enforcement — `autoDeleteManager.ts` (562),
`autoDeleteEligibility.ts` (271), `autoDeleteLogger.ts` (61),
`autoDeleteNotify.ts` (50) — and left the config, the `msg.delete()` call and
the `MANAGE_MESSAGES` check behind with nothing calling them. Nothing broke;
nothing logged. `messages.deleted_at` simply stopped moving, and every flagged
message stayed standing in Discord.

The old manager ran inside the AI pipeline. The rewrite made the worker a
separate process with a database pool and no Discord client, so there was no
longer anywhere for a delete to happen. The enforcement modules were ported
back with the judgement input changed from `messages.ai_status` to the
`verdicts` row, and the decision moved to the gateway, which is where the
client lives.

**The poll, and why not an event.** The worker does not publish to Redis, and
adding that would re-couple the two processes the split was meant to separate.
So the gateway polls `verdicts` every 5s. The dependency direction is
unchanged: the gateway reads what the worker wrote, and neither waits on the
other.

**A sentinel, not a timestamp.** Re-reading recent rows by `created_at` would
re-delete after every restart and require guessing a lookback window. Instead
`0022` adds `verdicts.auto_delete_state` (NULL → pending → claimed → done /
failed). Claiming stamps `claimed` in the same UPDATE that selects the row,
with `FOR UPDATE SKIP LOCKED`, so two gateways cannot both act on one message
and a crash mid-batch is recovered by re-queueing claims older than 60s.

A real bug surfaced while porting: the "high/critical severity is always a
delete" rule was written as `status === 'flagged' && severity in (high,
critical)`, which left a `warn` verdict at high severity keeping the model's
conservative `recommended_action: "review"` and so never being deleted. The
guard belongs on severity alone.

## Backend and frontend read the new data

Both services still spoke the pre-rewrite vocabulary. Nothing errored — every
query returned zero rows, so the dashboard reported a clean, quiet guild while
the worker was actively flagging messages. Three separate causes:

1. **`messages.ai_status` no longer holds a judgement.** It is pipeline
   position (`pending`/`claimed`/`analyzed`/`retry_wait`/`dead`) and the worker
   only ever writes `analyzed` to it. `ai_status = 'flagged'` matched nothing —
   18 such filters across six dashboard queries, plus the review queue and the
   chatbot's "top flagged" tool. The outcome is `verdicts.status`.
2. **`ai_analysis_runs` and `moderation_actions` are dead tables.** The first
   was written by the old in-process pipeline (coverage read 0% forever); the
   second was the gateway's auto-delete log, frozen the moment enforcement moved
   to the backend. Coverage now reads `analysis_attempts`, which is append-only
   and records failures too.
3. **The frontend decided colour from `ai_status` alone.** `aiTone()` tested
   for `"clean"`/`"warn"`/`"flagged"`, so every analysed message rendered
   neutral grey. It now takes the verdict first, falling back to pipeline state.

The backend declares `verdicts` and `analysis_attempts` read-only and joins them
with a **LEFT** join — an inner join would drop the ~48k messages that have no
verdict, which is most of the table. `findById` also returns
`analysis_attempts`, because a message that never got a verdict has no row in
`verdicts` at all and was otherwise undebuggable from the UI.

Three tests assert this against production, because the failure mode is silent:
`verdict-queries-live.mjs` and `dashboard-verdict-live.mjs` (SQL) and
`be-verdict-service-live.mjs` (the real repository/service layer, 28 checks).

## Following one message through the pipeline

The audit that produced the trace module: over 12 minutes of production
running, the worker emitted **one** log line, and it was a failure. There was
no way to ask "where is this message?" or "how long did it take?".

Every stage now logs the same `trace` id (the last 12 characters of the
message id), so one grep returns a message's whole life in order:

```
scripts/trace-message.sh                    # current activity
scripts/trace-message.sh <message-id>        # one message, all stages
scripts/trace-message.sh <message-id> --wide # + raw model request/response
```

Real output:

```
claimed        tr-1        5.0s                     <- sat in queue 5s
claimed-batch  tr-1        count=3
llm            tr-1        1ms model=stub-model     <- model call
parsed         tr-1        ok=3 errored=0 missing=0
verdict        tr-1        5.0s status=clean attempts=1 score=0.01
cycle          tr-1        16ms count=3
```

Stages: `captured` (gateway) → `claimed` → `llm` → `parsed` → `verdict`,
with `requeued` / `dead` for the unhappy paths. `waitHuman` is queue latency,
`durationHuman` is the model call, `elapsedHuman` is capture-to-verdict, and
`cycleHuman` is total wall time for the batch. Per-message lines are `debug`
(the default production level hides them); batch lines are `info` so a normal
log still shows throughput. `LOG_LEVEL=debug` turns on the raw model
request/response, which is the only way to diagnose a parse failure.

`tests/trace-e2e.mjs` asserts the trace is actually *followable* — every stage
present, in order, and timed — rather than merely present. 28 checks.

### Bugs the tracing itself exposed

- **`attempts` was always logged as 0.** The claim read `m.attempts` from a
  re-join of `messages` inside the same statement, which sees the pre-UPDATE
  snapshot — so it was always one behind the increment `claim_messages()`
  performs. Now read from the function's own `RETURNING` row. This also meant
  the `analysis_attempts` log recorded attempt 1 for every retry. Two unit
  tests now pin the counter advancing 1, 2, 3.
- **`ClaimedMessage.createdAt` was typed `Date`.** `messages.created_at` is a
  bigint and node-postgres returns bigint as a *string*, so the type was simply
  false.
- **`analysis_attempts.attempt` was hardcoded to `1`.**

## Still open

- **The backend executes no commands.** `publishCommandNoReply` is imported once
  and never called, and all three gateway command handlers are unreachable. The
  design intends the backend to perform delete/DM; that path has to be *built*,
  and it needs an official bot token — a selfbot cannot act on other users'
  messages.
- **Channel culture is not implemented.** The worker DOES include surrounding
  conversation (`includeContext`, 10 messages) — verified: a 5-message batch
  sent 9 message tags to the model. What is gone is the *learned* culture
  summary the old cultureLearner produced; `policy.ts` leaves a slot for it.
- **Media is described, not analysed end to end.** The worker selects the media
  prompt from the `attachments` table (the v1 lane bug is fixed), but the vision
  call that produces the description is gone. Messages with attachments are
  judged on their text plus whatever description is present.
- **Backend/frontend contracts** still speak the old status vocabulary in places;
  neither service was touched in this pass.

