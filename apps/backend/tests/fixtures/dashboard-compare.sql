-- Fixtures for the dashboard Prisma-vs-SQL comparison harness.
--
-- Every row here exists to break a specific JS reduction. The ported methods
-- replace SQL GROUP BY / COUNT(DISTINCT) / FILTER with Map-and-Set loops, so
-- the fixtures have to include the cases where a naive loop disagrees with the
-- database:
--
--   * MULTIPLE groups per key. `listUsers` groups by (user_id, username,
--     avatar_url); a user who renamed or changed avatar must produce SEVERAL
--     rows, not one merged row. Same for channels by (channel_id, guild_id,
--     channelName) and reactors by (user_id, username).
--   * Net reactions that go NEGATIVE and net to exactly ZERO. Both must be
--     filtered out by `reaction_count > 0`; a `!= 0` filter would leak them.
--   * A message whose adds and removes cancel exactly, and one where removes
--     outnumber adds. `COUNT(*) FILTER` arithmetic vs `+= 1 / -= 1`.
--   * Verdict statuses outside deleted/clean (i.e. `error`) -> counted as a
--     message but neither flagged nor clean.
--   * Messages with NO verdict at all -> the LEFT JOIN NULL branch.
--   * Metadata with a missing channelName and with an EMPTY one -> the
--     COALESCE(NULLIF(...,'')) fallback to channel_id, which is the exact
--     expression `readChannelName` replaces.
--   * Identical timestamps, so `MAX(created_at)` and `ORDER BY created_at DESC`
--     have ties to resolve.
--   * Reaction rows pointing at message_ids that DO NOT EXIST -> the old
--     `JOIN messages` drops them; a port that groups first and looks up second
--     must drop them too, not emit a null-content row.
--
-- Run against a scratch database only.

BEGIN;

TRUNCATE messages, verdicts, message_reactions, user_profiles, channel_cultures,
  voice_recordings CASCADE;

-- 72 messages over the last 30 days across 6 channels and 12 users.
INSERT INTO messages (id, guild_id, channel_id, user_id, username, avatar_url, content, metadata, ai_status, created_at, deleted_at)
SELECT
  'm' || lpad(i::text, 4, '0'),
  CASE i % 7 WHEN 0 THEN 'g2' ELSE 'g1' END,          -- two guilds
  'ch' || (((i - 1) % 6) + 1),
  'u' || (((i - 1) % 12) + 1),
  -- u01 and u02 CHANGE their username/avatar partway, which must split their
  -- group rather than merge it.
  CASE WHEN i % 12 = 1 AND i > 24 THEN 'user01-renamed'
       WHEN i % 12 = 2 AND i > 24 THEN 'user02-old'
       ELSE 'user' || (((i - 1) % 12) + 1) END,
  CASE WHEN i % 12 = 1 AND i > 24 THEN 'https://cdn/new1.png' ELSE NULL END,
  'msg ' || i,
  -- channelName present / EMPTY / ABSENT, cycling: exercises the
  -- COALESCE(NULLIF(...)) fallback on every third message.
  CASE i % 3
    WHEN 0 THEN jsonb_build_object('channel', jsonb_build_object('channelName', 'Channel ' || (((i - 1) % 6) + 1)))
    WHEN 1 THEN jsonb_build_object('channel', jsonb_build_object('channelName', ''))
    ELSE jsonb_build_object('channel', jsonb_build_object('channelId', 'ch' || (((i - 1) % 6) + 1)))
  END::text,
  CASE i % 5 WHEN 0 THEN 'analyzed' WHEN 1 THEN 'pending' WHEN 2 THEN 'skipped' ELSE 'claimed' END,
  -- Deliberate ties: two messages share a created_at so DESC ordering and
  -- MAX(created_at) both have a tie to break.
  (extract(epoch from now())::bigint * 1000) - (i * 3600000) - (CASE WHEN i % 12 = 0 THEN 0 ELSE 1 END),
  NULL
FROM generate_series(1, 72) i;

-- Verdicts: a spread across clean/deleted/error, plus gaps for messages that
-- must show up as "no verdict" (the LEFT JOIN NULL branch). `categories` and
-- `flags` are text[] here, which the dashboard never reads, so they are left
-- to their defaults.
INSERT INTO verdicts (message_id, status, score, confidence, reason, analysis, evidence, model, created_at, updated_at)
SELECT
  'm' || lpad(i::text, 4, '0'),
  CASE i % 4
    WHEN 0 THEN 'deleted'
    WHEN 1 THEN 'clean'
    WHEN 2 THEN 'error'
    ELSE 'deleted'      -- skip i % 4 = 3 -> message has NO verdict
  END,
  (i % 10) / 10.0,
  ((i % 7) + 1) / 10.0,
  CASE WHEN i % 4 = 0 THEN 'kategori bermasalah' ELSE 'aman' END,
  '{"note":"x"}',
  '{"src":["a"]}'::jsonb,
  'test-model',
  0, 0
