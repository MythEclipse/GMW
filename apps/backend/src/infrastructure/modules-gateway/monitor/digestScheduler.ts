import { sql } from "drizzle-orm"
import { summarizeAttemptOutcomes } from "../../../domain/moderation-types.js"
import { config } from "../../config/index.js"
import { getDatabase } from "../../database/drizzle.js"
import { createChildLogger } from "../../logger/index.js"

const logger = createChildLogger("digest-scheduler")

// 7 days
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

let lastDigestTs: number = 0

/**
 * Weekly moderation digest for the public monitor channel (or webhook).
 * Fully automatic — no UI, no shadow mode. Queries the DB directly and posts
 * a compact embed to WEBHOOK_URLS. Read-only: never mutates moderation state.
 */
export async function runWeeklyDigest(now = Date.now()): Promise<void> {
	// Run at most once per week (guard against double-scheduling on restart).
	if (now - lastDigestTs < WEEK_MS) return
	lastDigestTs = now

	if (!config.WEBHOOK_URLS.length) {
		logger.warn("No WEBHOOK_URLS configured — skipping weekly digest")
		return
	}

	const db = getDatabase()
	const since = now - WEEK_MS

	try {
		// `allSettled`, not `all`. These four queries are independent, and under
		// `Promise.all` any one of them failing rejected the whole batch — which
		// is exactly how this digest came to post NOTHING at all when the
		// categories query hit a type error, rather than posting a digest with an
		// empty category list. A monitoring message that silently disappears is
		// worse than one with a gap in it, so each section now fails alone and
		// says so.
		const [trends, domains, channels, coverage] = await Promise.allSettled([
			// Top categories.
			//
			// `categories` is TEXT holding a JSON array, not a jsonb column, so
			// it needs the explicit cast — `jsonb_array_elements_text(text)`
			// does not exist, and because this sat inside a `Promise.all` the
			// type error failed the WHOLE digest, meaning it posted nothing at
			// all rather than posting with an empty category list.
			db.execute(sql`
        SELECT t.name, COUNT(*)::int AS c
        FROM moderation_actions a,
             jsonb_array_elements_text(a.categories::jsonb) AS t(name)
        WHERE a.created_at >= ${since} AND a.categories IS NOT NULL
        GROUP BY t.name ORDER BY c DESC LIMIT 5
      `),
			// Top flagged domains.
			//
			// There is no `content` column on `moderation_actions`: the flagged
			// text lives on the message, so the host scan joins `messages`.
			// `reason` and `evidence` stay in the concatenation because the
			// model's own citation often carries the URL.
			db.execute(sql`
        SELECT host, COUNT(*)::int AS c
        FROM (
          SELECT DISTINCT a.id,
            (regexp_matches(COALESCE(m.content,'') || ' ' || COALESCE(a.reason,'') || ' ' || COALESCE(a.evidence,''), 'https?://([^/\\s?#]+)', 'g'))[1] AS host
          FROM moderation_actions a
          LEFT JOIN messages m ON m.id = a.message_id
          WHERE a.created_at >= ${since}
        ) sub
        WHERE host IS NOT NULL
        GROUP BY host ORDER BY c DESC LIMIT 5
      `),
			// Top flagged channels
			db.execute(sql`
        SELECT COALESCE(NULLIF((m.metadata::jsonb -> 'channel' ->> 'channelName'), ''), m.channel_id) AS channel_name,
               COUNT(*)::int AS c
        FROM moderation_actions a
        LEFT JOIN messages m ON m.id = a.message_id
        WHERE a.created_at >= ${since} AND m.channel_id IS NOT NULL
        GROUP BY channel_name ORDER BY c DESC LIMIT 5
      `),
			// Coverage — same denominator as the dashboard's `getCoverage`:
			// `analysis_attempts`, not `ai_analysis_runs`. The latter was written
			// only by the pre-rewrite in-process pipeline and has had no writer
			// since, so this line read a permanently empty table and reported
			// "0% (0/0 runs completed)" every week while the worker was healthy.
			db.execute(sql`
        SELECT outcome AS status, COUNT(*)::int AS c
        FROM analysis_attempts
        WHERE created_at >= ${since}
        GROUP BY outcome
      `),
		])

		// Each section reports its own failure rather than taking the digest down.
		const rowsOf = (r: PromiseSettledResult<{ rows: unknown[] }>) =>
			r.status === "fulfilled"
				? (r.value.rows as Record<string, unknown>[])
				: []

		const sectionFailed = (
			r: PromiseSettledResult<unknown>,
			label: string,
		): void => {
			if (r.status === "rejected") {
				logger.warn({ err: r.reason, section: label }, "Digest section failed")
			}
		}
		sectionFailed(trends, "top categories")
		sectionFailed(domains, "top domains")
		sectionFailed(channels, "top channels")
		sectionFailed(coverage, "coverage")

		const topCats = rowsOf(trends).map((r) => `${r.name} (${r.c})`)
		const topDomains = rowsOf(domains).map((r) => `${r.host} (${r.c})`)
		const topChannels = rowsOf(channels).map(
			(r) => `${r.channel_name} (${r.c})`,
		)
		const counts: Record<string, number> = {}
		for (const r of rowsOf(coverage)) {
			counts[String(r.status)] = Number(r.c)
		}
		// One shared summariser with the dashboard, so the digest and the UI
		// cannot publish different coverage numbers for the same week.
		const {
			total,
			completed,
			coverage_rate: covRate,
		} = summarizeAttemptOutcomes(counts)

		const lines: string[] = []
		lines.push(`**GMW Weekly Moderation Digest** (last 7 days)`)
		lines.push("")
		lines.push(
			`Auto-mod coverage: ${covRate}% (${completed}/${total} runs completed)`,
		)
		lines.push(
			`**Top flagged categories:** ${topCats.length ? topCats.join(", ") : "—"}`,
		)
		lines.push(
			`**Top flagged domains:** ${topDomains.length ? topDomains.join(", ") : "—"}`,
		)
		lines.push(
			`**Top flagged channels:** ${topChannels.length ? topChannels.join(", ") : "—"}`,
		)
		lines.push("")
		lines.push(
			"_View full breakdowns at the moderation dashboard (public, read-only)._",
		)

		const body = JSON.stringify({
			username: "GMW Digest",
			avatar_url:
				"https://upload.wikimedia.org/wikipedia/commons/6/6a/Orange_tabby_cat_sitting_on_fallen_leaves-Hisashi-01A.jpg",
			content: null,
			embeds: [
				{
					title: "GMW Weekly Moderation Digest",
					description: lines.join("\n"),
					color: 0x38bdf8,
					timestamp: new Date().toISOString(),
				},
			],
		})

		for (const url of config.WEBHOOK_URLS) {
			try {
				const res = await fetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body,
				})
				if (!res.ok) {
					logger.warn({ url, status: res.status }, "Digest webhook failed")
				}
			} catch (err) {
				logger.warn({ err }, "Digest webhook threw")
			}
		}
		logger.info("Weekly digest posted")
	} catch (err) {
		logger.error({ err }, "Weekly digest failed")
	}
}

/** Schedule the weekly digest. Runs on an interval; the guard inside
 * `runWeeklyDigest` ensures it only fires once per WEEK_MS.
 */
export function startDigestScheduler(intervalMs = 60 * 60 * 1000): void {
	// Fire an immediate (guarded) digest on start, then tick hourly.
	void runWeeklyDigest()
	setInterval(() => {
		void runWeeklyDigest()
	}, intervalMs)
}
