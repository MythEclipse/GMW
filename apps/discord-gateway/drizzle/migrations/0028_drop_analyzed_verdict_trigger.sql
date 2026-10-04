-- =============================================================================
-- 0028_drop_analyzed_verdict_trigger.sql
--
-- WHY
--   `messages_analyzed_has_verdict` was a DEFERRABLE INITIALLY DEFERRED
--   constraint trigger asserting that a message in `analyzed` always has a
--   matching verdicts row. It was the last line of defence for the invariant
--   that makes the moderation queue trustworthy: without it, a row can sit in
--   `analyzed` forever with nothing ever having judged it, and the only way to
--   notice was a human reading a dashboard.
--
--   It is removed as part of the Drizzle -> Prisma migration. Prisma has no
--   representation for triggers, so keeping it would mean permanently carrying
--   a hand-written SQL object no part of the schema describes — exactly the
--   class of drift this migration exists to eliminate.
--
--   The invariant is NOT dropped. It is now asserted in the worker, inside the
--   same transaction that writes the verdict and flips ai_status, so a
--   violation aborts the transaction instead of leaving a half-written row.
--   The trade-off is explicit: this was enforced by the database against ANY
--   writer and is now enforced against the worker only. A direct SQL writer
--   outside the worker would no longer be caught here.
-- =============================================================================

DROP TRIGGER IF EXISTS messages_analyzed_has_verdict ON messages;

DROP FUNCTION IF EXISTS assert_analyzed_has_verdict();

-- To undo, recreate both objects exactly as 0020 defined them:
--
-- CREATE OR REPLACE FUNCTION assert_analyzed_has_verdict()
-- RETURNS trigger AS $$
-- DECLARE n integer;
-- BEGIN
--   IF NEW.ai_status = 'analyzed' THEN
--     SELECT count(*) INTO n FROM verdicts WHERE message_id = NEW.id;
--     IF n = 0 THEN
--       RAISE EXCEPTION
--         'message % marked analyzed but no verdict row exists', NEW.id
--         USING ERRCODE = 'check_violation';
--     END IF;
--   END IF;
--   RETURN NULL;
-- END;
-- $$ LANGUAGE plpgsql;
--
-- CREATE CONSTRAINT TRIGGER messages_analyzed_has_verdict
--   AFTER INSERT OR UPDATE OF ai_status ON messages
--   DEFERRABLE INITIALLY DEFERRED
--   FOR EACH ROW EXECUTE FUNCTION assert_analyzed_has_verdict();