/**
 * Deterministic fixture for the P1b characterization tests.
 *
 * Everything is namespaced under `char-` and pinned to fixed timestamps so a
 * snapshot taken today compares byte-for-byte against one taken after the
 * repository is ported to Drizzle. Nothing here reads wall-clock time: a
 * relative date would drift between runs and make every diff meaningless.
 *
 * NOT SAFE FOR PRODUCTION. `seedFixture` truncates the tables it seeds, which
 * is fine against the throwaway dev-postgres (`scripts/dev-pg.sh`, db
 * `gmw_mod`) and catastrophic against `dcbot`. `clearFixture` at the end uses
 * narrow DELETEs instead, so teardown is always the polite form.
 *
 * WHY PLAIN STRINGS RATHER THAN `sql` TEMPLATES: every value here is a
 * compile-time constant, so there is nothing to bind and nothing to escape. A
 * Drizzle `sql` template turns each interpolation into a bind parameter, and
 * Postgres then cannot infer a type for several of them inside a multi-row
 * VALUES list (42P18 "could not determine data type of parameter"). Inlining
 * the literals sidesteps that entirely — and these are test fixtures, not a
 * place where a bind parameter earns its keep.
 */
import { executeAll } from "../../src/shared/database/drizzle.js";

/** Fixed clock for the whole fixture: 2024-06-15T12:00:00Z. */
export const T0 = 1_718_448_000_000;
const DAY = 86_400_000;
const HALF_DAY = DAY / 2;

const GUILD = "char-guild";
const CH_A = "char-chan-general";
const CH_B = "char-chan-spam";

