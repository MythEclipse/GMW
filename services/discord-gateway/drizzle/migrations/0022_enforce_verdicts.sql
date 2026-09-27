-- Add the auto-delete enforcement marker to `verdicts`.
--
-- WHY
-- The rewrite (2658b0dd) deleted 894 lines of auto-delete enforcement
-- (autoDeleteManager, autoDeleteEligibility, autoDeleteLogger,
-- autoDeleteNotify) and left the config, the `msg.delete()` call and the
-- MANAGE_MESSAGES check behind with nothing calling them. Auto-delete has
-- therefore deleted nothing since: `messages.deleted_at` has not moved, and
-- every flagged message is still standing in Discord.
--
-- The revived enforcer polls the `verdicts` table, so it needs somewhere to
-- record "I already looked at this one". Without a marker it would re-delete
-- on every tick and after every restart, and would have to guess how far back
-- to scan by timestamp.
--
-- `auto_delete_state`:
--   NULL    - never considered
--   pending - considered, but the condition may change (channel not in cache
--             yet, guild not resolved). Retried.
--   claimed - a gateway process is acting on it right now. Set and cleared by
--             the same UPDATE that selects the row, with FOR UPDATE SKIP
--             LOCKED, so two processes cannot both act on one message.
--   done    - acted on, or judged not eligible. Terminal; never re-read.
--   failed  - the delete threw. Terminal for this message so a permanently
--             failing message cannot spin the loop forever; the failure is
--             already in moderation_actions with status='failed'.
ALTER TABLE verdicts
  ADD COLUMN IF NOT EXISTS auto_delete_state text
    DEFAULT NULL
    CHECK (auto_delete_state IN ('pending', 'claimed', 'done', 'failed'));

ALTER TABLE verdicts
  ADD COLUMN IF NOT EXISTS auto_delete_claimed_at bigint;

-- The enforcer's hot query: undecided flagged/warn verdicts whose message is
-- still present, oldest first.
CREATE INDEX IF NOT EXISTS idx_verdicts_auto_delete_pending
  ON verdicts (created_at)
  WHERE auto_delete_state IS NULL
    AND status IN ('flagged', 'warn');
