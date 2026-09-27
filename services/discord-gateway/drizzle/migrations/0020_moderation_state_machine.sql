-- =============================================================================
-- 0020_moderation_state_machine.sql
--
-- Replaces the in-memory coordination layer with a durable state machine.
--
-- WHY THIS EXISTS
--   The the old pipeline kept scheduling state in process RAM: debounce timers,
--   per-conversation lane locks, circuit-breaker counters, cooldowns, and an
--   in-flight marker map. Every one of those died on restart, and the recovery
--   worker could only re-derive state by sweeping rows older than
--   AI_ANALYSIS_PROCESSING_TIMEOUT_MS (120s). That is the "stuck message" bug:
--   a claim that can strand rows plus a scheduler whose truth is volatile.
--
--   These columns make the scheduler a QUERY. `pending` is no longer a schedule,
--   it is a predicate. A lease is a timestamp, so a crashed worker's work becomes
--   claimable again the moment the lease expires -- no sweeper, no 120s wait.
--
-- COMPATIBILITY
--   ai_status is RETAINED and kept in sync during the dual-write window so the
--   old pipeline and the new worker can run side by side. `owner` scopes the two
--   so a row is only ever claimed by the pipeline that owns it. Drop both
--   columns in the cutover migration.
-- =============================================================================

-- ─── 1. messages: the durable work queue ─────────────────────────────────────

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS ai_status   text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS lease_until    bigint,
  ADD COLUMN IF NOT EXISTS attempts       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ready_for_work_at bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS worker_id      text,
  ADD COLUMN IF NOT EXISTS last_error     text,
  ADD COLUMN IF NOT EXISTS owner          text NOT NULL DEFAULT 'worker',
  ADD COLUMN IF NOT EXISTS content_hash   text,
  ADD COLUMN IF NOT EXISTS context_key    text;

-- Backfill FIRST, constrain second.
--
-- The new column defaults to 'pending', so pre-existing rows still carry their
-- old v1 status ('clean', 'processing', …) at this point. Adding the CHECK
-- before the backfill therefore fails immediately: the column is declared
-- NOT NULL DEFAULT 'pending', but the UPDATE that rewrites old values has not
-- run yet and the CHECK is validated against every existing row.
--
-- Order matters: rewrite the values, THEN constrain them.
UPDATE messages
   SET ai_status = CASE
         WHEN ai_status IN ('clean','warn','flagged') THEN 'analyzed'
         WHEN ai_status = 'error'                    THEN 'retry_wait'
         ELSE 'pending'
       END,
       attempts = 0;

-- Constrain the state machine at the database level. A CHECK is the last line
-- of defence: even a buggy worker cannot invent a state.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_ai_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_ai_status_check
  CHECK (ai_status IN ('pending','claimed','analyzed','retry_wait','dead'));

-- ready_for_work_at = 0 means "now" for pending rows (epoch is in the past).
UPDATE messages SET ready_for_work_at = 0 WHERE ai_status = 'pending';

-- ─── 2. Indexes that make the claim query fast ────────────────────────────────
--
-- The claim is the only hot query in the system:
--   WHERE status IN ('pending','retry_wait')
--     AND ready_for_work_at <= now() AND deleted_at IS NULL
--   ORDER BY created_at
-- A partial index keeps the index small (only the queue, not the archive) and
-- puts created_at in sort order, so the planner gets a sorted, pre-filtered
-- scan with no sort node. The predicate MUST match the claim's predicate
-- exactly, or Postgres cannot use it as an index scan for that query.
CREATE INDEX IF NOT EXISTS idx_messages_claim
  ON messages (created_at)
  WHERE ai_status IN ('pending', 'retry_wait') AND deleted_at IS NULL;

-- Lease reclamation: find rows whose owner died. Partial on 'claimed'.
CREATE INDEX IF NOT EXISTS idx_messages_lease
  ON messages (lease_until)
  WHERE ai_status = 'claimed';

-- Dashboard: "show me stuck/dead work" without scanning the archive.
CREATE INDEX IF NOT EXISTS idx_messages_status_created
  ON messages (ai_status, created_at DESC);

