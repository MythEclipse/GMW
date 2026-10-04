-- Fixtures for the messages-repository comparison harness.
--
-- The point is the cases the JS-side reductions could get wrong:
--
--   * review-queue scores that TIE under floor(score*100) but differ as raw
--     floats (0.509 vs 0.501) — sorting on the raw column would order them the
--     other way round, so a wrong port looks correct on tidy data
--   * rows sharing (action, score, created_at) so only the `id` tiebreak keeps
--     the cursor total, meaning a duplicate or skipped row across pages is
--     detectable
--   * null score / null verdict, which the COALESCE(.., 0) mapped to rank 0
--   * two channels and several pages, so cursor paging is exercised properly
--   * messages with no verdict (LEFT JOIN semantics)
--
-- Run against a scratch database only.

BEGIN;

TRUNCATE message_edits, attachments, messages, verdicts RESTART IDENTITY CASCADE;

-- 40 messages across 2 channels, 2 guilds, with deliberately clashing scores
-- and timestamps.
INSERT INTO messages
  (id, guild_id, channel_id, user_id, username, content, metadata, ai_status, created_at, deleted_at)
SELECT
  'm' || lpad(i::text, 4, '0'),
  CASE WHEN i % 3 = 0 THEN 'g2' ELSE 'g1' END,
  CASE WHEN i % 2 = 0 THEN 'ch2' ELSE 'ch1' END,
  'u' || (((i - 1) % 5) + 1),
  'user' || (((i - 1) % 5) + 1),
  'message ' || i,
  jsonb_build_object('channel', jsonb_build_object('channelName', 'chan-' || (CASE WHEN i % 2 = 0 THEN 'ch2' ELSE 'ch1' END))),
  CASE
    WHEN i % 11 = 0 THEN 'dead'        -- review-worthy via ai_status
    WHEN i % 4 = 0  THEN 'analyzed'
    ELSE 'pending'
  END,
  -- Deliberately repeat timestamps so `id` is the only final tiebreak.
  (EXTRACT(EPOCH FROM now()) * 1000)::bigint - ((i / 4)::bigint * 1000),
  CASE WHEN i % 13 = 0 THEN (EXTRACT(EPOCH FROM now()) * 1000)::bigint ELSE NULL END
FROM generate_series(1, 40) AS i;

-- Verdicts for all but every 9th message (those stay unjudged).
INSERT INTO verdicts (message_id, status, flags, categories, confidence, score, evidence, reason, created_at, updated_at)
SELECT
  'm' || lpad(i::text, 4, '0'),
  -- 'deleted' (rank 2) and 'clean' (rank 1); a few 'error' land in rank 0.
  CASE WHEN i % 3 = 0 THEN 'clean' WHEN i % 6 = 0 THEN 'error' ELSE 'deleted' END,
  ARRAY['f'],
  ARRAY['c'],
  0.5,
  -- Scores chosen so that floor(score*100) ties while the raw floats differ,
  -- and so a null score has to be handled.
  CASE
    WHEN i % 7 = 0 THEN NULL
    WHEN i % 2 = 0 THEN 0.509
    ELSE 0.501
  END,
  '[]'::jsonb,
  CASE WHEN i % 3 <> 0 THEN 'karena-NC-gambling' ELSE NULL END,
  (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
  (EXTRACT(EPOCH FROM now()) * 1000)::bigint
FROM generate_series(1, 40) AS i
WHERE i % 9 <> 0;

-- 30 edits, several sharing an `edited_at` so the id tiebreak matters.
INSERT INTO message_edits (id, message_id, old_content, edited_at)
SELECT
  gen_random_uuid(),
  'm' || lpad((((i * 7) % 40) + 1)::text, 4, '0'),
  'old content ' || i,
  (EXTRACT(EPOCH FROM now()) * 1000)::bigint - ((i / 3)::bigint * 1000)
FROM generate_series(1, 30) AS i;

-- Attachments: image and non-image. `attachments.message_id` HAS a real
-- foreign key (unlike `moderation_actions.message_id`), so every row here must
-- reference an existing message.
INSERT INTO attachments
  (id, message_id, guild_id, channel_id, user_id, filename, size, type, discord_url, uploaded_url, upload_status, created_at)
SELECT
  gen_random_uuid(),
  'm' || lpad((((i * 2) % 40) + 1)::text, 4, '0'),
  'g1',
  CASE WHEN i % 2 = 0 THEN 'ch2' ELSE 'ch1' END,
  'u1',
  'file' || i,
  100 * i,
  CASE WHEN i % 3 = 0 THEN 'application/pdf' ELSE 'image/png' END,
  'https://cdn.example/' || i,
  NULL,
  'pending',
  (EXTRACT(EPOCH FROM now()) * 1000)::bigint - (i::bigint * 1000)
FROM generate_series(1, 20) AS i;

COMMIT;