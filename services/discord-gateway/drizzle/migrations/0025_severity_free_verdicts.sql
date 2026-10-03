-- Reduce a verdict to a decision: drop severity and recommended_action.
--
-- WHY
-- Three fields encoded one judgement and disagreed with each other. `status`
-- said warn/flagged, `severity` said how bad, and `recommended_action` said
-- what to do — and the model filled all three independently, routinely
-- emitting `status: "flagged"` with `recommended_action: "review"`. The
-- auto-delete gate then had to arbitrate: a severity override existed
-- specifically because `recommended_action` was too conservative to delete
-- genuinely severe content, and 73 verdicts ended up parked in
-- `action = 'review'`, which nothing ever acted on. A message the pipeline
-- called handled stayed up in Discord.
--
-- The operator decided the pipeline is full-auto: a message either violates
-- the policy and is removed, or it does not and stays. There is no review tier.
-- So `status` narrows to clean/deleted and becomes the only decision, the two
-- fields that duplicated it are gone, and `reason` replaces them as the record
-- of WHY a message was removed — a deletion nobody can audit or appeal is not
-- one worth automating.
--
-- `error` is kept as a third `status` value. It is not a middle tier: it means
-- the model could not read the message at all, which is a different fact from
-- "no violation" and must never authorise a deletion.
--
-- THE DATA
-- The dropped columns are not folded into `reason` because there is no honest
-- mapping: `severity` graded seriousness while `reason` states cause. Old rows
-- keep a NULL reason, and the dashboard reads the existing `analysis` text for
-- those, which is where the explanation already lived. Old verdicts that were
-- 'warn' or 'flagged' are rewritten to 'clean', because under the new contract
-- "flagged but nobody acted on it" is exactly the bug being fixed — leaving
-- them deletion-shaped would retroactively authorise deleting every one of them
-- on the next enforcer pass.
--
-- Idempotent: every statement checks for existence first, so re-running against
-- a database that already has this shape is a no-op.

-- ─── 1. verdicts: reason replaces the two decision-duplicating columns ──────
ALTER TABLE verdicts
  ADD COLUMN IF NOT EXISTS reason text;

-- The old middle tiers become 'clean' — they were violations the pipeline
-- declined to act on, and keeping them deletion-shaped would turn this
-- migration into a mass-delete authorisation.
UPDATE verdicts
   SET status = 'clean'
 WHERE status IN ('warn', 'flagged');

-- Narrow the constraint to the two real answers. Dropped and recreated because
-- the old CHECK names values that no longer exist.
ALTER TABLE verdicts DROP CONSTRAINT IF EXISTS verdicts_status_check;
ALTER TABLE verdicts DROP CONSTRAINT IF EXISTS verdicts_severity_check;
ALTER TABLE verdicts DROP CONSTRAINT IF EXISTS verdicts_action_check;

ALTER TABLE verdicts
  ADD CONSTRAINT verdicts_status_check
    CHECK (status IN ('clean','deleted','error'));

ALTER TABLE verdicts
  DROP COLUMN IF EXISTS severity,
  DROP COLUMN IF EXISTS recommended_action;

-- 'reason' is required for a deletion and irrelevant otherwise, so the check
-- encodes the decision instead of trusting the writer to pair them correctly.
-- Dropped first: `ADD CONSTRAINT` has no IF NOT EXISTS form, so without this a
-- re-run fails on the name rather than being a no-op.
ALTER TABLE verdicts DROP CONSTRAINT IF EXISTS verdicts_reason_check;
ALTER TABLE verdicts
  ADD CONSTRAINT verdicts_reason_check
    CHECK (status <> 'deleted' OR (reason IS NOT NULL AND reason <> ''));

-- The old partial index keyed on recommended_action, which no longer exists.
DROP INDEX IF EXISTS idx_verdicts_actionable;

-- The enforcer's candidate index: only deletions are candidates now, so its
-- predicate narrows from (warn, flagged) to (deleted). Without this the
-- enforcer would re-read every clean verdict on every tick.
DROP INDEX IF EXISTS idx_verdicts_auto_delete_pending;
CREATE INDEX IF NOT EXISTS idx_verdicts_auto_delete_pending
  ON verdicts (created_at)
  WHERE auto_delete_state IS NULL
    AND status = 'deleted';

-- idx_verdicts_status_created covers all three status values and is unchanged.

-- ─── 2. messages: the legacy ai_* columns, kept only for the backfill ──────
--
-- 0021 read these to reconstruct verdicts. That backfill is done, so they are
-- dropped rather than left as a second, contradicting source of truth. Dropping
-- them is also what makes any future writer of severity fail loudly at the
-- type level instead of silently filling a column nothing reads.
ALTER TABLE messages
  DROP COLUMN IF EXISTS ai_severity,
  DROP COLUMN IF EXISTS ai_recommended_action;

-- ─── 3. moderation_actions: the audit column nothing populates now ─────────
ALTER TABLE moderation_actions
  DROP COLUMN IF EXISTS severity;
