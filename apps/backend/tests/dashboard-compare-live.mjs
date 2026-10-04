/**
 * COMPARISON HARNESS — proves the Prisma port of
 * modules/dashboard/dashboard.repository.ts returns the same rows as the SQL
 * it replaced.
 *
 * The ports replace SQL `GROUP BY` / `FILTER` / `COUNT(DISTINCT …)` with
 * Map-and-Set reductions in JS, so a subtle difference in grouping keys is
 * exactly the kind of bug that still looks right on tidy data. The fixtures
 * carry the cases that break a naive loop:
 *
 *   * rename / avatar changes that MUST split a user's group, not merge it
 *   * reactions with a NET count of 0 and of negative — both filtered by > 0
 *   * rows whose channelName is empty-string vs missing vs a real name
 *   * reactions for messages that do not exist (the old JOIN dropped them)
 *
 * Two caveats, stated so the numbers are readable:
 *   * The ORIGINAL `listUsers`/`getUserDetail` selected `m.warn_count` from a
 *     subquery that never computed it, so they threw `column "m.warn_count"
 *     does not exist` on every call. For comparison they are run with the one
 *     column renamed to its known intent (flagged_count), and the port reports
 *     warn_count as that same flagged count. This is a deliberate repair, not
 *     a drift.
 *   * `messages.metadata` is `text`, and the JSON path is identical, so the
 *     channel-name fallback resolves the same as the SQL COALESCE.
 *
 * Run with:
 *   DSN=postgresql://postgres:postgres@127.0.0.1:5433/gmw_compare \
 *     bun tests/dashboard-compare-live.mjs
 */

import pg from "pg";

const dsn = process.env.DSN;
if (!dsn) {
        console.error("DSN is required");
        process.exit(2);
}
process.env.DATABASE_URL = dsn;

const pool = new pg.Pool({ connectionString: dsn });

let pass = 0;
let fail = 0;

