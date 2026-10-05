/**
 * Day and hour bucketing in the DATABASE's timezone.
 *
 * WHY THIS IS NOT UTC
 *
 * The SQL this replaces used `to_char(to_timestamp(created_at / 1000), ...)`
 * and `EXTRACT(HOUR FROM to_timestamp(created_at / 1000))`. `to_timestamp`
 * returns a `timestamptz`, and both `to_char` and `EXTRACT` read a timestamptz
 * in the SESSION timezone — not UTC. This deployment runs `Asia/Jakarta`, so
 * those expressions produced LOCAL buckets. Porting them to `getUTC*()` would
 * have silently shifted the activity heatmap by 7 hours.
 *
 * The comparison harness caught exactly that, in moderation's hourly
 * moderation, before it could reach the dashboard's daily and hourly series.
 *
 * WHY THE ZONE IS NOT A CONFIG VALUE
 *
 * Read from the runtime rather than an env var so it tracks whatever zone the
 * process is actually running in — which is the same zone the DB session used
 * — instead of being a setting that can drift away from it and re-introduce
 * the off-by-N-hours bug.
 */
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
	timeZone: ZONE,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
})

const hourFormatter = new Intl.DateTimeFormat("en-US", {
	timeZone: ZONE,
	hour: "numeric",
	hourCycle: "h23",
})

/** `YYYY-MM-DD` in the database timezone — matches `to_char(..., 'YYYY-MM-DD')`. */
export function localDay(epochMillis: number | bigint): string {
	return dayFormatter.format(new Date(Number(epochMillis)))
}

/** Hour 0-23 in the database timezone — matches `EXTRACT(HOUR FROM to_timestamp(...))`. */
export function localHour(epochMillis: number | bigint): number {
	return Number(hourFormatter.format(new Date(Number(epochMillis))))
}
