-- Backfill `verdicts` from the legacy `messages.ai_*` columns.
--
-- WHY THIS IS NEEDED
-- Migration 0020 split one column into two: `messages.ai_status` became
-- pipeline position (pending/claimed/analyzed/retry_wait/dead) and the
-- judgement moved to the new `verdicts` table. The migration set
-- ai_status = 'analyzed' for every row the old pipeline had judged, but
-- never copied the judgement itself. So 48,290 messages ended up
-- `analyzed` with no verdict — displayed as "unjudged" — even though
-- every field needed to reconstruct it was still sitting in the legacy
-- columns the migration left in place.
--
-- Nothing is inferred here. Each field is copied from the column the old
-- pipeline wrote it to. Only the two things that genuinely do not exist
-- per-message are synthesised, and both are marked so they are never
-- mistaken for model output:
--
--   status  — the old pipeline stored no verdict outcome column, only
--             severity + recommended_action. The mapping below is derived
--             from what those two actually meant, not from a default.
--   model   — not recorded per message; marked 'legacy' so the dashboard
--             can tell reconstructed history from live worker output.
--
-- Idempotent: ON CONFLICT DO NOTHING, so re-running never overwrites a
-- verdict the live worker has since written.
--
-- Only rows the OLD pipeline judged (ai_analysis IS NOT NULL) and that do
-- not already have a verdict. Messages still queued, or judged by the new
-- worker, are untouched.

INSERT INTO verdicts (
  message_id,
  status,
  flags,
  categories,
  severity,
  confidence,
  score,
  recommended_action,
  analysis,
  evidence,
  policy_version,
  model,
  duration_ms,
  created_at,
  updated_at
)
SELECT
  m.id,

  -- The old pipeline had no explicit verdict column. Its severity and
  -- recommended_action together determined the outcome:
  --   delete / escalate -> acted on or escalated  -> 'flagged'
  --   warn / review     -> surfaced to a human     -> 'warn'
  --   nothing actionable                         -> 'clean'
  -- 'error' is deliberately NOT synthesised: the old pipeline recorded
  -- failures as analysis text with severity 'none', which is
  -- indistinguishable from a clean verdict, so claiming otherwise would
  -- invent data. Those rows come through as 'clean' with their real
  -- severity and action intact.
  CASE
    WHEN m.ai_recommended_action IN ('delete', 'escalate') THEN 'flagged'
    WHEN m.ai_recommended_action IN ('warn', 'review')    THEN 'warn'
    ELSE 'clean'
  END,

  -- Stored as a JSON string by the old pipeline; the real column is text[].
  COALESCE(
    (SELECT array_agg(x)
       FROM jsonb_array_elements_text(
              COALESCE(NULLIF(m.ai_moderation_flags, ''), '[]')::jsonb
            ) AS x),
    '{}'
  ),

  COALESCE(
    (SELECT array_agg(x)
       FROM jsonb_array_elements_text(
              COALESCE(NULLIF(m.ai_categories, ''), '[]')::jsonb
            ) AS x),
    '{}'
  ),

  COALESCE(m.ai_severity, 'none'),
  COALESCE(m.ai_confidence, 0),
  m.ai_moderation_score,
  COALESCE(m.ai_recommended_action, 'none'),
  COALESCE(m.ai_analysis, ''),

  -- The old pipeline stored no structured evidence.
  '[]'::jsonb,

  -- No policy version was recorded per message.
  NULL,

  -- Marks this row as reconstructed, not live worker output. The FE badge
  -- and the coverage metric both key off this.
  'legacy',

  -- `ai_analysis_duration_ms` is deliberately NOT read here. It exists in
  -- production but no migration in 0000-0020 ever creates it, so a reference
  -- to it makes this migration fail outright on any database built from
  -- scratch — caught by running the real migrator against a clean DB, after
  -- the same SQL had passed happily against the production replica. Legacy
  -- duration is left NULL rather than guessed at.
  NULL,

  -- The old pipeline stamped ai_analyzed_at when it finished. Fall back to
  -- the message timestamp so created_at is never 0.
  COALESCE(m.ai_analyzed_at, m.created_at, 0),
  COALESCE(m.ai_analyzed_at, m.created_at, 0)

FROM messages m
WHERE m.ai_analysis IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM verdicts v WHERE v.message_id = m.id)
ON CONFLICT (message_id) DO NOTHING;