export async function seedFixture() {
  await executeAll(`
		TRUNCATE TABLE messages, verdicts, moderation_actions, user_profiles,
			channel_cultures, message_edits, message_reviews, message_reactions,
			attachments
		RESTART IDENTITY CASCADE
	`);

  // Five messages across three users, chosen to exercise every branch the
  // repositories branch on: clean vs deleted moderation, executed vs failed vs
  // pending actions, one user appearing under two usernames (the dashboard's
  // grouping key is user_id+username+avatar_url), a NULL metadata row, and
  // both the JSON-array and bare-comma shapes of moderation_actions.categories
  // that `normalizeCategories` has to survive.
  await executeAll(`
		INSERT INTO messages (id, guild_id, channel_id, user_id, username,
			avatar_url, content, created_at, edited_at, deleted_at, type, metadata,
			ai_status, attempts)
		VALUES
			('char-msg-1', '${GUILD}', '${CH_A}', 'char-user-1', 'alpha',
			 'https://a/1.png', 'halo dunia', ${T0}, NULL, NULL, 'text',
			 '{"channel":{"channelName":"general"}}', 'analyzed', 1),
			('char-msg-2', '${GUILD}', '${CH_A}', 'char-user-1', 'alpha',
			 'https://a/1.png', 'kontak joker di 0812', ${T0 - DAY}, NULL,
			 ${T0 - HALF_DAY}, 'deleted',
			 '{"channel":{"channelName":"general"}}', 'analyzed', 1),
			('char-msg-3', '${GUILD}', '${CH_B}', 'char-user-2', 'beta', NULL,
			 'promourah install now', ${T0 - 2 * DAY}, NULL, NULL, 'text',
			 '{"channel":{"channelName":"spam"}}', 'analyzed', 1),
			('char-msg-4', '${GUILD}', '${CH_B}', 'char-user-3', 'gamma', NULL,
			 'halo juga', ${T0 - 3 * DAY}, NULL, NULL, 'text', NULL, 'pending', 0),
			('char-msg-5', '${GUILD}', '${CH_A}', 'char-user-1', 'alpha-renamed',
			 NULL, 'edit ini', ${T0 - 4 * DAY}, ${T0 - HALF_DAY}, NULL,
			 'edited', NULL, 'analyzed', 1)
	`);

  // `verdicts.flags` / `categories` are real Postgres ARRAY columns — writing
  // a JSON string here raises "malformed array literal". Note this differs
  // from `moderation_actions.categories`, which is `text` and holds BOTH
  // shapes (see the mixed `["scam"]` and `spam,inappropriate` rows below) —
  // that inconsistency is exactly what `normalizeCategories` exists to absorb.
  //
  // `verdicts_reason_check` enforces: status='deleted' implies a non-empty
  // reason. Seeding without one fails the INSERT, so both deleted rows carry
  // one — and the clean rows deliberately leave it NULL, which is the branch
  // that constraint exists to allow.
  await executeAll(`
		INSERT INTO verdicts (message_id, status, score, confidence, flags,
			categories, reason, model, updated_at)
		VALUES
			('char-msg-1', 'clean',   0.05, 0.90, '{}', '{chitchat}', NULL,
			 'test-model', ${T0}),
			('char-msg-2', 'deleted', 0.95, 0.98, '{scam,contact}', '{scam}',
			 'kontak obligated', 'test-model', ${T0 - DAY}),
			('char-msg-3', 'deleted', 0.80, 0.85, '{spam}', '{spam}',
			 'iklan berlebihan', 'test-model', ${T0 - 2 * DAY}),
			('char-msg-5', 'clean',   0.10, 0.80, '{}', '{chitchat}', NULL,
			 'test-model', ${T0 - 4 * DAY})
	`);

  // `moderation_actions` has NO channel_id column — channel comes from the
  // message. `categories` here is `text`, deliberately seeded with BOTH
  // historical shapes (a JSON array and a bare comma list) because that
  // inconsistency is real in production and `normalizeCategories` is the
  // guard that stops a `::jsonb` cast from 500-ing the whole query.
  // `id` is a NOT NULL text column with no default (the writer supplies a
  // snowflake), so the fixture has to name one explicitly.
  await executeAll(`
		INSERT INTO moderation_actions (id, message_id, guild_id, user_id,
			action_type, status, reason, categories, created_at, executed_at)
		VALUES
			('char-act-1', 'char-msg-2', '${GUILD}', 'char-user-1', 'delete_message',
			 'executed', 'scam contact', '["scam"]', ${T0 - DAY}, ${T0 - DAY}),
			('char-act-2', 'char-msg-3', '${GUILD}', 'char-user-2', 'delete_message',
			 'failed', 'model timeout', 'spam,inappropriate', ${T0 - 2 * DAY}, NULL),
			('char-act-3', 'char-msg-5', '${GUILD}', 'char-user-1', 'reset_nickname',
			 'pending', 'bad nickname', '["harassment"]', ${T0 - 4 * DAY}, NULL)
	`);

  // `user_profiles` is a moderation-summary table keyed (user_id, guild_id):
  // `profile_summary` + `last_analyzed_at`, not a Discord-profile cache. The
  // display name and avatar the dashboard shows come off the message rows.
  await executeAll(`
		INSERT INTO user_profiles (user_id, guild_id, profile_summary, last_analyzed_at)
		VALUES
			('char-user-1', '${GUILD}', 'chatter alpha', ${T0}),
			('char-user-2', '${GUILD}', 'spammer beta', ${T0 - 2 * DAY})
	`);

  await executeAll(`
		INSERT INTO channel_cultures (channel_id, guild_id, culture_summary,
			last_analyzed_at)
		VALUES ('${CH_A}', '${GUILD}', 'basa-basi santai', ${T0})
	`);

  await executeAll(`
		INSERT INTO message_edits (id, message_id, old_content, edited_at)
		VALUES ('00000000-0000-0000-0000-000000000001', 'char-msg-5',
			'edit lama', ${T0 - HALF_DAY})
	`);

  // Reactions are denormalised snapshots (id, channel_id, guild_id, username,
  // reaction_type, animated), NOT a (message, emoji) tally — the dashboard's
  // top-reactions query aggregates by `emoji` over these rows.
  await executeAll(`
		INSERT INTO message_reactions (id, message_id, channel_id, guild_id, user_id,
			username, emoji, animated, reaction_type, created_at)
		VALUES
			('char-react-1', 'char-msg-1', '${CH_A}', '${GUILD}', 'char-user-2',
			 'beta', 'thumbsup', false, 'add', ${T0}),
			('char-react-2', 'char-msg-1', '${CH_A}', '${GUILD}', 'char-user-3',
			 'gamma', 'fire', false, 'add', ${T0}),
			('char-react-3', 'char-msg-3', '${CH_B}', '${GUILD}', 'char-user-1',
			 'alpha', 'thumbsup', false, 'add', ${T0})
	`);
}

/** Remove every row the fixture owns, leaving unrelated data untouched. */
export async function clearFixture() {
  await executeAll(
    `DELETE FROM message_reactions  WHERE id IN ('char-react-1', 'char-react-2', 'char-react-3')`,
  );
  await executeAll(
    `DELETE FROM message_edits      WHERE id = '00000000-0000-0000-0000-000000000001'`,
  );
  await executeAll(`
		DELETE FROM moderation_actions
		WHERE message_id IN ('char-msg-2', 'char-msg-3', 'char-msg-5')
	`);
  await executeAll(`
		DELETE FROM verdicts
		WHERE message_id IN ('char-msg-1', 'char-msg-2', 'char-msg-3', 'char-msg-5')
	`);
  await executeAll(
    `DELETE FROM user_profiles    WHERE user_id IN ('char-user-1', 'char-user-2')`,
  );
  await executeAll(`DELETE FROM channel_cultures WHERE channel_id = '${CH_A}'`);
  await executeAll(`
		DELETE FROM messages
		WHERE id IN ('char-msg-1', 'char-msg-2', 'char-msg-3', 'char-msg-4', 'char-msg-5')
	`);
}

export const FIXTURE = { GUILD, CH_A, CH_B };