-- Conversation context lookup (the the old pattern, OR-ed over channel/thread).
CREATE INDEX IF NOT EXISTS idx_messages_channel_created
  ON messages (channel_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_messages_thread_created
  ON messages (thread_id, created_at DESC)
  WHERE thread_id IS NOT NULL AND deleted_at IS NULL;

-- Cache lookups: exact content+context, and the context-free variant.
CREATE INDEX IF NOT EXISTS idx_messages_cache
  ON messages (content_hash, context_key)
  WHERE content_hash IS NOT NULL;

-- ─── 3. verdicts: one row per judged message ──────────────────────────────────
--
-- the old stored 10 nullable verdict columns directly on `messages`. That made
-- "does this message have a verdict?" a question about nulls spread across ten
-- columns, and it meant a verdict could exist while the message was still
-- marked processing. A separate table makes the verdict a fact with its own
-- lifecycle, and leaves `messages` purely about queue state.
CREATE TABLE IF NOT EXISTS verdicts (
  message_id        text PRIMARY KEY
                    REFERENCES messages(id) ON DELETE CASCADE,
  status            text NOT NULL,
  flags             text[] NOT NULL DEFAULT '{}',
  categories        text[] NOT NULL DEFAULT '{}',
  severity          text NOT NULL DEFAULT 'none',
  confidence        double precision NOT NULL DEFAULT 0,
  score             double precision,
  recommended_action text NOT NULL DEFAULT 'none',
  analysis          text NOT NULL DEFAULT '',
  evidence          jsonb NOT NULL DEFAULT '[]'::jsonb,
  policy_version    text,
  model             text,
  duration_ms       integer,
  created_at        bigint NOT NULL DEFAULT (extract(epoch from now())*1000)::bigint,
  updated_at        bigint NOT NULL DEFAULT (extract(epoch from now())*1000)::bigint,
  CONSTRAINT verdicts_status_check
    CHECK (status IN ('clean','warn','flagged','error')),
  CONSTRAINT verdicts_severity_check
    CHECK (severity IN ('none','low','medium','high','critical')),
  CONSTRAINT verdicts_action_check
    CHECK (recommended_action IN
      ('none','monitor','warn','review','delete','escalate'))
);

-- How many messages are clean but the channel is generally toxic, etc.
CREATE INDEX IF NOT EXISTS idx_verdicts_status_created
  ON verdicts (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_verdicts_actionable
  ON verdicts (recommended_action, created_at DESC)
  WHERE recommended_action IN ('delete','escalate','review');

-- ─── 4. analysis_attempts: append-only audit of every try ────────────────────
--
-- the old had no record of why a message ended up where it did; the only trace was
-- a mutable `error` column. An append-only log makes "why is this dead?" and
-- "did we pay for this twice?" answerable.
CREATE TABLE IF NOT EXISTS analysis_attempts (
  id             bigserial PRIMARY KEY,
  message_id     text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  worker_id      text,
  attempt        integer NOT NULL,
  outcome        text NOT NULL,
  error_code     text,
  error_message  text,
  duration_ms    integer,
  model          text,
  prompt_tokens  integer,
  created_at     bigint NOT NULL DEFAULT (extract(epoch from now())*1000)::bigint,
  CONSTRAINT analysis_attempts_outcome_check
    CHECK (outcome IN ('success','llm_error','parse_error','abandoned','duplicate'))
);

CREATE INDEX IF NOT EXISTS idx_attempts_message
  ON analysis_attempts (message_id, attempt DESC);
CREATE INDEX IF NOT EXISTS idx_attempts_outcome_created
  ON analysis_attempts (outcome, created_at DESC);

-- ─── 5. Reclaim helper: the function the worker calls on every poll ───────────
--
-- Kept as SQL rather than application code so the claim is one atomic statement
-- with no read-then-write race. `p_lease_ms` is the worker's own timeout; passing
-- it as a parameter (rather than a constant) is what makes the "crashed worker"
-- path work: the reclaim sees the row as expired and takes it, atomically.
CREATE OR REPLACE FUNCTION claim_messages(
  p_worker_id    text,
  p_limit        integer DEFAULT 40,
  p_lease_ms     integer DEFAULT 90000
) RETURNS SETOF messages AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT id FROM messages
     WHERE ai_status IN ('pending', 'retry_wait')
       AND ready_for_work_at <= (extract(epoch from now())*1000)::bigint
       AND deleted_at IS NULL
     ORDER BY created_at
     FOR UPDATE SKIP LOCKED
     LIMIT p_limit
  )
  UPDATE messages m
     SET ai_status    = 'claimed',
         lease_until     = (extract(epoch from now())*1000)::bigint + p_lease_ms,
         attempts        = m.attempts + 1,
         worker_id       = p_worker_id
    FROM candidates c
   WHERE m.id = c.id
  RETURNING m.*;
END;
$$ LANGUAGE plpgsql;

-- Reclaim rows whose worker died mid-flight. Called by every worker on a slow
-- timer; safe to run concurrently from N replicas (rows are re-claimed, not lost).
CREATE OR REPLACE FUNCTION reclaim_expired_claims(
  p_limit integer DEFAULT 200
) RETURNS integer AS $$
DECLARE n integer;
BEGIN
  WITH expired AS (
    SELECT id FROM messages
     WHERE ai_status = 'claimed'
       AND lease_until IS NOT NULL
       AND lease_until < (extract(epoch from now())*1000)::bigint
     ORDER BY lease_until
     FOR UPDATE SKIP LOCKED
     LIMIT p_limit
  )
  UPDATE messages m
     SET ai_status = 'pending',
         lease_until  = NULL,
         worker_id    = NULL,
         last_error   = COALESCE(m.last_error, 'lease expired: worker died mid-flight')
    FROM expired e
   WHERE m.id = e.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

-- ─── 6. Completeness invariant: analyzed ⇒ a verdict row exists ──────────────
--
-- the old could leave a message in `processing` forever with no verdict, and the
-- only way to notice was a human reading a dashboard. This makes the broken
-- state unrepresentable.
--
-- DEFERRABLE + INITIALLY DEFERRED is required: the worker inserts the verdict
-- row and updates messages.status in ONE transaction, and the verdict row does
-- not exist yet at the moment the UPDATE runs. Deferring to COMMIT means the
-- check fires once both statements have landed.
CREATE OR REPLACE FUNCTION assert_analyzed_has_verdict()
RETURNS trigger AS $$
DECLARE n integer;
BEGIN
  IF NEW.ai_status = 'analyzed' THEN
    SELECT count(*) INTO n FROM verdicts WHERE message_id = NEW.id;
    IF n = 0 THEN
      RAISE EXCEPTION
        'message % marked analyzed but no verdict row exists', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;  -- AFTER trigger: return value ignored
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS messages_analyzed_has_verdict ON messages;
CREATE CONSTRAINT TRIGGER messages_analyzed_has_verdict
  AFTER INSERT OR UPDATE OF ai_status ON messages
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_analyzed_has_verdict();
