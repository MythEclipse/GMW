-- Add a terminal 'skipped' state to the moderation queue.
--
-- WHY
-- The queue could not say "we are never going to analyse this". A skip could
-- only be expressed as "release the claim and put the row back", which is what
-- the NSFW path does (ai_status='pending' + a 5-minute backoff). That is a
-- poll, not a skip:
--   - the row is re-claimed ~12x an hour for the lifetime of the message;
--   - `attempts` climbs without bound, so a skipped message can reach the
--     attempt cap and be parked `dead` while never having been analysed;
--   - `moderation_queue_pending` / backlog never drain, so a deliberately
--     exempt channel looks exactly like a stuck pipeline;
--   - if the condition is later removed, the row arrives already carrying a
--     nonsense attempt count.
--
-- The alternative to polling was dropping the channel at capture time, which
-- is where EXCLUDED_CHANNEL_IDS already does it. That hides the channel from
-- the dashboard entirely — and the channels that need skipping are exactly the
-- ones an operator most wants to see (a bot-dedicated channel, where the
-- traffic is command output rather than conversation).
--
-- So the message is still captured and still visible; it is only never judged.
-- `skipped` is terminal: no verdict (there is no judgement to make), no retry
-- budget consumed, never re-claimed.
--
-- `MessageState` in worker.ts already declared `| "skipped"` while nothing
-- ever wrote it, and `claim_messages()` already carried an unused
-- `p_excluded_channel_ids` parameter for this same idea. The state machine
-- simply never got the state.
--
-- Idempotent: the ADD CONSTRAINT guard is on the constraint name, and the
-- widening is a no-op where 'skipped' is already accepted.

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_ai_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_ai_status_check
  CHECK (ai_status IN
    ('pending','claimed','analyzed','retry_wait','dead','skipped'));
