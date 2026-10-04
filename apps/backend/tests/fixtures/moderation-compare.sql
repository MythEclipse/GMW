-- Fixtures for the Prisma-vs-SQL comparison harness.
--
-- Deliberately adversarial. The point is not to have "some data" but to have
-- the cases that broke, or could silently break, the JS ports:
--
--   * both `categories` storage shapes (JSON array and bare/CSV), including the
--     legacy rows that made a ::jsonb cast abort the whole query
--   * messages with NO verdict at all -> the `unjudged` bucket
--   * NULL categories / NULL evidence / NULL reason -> empty-string handling
--   * URLs appearing multiple times in one action -> DISTINCT-per-action
--   * metadata with a missing/blank channelName -> channel_id fallback
--   * hours spread across the full 0..23 range, incl. UTC-day-boundary hours
--   * BigInt epoch timestamps, including a message_id pointing at a DELETED
--     message so the manual LEFT JOIN must preserve the action
--
-- Run against a scratch database only.

BEGIN;

TRUNCATE messages, verdicts, moderation_actions, analysis_attempts RESTART IDENTITY CASCADE;

-- 60 messages spread over the last 30 days, all four ai_status values.
INSERT INTO messages (id, guild_id, channel_id, user_id, username, content, metadata, ai_status, created_at, deleted_at)
SELECT
  'm' || lpad(i::text, 4, '0'),
  'g1',
  'ch' || (((i - 1) % 6) + 1),
  'u' || (((i - 1) % 10) + 1),
  'user' || (((i - 1) % 10) + 1),
  CASE i % 4
    WHEN 0 THEN 'cek https://spam.example.com/a?id=1 dan https://spam.example.com/b juga'
    WHEN 1 THEN 'halo dunia'
    WHEN 2 THEN 'link http://scam.test/path?x=1 #frag'
    ELSE 'biasa saja'
  END,
  jsonb_build_object(
    'channel',
    CASE i % 3
      WHEN 0 THEN jsonb_build_object('channelName', 'Channel ' || (((i - 1) % 6) + 1))
      WHEN 1 THEN jsonb_build_object('channelName', '')   -- blank -> falls back to channel_id
      ELSE jsonb_build_object('other', 'x')                -- missing key
    END
  ),
  -- Messages 1-8 get no verdict at all, so they must NOT be 'analyzed':
  -- the `messages_analyzed_has_verdict` invariant (dropped by migration 0028)
  -- required a verdict for any analyzed row.
  CASE WHEN i <= 8 THEN 'pending'
       ELSE (ARRAY['pending','claimed','analyzed','retry_wait','dead','skipped'])[((i - 1) % 6) + 1]
  END,
  -- vary the hour so getHourlyModeration exercises all 24 buckets
  (EXTRACT(EPOCH FROM now()) * 1000)::bigint - (i::bigint * 12 * 3600 * 1000),
  CASE WHEN i % 10 = 0 THEN (EXTRACT(EPOCH FROM now()) * 1000)::bigint ELSE NULL END
FROM generate_series(1, 60) AS i;

-- Verdicts for all but 8 messages -> those 8 are the `unjudged` bucket.
INSERT INTO verdicts (message_id, status, flags, categories, confidence, score, evidence, reason, created_at, updated_at)
SELECT
  'm' || lpad(i::text, 4, '0'),
  (ARRAY['clean','deleted','error'])[((i - 1) % 3) + 1],
  ARRAY['f1'],
  ARRAY['gambling'],
  0.5,
  0.25,
  '[]'::jsonb,
  -- verdicts_reason_check requires a non-empty reason on 'deleted' verdicts.
  CASE WHEN ((i - 1) % 3) + 1 = 2 THEN 'kategori-NC-gambling' ELSE NULL END,
  (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
  (EXTRACT(EPOCH FROM now()) * 1000)::bigint
FROM generate_series(9, 60) AS i;

-- 40 moderation actions covering both category shapes + NULLs.
INSERT INTO moderation_actions
  (id, message_id, user_id, guild_id, action_type, reason, executed_by, status,
   created_at, categories, confidence, score, evidence, username)
SELECT
  'a' || lpad(i::text, 4, '0'),
  CASE WHEN i % 7 = 0 THEN 'm9999' ELSE 'm' || lpad(((i * 3) % 60 + 1)::text, 4, '0') END,  -- i%7 -> dangling FK
  'u' || (((i - 1) % 10) + 1),
  'g1',
  (ARRAY['delete_message','reset_nickname','delete_message','warn_user'])[((i - 1) % 4) + 1],
  CASE WHEN i % 5 = 0 THEN NULL ELSE 'pelanggaran aturan' END,
  'bot',
  (ARRAY['executed','pending','error'])[((i - 1) % 3) + 1],
  (EXTRACT(EPOCH FROM now()) * 1000)::bigint - (i::bigint * 6 * 3600 * 1000),
  CASE i % 7
    WHEN 0 THEN NULL                                   -- NULL -> no categories
    WHEN 1 THEN ''                                     -- empty -> no categories
    WHEN 2 THEN 'harassment'                            -- legacy bare
    WHEN 3 THEN 'inappropriate_content, spam'          -- legacy CSV
    WHEN 4 THEN '["gambling","scam"]'                   -- current JSON
    WHEN 5 THEN '["spam","spam"]'                       -- JSON with duplicates
    ELSE '{"not":"an array"}'                           -- adversarial
  END,
  0.75,
  0.5,
  CASE WHEN i % 4 = 0 THEN 'see https://evidence.example.org/x' ELSE NULL END,
  'user' || (((i - 1) % 10) + 1)
FROM generate_series(1, 40) AS i;

-- Give a few actions a duplicated URL so DISTINCT-per-action is exercised.
UPDATE moderation_actions SET evidence = 'https://dup.example.com/1 https://dup.example.com/2 https://dup.example.com/1'
WHERE id IN ('a0001','a0002','a0003');

INSERT INTO analysis_attempts (id, message_id, attempt, outcome, created_at)
SELECT
  i,   -- analysis_attempts.id is a bigint
  'm' || lpad(((i * 7) % 60 + 1)::text, 4, '0'),
  1,
  (ARRAY['success','duplicate','llm_error','parse_error','abandoned'])[((i - 1) % 5) + 1],
  (EXTRACT(EPOCH FROM now()) * 1000)::bigint - (i::bigint * 3600 * 1000)
FROM generate_series(1, 50) AS i;

COMMIT;