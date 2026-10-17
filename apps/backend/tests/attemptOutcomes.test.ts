import { describe, expect, it } from "vitest"
import { summarizeAttemptOutcomes } from "../src/domain/moderation-types.js"

/**
 * `summarizeAttemptOutcomes` is the single place that decides what counts as a
 * completed analysis attempt. It is shared by the dashboard's coverage panel
 * (`ModerationRepository.getCoverage`) and the weekly digest scheduler, which
 * previously each spelled the outcome list out themselves — and drifted. The
 * digest was still reading `ai_analysis_runs`, a table the moderation rewrite
 * left with no writer, so it reported a permanent 0% while the worker was
 * healthy.
 *
 * Production data could not catch that class of bug either: `analysis_attempts`
 * currently contains only `success` rows, so every "failed" branch is unexercised
 * by real traffic. These cases pin the arithmetic instead.
 */
describe("summarizeAttemptOutcomes", () => {
	it("counts `duplicate` as completed, not failed", () => {
		// A duplicate is the model having answered fine while a newer attempt for
		// the same message already landed. Treating it as a failure understates
		// coverage.
		const s = summarizeAttemptOutcomes({ success: 3, duplicate: 1 })
		expect(s.total).toBe(4)
		expect(s.completed).toBe(4)
		expect(s.failed).toBe(0)
		expect(s.coverage_rate).toBe(100)
	})

	it("counts every failure outcome the database CHECK allows", () => {
		const s = summarizeAttemptOutcomes({
			success: 1,
			llm_error: 1,
			parse_error: 1,
			abandoned: 1,
		})
		expect(s.total).toBe(4)
		expect(s.completed).toBe(1)
		expect(s.failed).toBe(3)
		expect(s.coverage_rate).toBe(25)
		expect(s.failed_rate).toBe(75)
	})

	it("treats attempts as the denominator, so a retry lowers coverage", () => {
		// One message retried three times, succeeding on the third: 3 attempts,
		// 1 of which completed. This is the honest "how automated is this" figure.
		const s = summarizeAttemptOutcomes({
			llm_error: 1,
			parse_error: 1,
			success: 1,
		})
		expect(s.total).toBe(3)
		expect(s.coverage_rate).toBe(33.3)
	})

	it("reports zero rates for an empty window instead of NaN", () => {
		const s = summarizeAttemptOutcomes({})
		expect(s).toMatchObject({
			total: 0,
			completed: 0,
			failed: 0,
			coverage_rate: 0,
			failed_rate: 0,
		})
	})

	it("passes the raw per-outcome counts through for the breakdown UI", () => {
		const counts = { success: 2, llm_error: 1 }
		expect(summarizeAttemptOutcomes(counts).outcomes).toEqual(counts)
	})

	it("ignores an unknown outcome in the rates but still counts it in the total", () => {
		// Defensive: the CHECK constraint makes this unreachable in practice, but a
		// total that silently disagrees with the row count would be worse.
		const s = summarizeAttemptOutcomes({ success: 1, something_new: 1 })
		expect(s.total).toBe(2)
		expect(s.completed).toBe(1)
		expect(s.failed).toBe(0)
	})
})