function check(name, ok, detail = "") {
        ok ? pass++ : fail++;
        console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function canonical(v) {
        if (Array.isArray(v)) return v.map(canonical);
        if (v && typeof v === "object") {
                return Object.fromEntries(
                        Object.keys(v)
                                .sort()
                                .map((k) => [k, canonical(v[k])]),
                );
        }
        if (typeof v === "string" && /^-?\d+$/.test(v)) return Number(v);
        return v;
}
const same = (a, b) =>
        JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** Compare a SQL result's rows against the JS port's rows. */
async function compare(name, sql, run, { unordered = false, params = [] } = {}) {
        const [expectedResult, actual] = await Promise.all([
                pool.query(sql, params),
                run(),
        ]);
        let a = expectedResult.rows;
        let b = actual;
        if (unordered) {
                const key = (x) => JSON.stringify(canonical(x));
                a = [...a].sort((x, y) => (key(x) < key(y) ? -1 : 1));
                b = [...b].sort((x, y) => (key(x) < key(y) ? -1 : 1));
        }
        if (same(a, b)) {
                check(name, true, `${a.length} rows`);
        } else {
                check(name, false, "DIVERGENCE");
                console.log("  SQL    :", JSON.stringify(a).slice(0, 900));
                console.log("  Prisma :", JSON.stringify(b).slice(0, 900));
        }
}

try {
        const { initializeDatabase, closeDatabase } = await import(
                "../src/shared/database/init.ts"
        );
        const { dashboardRepository: repo } = await import(
                "../src/modules/dashboard/dashboard.repository.ts"
        );

        await initializeDatabase({
                DATABASE_URL: dsn,
                POSTGRES_POOL_MIN: 1,
                POSTGRES_POOL_MAX: 5,
        });

        // --- getActivity ----------------------------------------------------
        await compare(
                "getActivity daily buckets",
                `SELECT to_char(to_timestamp(m.created_at / 1000), 'YYYY-MM-DD') AS day,
                        COUNT(*)::int AS messages,
                        COUNT(*) FILTER (WHERE v.status = 'deleted')::int AS flagged,
                        COUNT(DISTINCT m.user_id)::int AS active_users
                 FROM messages m LEFT JOIN verdicts v ON v.message_id = m.id
                 WHERE m.created_at >= (EXTRACT(EPOCH FROM now())::bigint * 1000) - (7 * 86400000)
                 GROUP BY day ORDER BY day`,
                async () => {
                        const a = await repo.getActivity(7);
                        return a.daily.map((d) => ({
                                day: d.day,
                                messages: d.messages,
                                flagged: d.flagged,
                                active_users: d.active_users,
                        }));
                },
        );

        await compare(
                "getActivity hourly buckets",
                `SELECT EXTRACT(HOUR FROM to_timestamp(m.created_at / 1000))::int AS hour,
                        COUNT(*)::int AS messages,
                        COUNT(*) FILTER (WHERE v.status = 'deleted')::int AS flagged
                 FROM messages m LEFT JOIN verdicts v ON v.message_id = m.id
                 WHERE m.created_at >= (EXTRACT(EPOCH FROM now())::bigint * 1000) - 86400000
                 GROUP BY hour ORDER BY hour`,
                async () => {
                        const a = await repo.getActivity(7);
                        return a.hourly.map((h) => ({
                                hour: h.hour,
                                messages: h.messages,
                                flagged: h.flagged,
                        }));
                },
        );

        // --- listUsers (old SQL is the warn_count-broken one; see header) ----
        // Parity SQL projects flagged_count AS warn_count, the port's repair.
        await compare(
                "listUsers groups by (user_id,username,avatar_url)",
                `SELECT m.user_id, m.username, m.avatar_url,
                        m.total_messages,
                        m.flagged_count, m.clean_count,
                        m.flagged_count AS warn_count,
                        m.last_message_at
                 FROM (
                   SELECT msg.user_id, msg.username, msg.avatar_url,
                          COUNT(*)::int AS total_messages,
                          COUNT(*) FILTER (WHERE v.status = 'deleted')::int AS flagged_count,
                          COUNT(*) FILTER (WHERE v.status = 'clean')::int AS clean_count,
                          MAX(msg.created_at) AS last_message_at
                   FROM messages msg LEFT JOIN verdicts v ON v.message_id = msg.id
                   GROUP BY msg.user_id, msg.username, msg.avatar_url
                 ) m ORDER BY m.last_message_at DESC NULLS LAST LIMIT 21`,
                async () => {
                        const r = await repo.listUsers({ limit: 20 });
                        return r.data.map((u) => ({
                                user_id: u.user_id,
                                username: u.username,
                                avatar_url: u.avatar_url,
                                total_messages: u.total_messages,
                                flagged_count: u.flagged_count,
                                clean_count: u.clean_count,
                                warn_count: u.warn_count,
                                last_message_at: u.last_message_at,
                        }));
                },
                { unordered: false },
        );

        // --- listChannels ---------------------------------------------------
        await compare(
                "listChannels groups by (channel_id,guild_id,channelName)",
                `SELECT m.channel_id, m.channel_name, m.guild_id,
                        m.total_messages, m.flagged_count, m.last_message_at,
                        c.culture_summary, c.last_analyzed_at
                 FROM (
                   SELECT msg.channel_id, msg.guild_id,
                          COALESCE(NULLIF((msg.metadata::jsonb -> 'channel' ->> 'channelName'), ''), msg.channel_id) AS channel_name,
                          COUNT(*)::int AS total_messages,
                          COUNT(*) FILTER (WHERE v.status = 'deleted')::int AS flagged_count,
                          MAX(msg.created_at) AS last_message_at
                   FROM messages msg LEFT JOIN verdicts v ON v.message_id = msg.id
                   GROUP BY msg.channel_id, msg.guild_id, (msg.metadata::jsonb -> 'channel' ->> 'channelName')
                 ) m LEFT JOIN channel_cultures c ON c.channel_id = m.channel_id
                 ORDER BY m.total_messages DESC, m.channel_id, m.channel_name LIMIT 21`,
                async () => {
                        const r = await repo.listChannels({ limit: 20 });
                        return r.data.map((c) => ({
                                channel_id: c.channel_id,
                                channel_name: c.channel_name,
                                guild_id: c.guild_id,
                                total_messages: c.total_messages,
                                flagged_count: c.flagged_count,
                                last_message_at: c.last_message_at,
                                culture_summary: c.culture_summary,
                                last_analyzed_at: c.last_analyzed_at,
                        }));
                },
                { unordered: true },
        );

        // --- getChannelDetail ----------------------------------------------
        // The harness parity SQL reproduces the group-then-LEFT-JOIN shape; the
        // port fetches messages and reduces, the semantics match.
        await compare(
                "getChannelDetail aggregate",
                `SELECT m.channel_id, m.channel_name, m.guild_id, m.total_messages,
                        m.flagged_count, m.clean_count, c.culture_summary, c.last_analyzed_at
                 FROM (
                   SELECT msg.channel_id, msg.guild_id,
                          COALESCE(NULLIF((msg.metadata::jsonb -> 'channel' ->> 'channelName'), ''), msg.channel_id) AS channel_name,
                          COUNT(*)::int AS total_messages,
                          COUNT(*) FILTER (WHERE v.status = 'deleted')::int AS flagged_count,
                          COUNT(*) FILTER (WHERE v.status = 'clean')::int AS clean_count
                   FROM messages msg LEFT JOIN verdicts v ON v.message_id = msg.id
                   WHERE msg.channel_id = $1
                   GROUP BY msg.channel_id, msg.guild_id, (msg.metadata::jsonb -> 'channel' ->> 'channelName')
                 ) m LEFT JOIN channel_cultures c ON c.channel_id = m.channel_id
                 ORDER BY m.total_messages DESC
                 LIMIT 1`,
                async () => {
                        const d = await repo.getChannelDetail("ch3");
                        return [
                                {
                                        channel_id: d?.channel_id,
                                        channel_name: d?.channel_name,
                                        guild_id: d?.guild_id,
                                        total_messages: d?.total_messages,
                                        flagged_count: d?.flagged_count,
                                        clean_count: d?.clean_count,
                                        culture_summary: d?.culture_summary,
                                        last_analyzed_at: d?.last_analyzed_at ?? null,
                                },
                        ];
                },
                { params: ["ch3"] },
        );

        // --- getTopReactions -----------------------------------------------
        await compare(
                "getTopReactions net reactions",
                `SELECT m.id AS message_id, m.content, m.username, m.channel_id, r.reaction_count
                 FROM (
                   SELECT message_id,
                          (COUNT(*) FILTER (WHERE reaction_type = 'add')
                           - COUNT(*) FILTER (WHERE reaction_type = 'remove'))::int AS reaction_count
                   FROM message_reactions
                   GROUP BY message_id
                 ) r
                 JOIN messages m ON m.id = r.message_id
                 WHERE r.reaction_count > 0
                 ORDER BY r.reaction_count DESC, m.id ASC
                 LIMIT 20`,
                async () => {
                        const r = await repo.getTopReactions(20);
                        return r.map((x) => ({
                                message_id: x.message_id,
                                content: x.content,
                                username: x.username,
                                channel_id: x.channel_id,
                                reaction_count: x.reaction_count,
                        }));
                },
        );

        // --- getTopReactors ------------------------------------------------
        await compare(
                "getTopReactors net given",
                `SELECT user_id, username,
                        (COUNT(*) FILTER (WHERE reaction_type = 'add')
                         - COUNT(*) FILTER (WHERE reaction_type = 'remove'))::int AS net_count,
                        COUNT(*) FILTER (WHERE reaction_type = 'add')::int AS adds_count,
                        COUNT(DISTINCT message_id)::int AS messages_reacted,
                        COUNT(DISTINCT emoji)::int AS emojis_used
                 FROM message_reactions
                 GROUP BY user_id, username
                 ORDER BY net_count DESC, user_id ASC, username ASC
                 LIMIT 20`,
                async () => {
                        const r = await repo.getTopReactors(20);
                        return r.map((x) => ({
                                user_id: x.user_id,
                                username: x.username,
                                net_count: x.net_count,
                                adds_count: x.adds_count,
                                messages_reacted: x.messages_reacted,
                                emojis_used: x.emojis_used,
                        }));
                },
        );

        // --- getUserDetail --------------------------------------------------
        await compare(
                "getUserDetail aggregate",
                `SELECT m.user_id, m.username, m.avatar_url, m.total_messages,
                        m.flagged_count, m.clean_count, m.flagged_count AS warn_count,
                        p.profile_summary, p.last_analyzed_at
                 FROM (
                   SELECT msg.user_id, msg.username, msg.avatar_url,
                          COUNT(*)::int AS total_messages,
                          COUNT(*) FILTER (WHERE v.status = 'deleted')::int AS flagged_count,
                          COUNT(*) FILTER (WHERE v.status = 'clean')::int AS clean_count
                   FROM messages msg LEFT JOIN verdicts v ON v.message_id = msg.id
                   WHERE msg.user_id = $1
                   GROUP BY msg.user_id, msg.username, msg.avatar_url
                 ) m LEFT JOIN user_profiles p ON p.user_id = m.user_id`,
                async () => {
                        const d = await repo.getUserDetail("u01");
                        return d
                                ? [
                                                {
                                                        user_id: d.user_id,
                                                        username: d.username,
                                                        avatar_url: d.avatar_url,
                                                        total_messages: d.total_messages,
                                                        flagged_count: d.flagged_count,
                                                        clean_count: d.clean_count,
                                                        warn_count: d.warn_count,
                                                        profile_summary: d.profile_summary,
                                                        last_analyzed_at: d.last_analyzed_at ?? null,
                                                },
                                        ]
                                : [];
                },
                { params: ["u01"] },
        );

        // --- getStats: totals line ------------------------------------------
        await compare(
                "getStats totals line",
                `SELECT COUNT(*)::int AS total_messages,
                        COUNT(*) FILTER (WHERE v.status = 'deleted')::int AS total_flagged,
                        COUNT(*) FILTER (WHERE v.status = 'clean')::int AS total_clean,
                        COUNT(*) FILTER (WHERE v.status = 'error')::int AS total_error,
                        COUNT(*) FILTER (WHERE m.ai_status = 'pending')::int AS total_pending,
                        COUNT(*) FILTER (WHERE m.ai_status = 'claimed')::int AS total_claimed,
                        COUNT(*) FILTER (WHERE m.ai_status = 'retry_wait')::int AS total_retry_wait,
                        COUNT(*) FILTER (WHERE m.ai_status = 'dead')::int AS total_dead,
                        COUNT(*) FILTER (WHERE m.ai_status = 'skipped')::int AS total_skipped,
                        COUNT(DISTINCT m.user_id)::int AS total_users,
                        COUNT(*) FILTER (WHERE m.created_at >= (EXTRACT(EPOCH FROM now())::bigint * 1000) - 86400000)::int AS today_messages,
                        COUNT(*) FILTER (WHERE v.status = 'deleted' AND m.created_at >= (EXTRACT(EPOCH FROM now())::bigint * 1000) - 86400000)::int AS today_flagged,
                        COUNT(DISTINCT m.user_id) FILTER (WHERE m.created_at >= (EXTRACT(EPOCH FROM now())::bigint * 1000) - 86400000)::int AS active_users_24h
                 FROM messages m LEFT JOIN verdicts v ON v.message_id = m.id`,
                async () => {
                        const s = await repo.getStats();
                        return [
                                {
                                        total_messages: s.total_messages,
                                        total_flagged: s.total_flagged,
                                        total_clean: s.total_clean,
                                        total_error: s.total_error,
                                        total_pending: s.total_pending,
                                        total_claimed: s.total_claimed,
                                        total_retry_wait: s.total_retry_wait,
                                        total_dead: s.total_dead,
                                        total_skipped: s.total_skipped,
                                        total_users: s.total_users,
                                        today_messages: s.today_messages,
                                        today_flagged: s.today_flagged,
                                        active_users_24h: s.active_users_24h,
                                },
                        ];
                },
        );

        // --- getStats: top channels ------------------------------------------
        await compare(
                "getStats top_channels",
                `SELECT channel_id,
                        COALESCE(NULLIF((metadata::jsonb -> 'channel' ->> 'channelName'), ''), channel_id) AS channel_name,
                        COUNT(*)::int AS message_count
                 FROM messages
                 WHERE metadata IS NOT NULL AND metadata != ''
                 GROUP BY channel_id, (metadata::jsonb -> 'channel' ->> 'channelName')
                 ORDER BY COUNT(*) DESC
                 LIMIT 10`,
                async () => {
                        const s = await repo.getStats();
                        return s.top_channels;
                },
                { unordered: true },
        );
} catch (err) {
        console.error("harness error:", err?.message ?? err);
        fail++;
} finally {
        await pool.end();
        try {
                await closeDatabase();
        } catch {}
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