FROM generate_series(1, 72) i
WHERE i % 4 <> 3;

-- Reactions. Designed so the net arithmetic has to be right:
--   * m0001: 5 adds, 2 removes -> net 3  (positive)
--   * m0002: 3 adds, 3 removes -> net 0  (must be EXCLUDED by > 0)
--   * m0003: 1 add,  4 removes -> net -3 (must be EXCLUDED by > 0)
--   * m0004: 4 adds, 0 removes -> net 4  (the top message)
--   * m0005: many adds on MANY distinct emojis -> exercises top-3 truncation
--   * r-orphan rows: reactions for messages that do not exist -> the old JOIN
--     dropped them entirely.
INSERT INTO message_reactions (id, message_id, channel_id, guild_id, user_id, username, emoji, emoji_id, animated, reaction_type, created_at)
SELECT
  'r-' || lpad((ROW_NUMBER() OVER ())::text, 4, '0'),
  mid, 'ch1', 'g1', uid, uname, emoji, NULL, false, rtype, 0
FROM (
  VALUES
    -- m0001: net +3
    ('m0001','u01','user01','🔥','add'), ('m0001','u02','user02','🔥','add'),
    ('m0001','u03','user03','🔥','add'), ('m0001','u01','user01','🔥','add'),
    ('m0001','u04','user04','👍','add'), ('m0001','u05','user05','🔥','add'),
    ('m0001','u06','user06','🔥','remove'), ('m0001','u07','user07','🔥','remove'),
    -- m0002: net 0, must NOT appear
    ('m0002','u01','user01','😀','add'), ('m0002','u02','user02','😀','add'),
    ('m0002','u03','user03','😀','add'), ('m0002','u04','user04','😀','remove'),
    ('m0002','u05','user05','😀','remove'), ('m0002','u06','user06','😀','remove'),
    -- m0003: net -3, must NOT appear
    ('m0003','u01','user01','💀','add'),
    ('m0003','u02','user02','💀','remove'), ('m0003','u03','user03','💀','remove'),
    ('m0003','u04','user04','💀','remove'), ('m0003','u05','user05','💀','remove'),
    -- m0004: net +4, the highest -> must be rank 1
    ('m0004','u07','user07','🎉','add'), ('m0004','u08','user08','🎉','add'),
    ('m0004','u09','user09','🎉','add'), ('m0004','u10','user10','🎉','add'),
    -- m0005: one emoji dominating, so top_emojis truncation is observable
    ('m0005','u01','user01','❤️','add'), ('m0005','u02','user02','❤️','add'),
    ('m0005','u03','user03','❤️','add'), ('m0005','u04','user04','❤️','add'),
    ('m0005','u05','user05','❤️','add'), ('m0005','u06','user06','❤️','add'),
    ('m0005','u07','user07','❤️','add'), ('m0005','u08','user08','❤️','add'),
    ('m0005','u09','user09','😂','add'), ('m0005','u10','user10','🤔','add'),
    ('m0005','u11','user11','😎','add'), ('m0005','u12','user12','🙃','add'),
    ('m0005','u13','user13','🔥','add'),
    -- A reactor who renames: same user_id, two usernames -> TWO groups.
    ('m0006','u14','user14-first','✅','add'), ('m0006','u14','user14-second','✅','add'),
    ('m0006','u15','user15','✅','add'), ('m0006','u16','user16','✅','add'),
    -- Orphans: these message_ids are not in `messages`. The old inner JOIN
    -- eliminated them; the port must not resurrect them.
    ('m9998','u17','user17','🎈','add'), ('m9998','u17','user17','🎈','add'),
    ('m9998','u17','user17','🎈','add'), ('m9999','u18','user18','🎈','add'),
    ('m9999','u18','user18','🎈','add')
) AS v(mid, uid, uname, emoji, rtype);

-- Profiles for only SOME users, so the LEFT JOIN NULL branch is covered.
INSERT INTO user_profiles (user_id, guild_id, profile_summary, last_analyzed_at)
SELECT
  'u' || lpad(i::text, 2, '0'),
  'g1',
  'profil user ' || i,
  1700000000000 + i
FROM generate_series(1, 12) i
WHERE i % 4 = 0;

-- Cultures for only SOME channels.
INSERT INTO channel_cultures (channel_id, guild_id, culture_summary, last_analyzed_at)
SELECT
  'ch' || i,
  'g1',
  'budaya channel ' || i,
  1700000000000 + i
FROM generate_series(1, 6) i
WHERE i % 3 = 0;

INSERT INTO voice_recordings (id, user_id, username, avatar_url, guild_id, channel_id, channel_name, filename, size_bytes, download_url, upload_status, created_at)
SELECT
  'v' || i, 'u0' || i, 'user0' || i, NULL, 'g1', 'ch1', 'Channel 1',
  'voice-' || i || '.ogg', 1000 + i, 'http://x/' || i, 'done', 1700000000000 + i
FROM generate_series(1, 5) i;

COMMIT;
