/**
 * Auto-delete eligibility rules.
 *
 * Revived from the pre-rewrite `autoDeleteEligibility.test.ts` (deleted in
 * 2658b0dd) and rewritten against `bun:test`, the runner this repo uses now.
 *
 * The input changed shape twice. The old tests set `ai_status: "flagged"` on a
 * message; after the 0020 rewrite that column only means "the worker
 * finished", so these tests set `verdict.status` instead — the field that
 * actually carries the judgement. Then `severity` and the six-valued
 * `recommended_action` were deleted, taking `deriveSeverity` and
 * `deriveRecommendedAction` with them: there is nothing left to derive, because
 * `status` is the whole decision and the pipeline is full auto.
 *
 * That is why the suites below replaced the two derivation suites rather than
 * re-asserting them. Each replacement keeps the original question ("is this
 * guarded?") and points it at the gate that now exists — confidence, evidence,
 * and the allow-lists — instead of at a tier that no longer does.
 */
import { describe, expect, test } from "vitest"
import {
	holdsExemptRole,
	isEligibleForAutoDelete,
	isNameImplicated,
	isNicknameOnlyViolation,
	type MessageLike,
	parseStringList,
	type VerdictLike,
} from "../src/infrastructure/modules-gateway/ai-moderation/autoDeleteEligibility.js"

function msg(overrides: Partial<MessageLike> = {}): MessageLike {
	return {
		id: "m1",
		guild_id: "g1",
		channel_id: "c1",
		user_id: "u1",
		thread_id: null,
		...overrides,
	}
}

/**
 * A stored verdict row.
 *
 * `categories` mirrors `flags` whenever the caller overrides only one of them,
 * because that is the shape the PARSER actually writes: `categories` falls back
 * to `flags`, and the enforcement is derived from that effective value. A fixture
 * that set `flags: ["offensive_nickname"]` while leaving `categories:
 * ["harassment"]` would describe a row the worker cannot produce, and the
 * mismatch is exactly what these predicates are meant to resolve.
 */
function verdict(overrides: Partial<VerdictLike> = {}): VerdictLike {
	const base: VerdictLike = {
		status: "deleted",
		confidence: 0.95,
		score: 0.95,
		categories: ["harassment"],
		flags: ["harassment"],
		analysis: "contains abusive language directed at another member",
	}
	const merged = { ...base, ...overrides }
	if (overrides.flags !== undefined && overrides.categories === undefined) {
		merged.categories = overrides.flags
	}
	if (overrides.categories !== undefined && overrides.flags === undefined) {
		merged.flags = overrides.categories
	}
	return merged
}

describe("parseStringList", () => {
	test("splits comma-separated config values", () => {
		expect(parseStringList("a, b ,c")).toEqual(["a", "b", "c"])
	})

	test("accepts a JSON array", () => {
		expect(parseStringList('["a","b"]')).toEqual(["a", "b"])
	})

	test("empty and null yield an empty list", () => {
		expect(parseStringList("")).toEqual([])
		expect(parseStringList(null)).toEqual([])
	})

	test("falls back to comma splitting on malformed JSON", () => {
		expect(parseStringList("[broken, b")).toEqual(["[broken", "b"])
	})
})

describe("status alone decides eligibility", () => {
	// This is the rule that matters most now: the model says "delete" or it does
	// not, and the operator decided the pipeline is full auto. There is no tier
	// that can hold a deletion back and no field that can promote one.
	test("a deleted verdict is eligible once the evidence gates pass", () => {
		expect(isEligibleForAutoDelete(msg(), verdict())).toBe(true)
	})

	test("a clean verdict is never eligible", () => {
		expect(isEligibleForAutoDelete(msg(), verdict({ status: "clean" }))).toBe(
			false,
		)
	})

	// The middle tier is gone rather than merged into `deleted`. A verdict that
	// says "warn" is not a soft deletion waiting for a review — it is a value the
	// parser never emits, and the enforcer must not act on one if it ever sees it.
	test("an unknown status is never eligible, not even a warn/flagged-shaped one", () => {
		for (const status of ["warn", "flagged", "", "DELETED", "review"]) {
			expect(isEligibleForAutoDelete(msg(), verdict({ status }))).toBe(false)
		}
	})

	test("an error verdict is never eligible", () => {
		// "Could not judge" is not evidence of a violation, and deleting on it is
		// unrecoverable: the content is gone and the judgement never happened.
		expect(isEligibleForAutoDelete(msg(), verdict({ status: "error" }))).toBe(
			false,
		)
	})

	// The regression this guards: an `analyzed` message with a deleted verdict
	// must still be deletable. After the rewrite `analyzed` is the pipeline's
	// terminal state, so gating on it (as the old code did) would silently stop
	// every deletion.
	test("a verdict is judged on its own status, not the pipeline's", () => {
		const m = msg({ ai_status: "analyzed" })
		expect(isEligibleForAutoDelete(m, verdict())).toBe(true)
	})

	// A confidence gate is not a severity tier: it does not decide WHETHER a
	// violation occurred, only whether the model was sure enough for the removal
	// to be automatic. So it must survive the removal of severity intact.
	test("a deleted verdict at low confidence is not eligible", () => {
		// This replaces the deleted `deriveSeverity` score-threshold suite. The
		// question those tests asked — "is this bad enough?" — is answered by
		// `status` alone now, so the surviving question is "was the model sure?",
		// and the answer still has to gate the delete.
		expect(
			isEligibleForAutoDelete(
				msg(),
				verdict({ confidence: 0.49, score: 0.49 }),
			),
		).toBe(false)
		// Boundary: AUTO_DELETE_MIN_CONFIDENCE defaults to 0.5, and the gate is
		// `< threshold`, so exactly at the bar still deletes.
		expect(
			isEligibleForAutoDelete(msg(), verdict({ confidence: 0.5, score: 0.5 })),
		).toBe(true)
	})

	test("confidence falls back to score when the verdict carries no confidence", () => {
		expect(
			isEligibleForAutoDelete(msg(), verdict({ confidence: null, score: 0.9 })),
		).toBe(true)
		expect(
			isEligibleForAutoDelete(msg(), verdict({ confidence: null, score: 0.1 })),
		).toBe(false)
	})

	test("a deleted verdict with neither confidence nor score is not eligible", () => {
		expect(
			isEligibleForAutoDelete(
				msg(),
				verdict({ confidence: null, score: null }),
			),
		).toBe(false)
	})

	test("falls back to legacy ai_* columns when no verdict row exists", () => {
		// Legacy `messages.ai_*` is only consulted for rows the backfill has not
		// reached. `readVerdict` maps `ai_status` onto `status`, so an
		// already-analysed legacy row reads its judgement from `ai_status`.
		const legacy = msg({
			ai_status: "deleted",
			ai_confidence: 0.99,
			ai_categories: "harassment",
		})
		expect(isEligibleForAutoDelete(legacy, null)).toBe(true)
	})

	test("a legacy row whose ai_status is not a deletion is not eligible", () => {
		const legacy = msg({
			ai_status: "analyzed",
			ai_confidence: 0.99,
			ai_categories: "harassment",
		})
		// `analyzed` is the queue state and says nothing about the outcome, so a
		// legacy row that never got a real judgement must not delete on it.
		expect(isEligibleForAutoDelete(legacy, null)).toBe(false)
	})

	test("a pending message with no verdict is not eligible", () => {
		expect(isEligibleForAutoDelete(msg({ ai_status: "pending" }), null)).toBe(
			false,
		)
	})

	test("a message with no verdict and no legacy columns is not eligible", () => {
		expect(isEligibleForAutoDelete(msg(), null)).toBe(false)
	})
})

/**
 * The flag-spelling defect.
 *
 * `policy.ts` instructs the model to emit `offensive_nickname`. The nickname
 * classifier matched only `offensive_username`, so its flag path was
 * unreachable for every row the shipped prompt produces, and the classifier
 * fell through to prose-matching that prod's analysis text never satisfied.
 *
 * The consequence was not a missed reset — it was a DELETED MESSAGE. With
 * `isNicknameOnlyViolation` false on a verdict whose `action` was
 * `reset_nickname` and whose `status` was `deleted`, the manager took the
 * "body violates too" branch and fell through to the delete path, removing the
 * message while leaving the nickname untouched. Production: 51 such verdicts,
 * 7 of their messages deleted, and ZERO "Offensive nickname reset" log lines.
 */
describe("isNicknameOnlyViolation — the offensive_nickname flag is the one the prompt emits", () => {
	/** Verbatim prod: 51 rows carry exactly this flag. */
	const prodPromoNickname = JSON.stringify({
		member: {
			nickname: "Cara sukses modal jual kelas AI",
			displayName: "Cara sukses modal jual kelas AI",
		},
	})

	test("offensive_nickname alone is a nickname violation", () => {
		expect(
			isNicknameOnlyViolation(
				msg({ content: "Udh berapa lama ga repasta" }),
				verdict({
					flags: ["offensive_nickname"],
					analysis: "Nickname mengandung promosi komersial.",
				}),
			),
		).toBe(true)
	})

	test("a promo nickname with no insult term is still caught by the flag", () => {
		// This is the row that was deleted in prod. The nickname contains no
		// insult term, so the evidence path (`nicknameCarriesInsult`) can never
		// see it — the FLAG is the only thing that can classify it, which is
		// exactly why the missing spelling mattered.
		expect(
			isNicknameOnlyViolation(
				msg({ content: "Ohh", metadata: prodPromoNickname }),
				verdict({
					flags: ["offensive_nickname"],
					analysis:
						"Nickname pengguna mengandung promosi komersial ('Cara sukses modal jual kelas AI'), sedangkan isi pesan 'Ohh' adalah tanggapan singkat yang bersih.",
				}),
			),
		).toBe(true)
	})

	test("offensive_nickname alongside another name flag needs corroborating prose", () => {
		// A mixed flag set is NOT decided by the flags alone, and that is the
		// pre-existing contract: `identity_attack` also describes a BODY that
		// turns on the reader's identity, so the prose must corroborate that the
		// violation sits in the name. Path 1 stays deliberately narrow — the
		// clean name-flag set — while this combination goes through path 2.
		expect(
			isNicknameOnlyViolation(
				msg(),
				verdict({ flags: ["offensive_nickname", "identity_attack"] }),
			),
		).toBe(false)

		// Corroborated, the same flags are a name violation.
		expect(
			isNicknameOnlyViolation(
				msg(),
				verdict({
					flags: ["offensive_nickname", "identity_attack"],
					analysis: "nickname mengandung kata ofensif; isi pesan bersih",
				}),
			),
		).toBe(true)
	})

	test("the model cannot use the flag as a jail card for a rude body", () => {
		// `policy.ts` says a body that violates in its own right must not carry
		// the name flag, but a contract the model can break is not a guard.
		// Making the flag reachable without this half would spare any abusive
		// message that also claimed a nickname problem.
		expect(
			isNicknameOnlyViolation(
				msg({ content: "dasar kontol cuking" }),
				verdict({ flags: ["offensive_nickname"] }),
			),
		).toBe(false)
	})

	test("an unrelated flag is not a nickname violation", () => {
		expect(
			isNicknameOnlyViolation(
				msg(),
				verdict({ flags: ["harassment", "violence"] }),
			),
		).toBe(false)
	})
})

/**
 * Exempt roles.
 *
 * These are the server's admin roles. Discord refuses a nickname change against
 * a member whose top role sits above the account's (`50013 Missing
 * Permissions`), so enforcement was attempted and rejected on every message —
 * 48 of 59 `moderation_actions` rows in production are `failed`.
 *
 * Keyed on ROLE, not user: a role list covers a newly-appointed admin the
 * moment they get the role, where a user list would silently start failing
 * again at the next appointment.
 */
describe("holdsExemptRole", () => {
	const EXEMPT = "1504423881849442354"
	const OTHER_EXEMPT = "1206223343905148959"

	const withRoles = (ids: string[]) =>
		JSON.stringify({
			member: {
				nickname: "adit cuking",
				displayName: "adit cuking",
				roles: ids.map((id) => ({ id, name: "role", position: 84 })),
			},
		})

	test("a holder of either configured role is exempt", () => {
		// Both ids are the schema defaults, so this asserts the shipped config
		// rather than a fixture-only value.
		expect(holdsExemptRole(msg({ metadata: withRoles([EXEMPT]) }))).toBe(true)
		expect(holdsExemptRole(msg({ metadata: withRoles([OTHER_EXEMPT]) }))).toBe(
			true,
		)
	})

	test("the role is found among unrelated roles", () => {
		expect(
			holdsExemptRole(msg({ metadata: withRoles(["1", "2", EXEMPT, "3"]) })),
		).toBe(true)
	})

	test("an ordinary member is not exempt", () => {
		expect(holdsExemptRole(msg({ metadata: withRoles(["12345"]) }))).toBe(false)
	})

	test("a JSON STRING is read, because that is the wire shape", () => {
		// `messages.metadata` is a TEXT column, so the enforcer passes a string.
		// The nickname guard shipped inert once by testing the parsed object
		// only; the same trap applies here.
		expect(typeof withRoles([EXEMPT])).toBe("string")
		expect(holdsExemptRole(msg({ metadata: withRoles([EXEMPT]) }))).toBe(true)
	})

	test("a parsed object works too, for direct callers", () => {
		expect(
			holdsExemptRole(
				msg({ metadata: { member: { roles: [{ id: EXEMPT }] } } }),
			),
		).toBe(true)
	})

	test("missing, malformed and empty metadata are all non-exempt", () => {
		// Fail OPEN here, unlike a safety guard: an unreadable metadata means
		// "no exempt role", and the alternative — exempting every message whose
		// metadata failed to parse — would disable enforcement server-wide.
		for (const metadata of [
			null,
			undefined,
			"",
			"{}",
			"{not json",
			JSON.stringify({ member: null }),
			JSON.stringify({ member: {} }),
			JSON.stringify({ member: { roles: null } }),
			JSON.stringify({ member: { roles: "not-an-array" } }),
			JSON.stringify({ member: { roles: [null, 42, {}] } }),
		]) {
			expect(holdsExemptRole(msg({ metadata }))).toBe(false)
		}
	})

	test("an exempt role does NOT block message deletion", () => {
		// The correction this encodes: the exemption is a statement about what
		// the account CAN do — Discord refuses `setNickname` against a member
		// whose highest role outranks the bot's own. It says nothing about
		// deleting, which this account is perfectly able to do.
		//
		// So an exempt member's violating message still goes. Only the nickname
		// reset is skipped, and the gate for that lives in the manager
		// (`applyNicknameReset`), not here. Gating deletion on the role would
		// hand every admin a licence to post anything.
		expect(
			isEligibleForAutoDelete(
				msg({ metadata: withRoles([EXEMPT]) }),
				verdict({ status: "deleted", confidence: 0.99 }),
			),
		).toBe(true)
		expect(
			isEligibleForAutoDelete(
				msg({ metadata: withRoles([OTHER_EXEMPT]) }),
				verdict({ status: "deleted", confidence: 0.99 }),
			),
		).toBe(true)
		// The negative control, unchanged in both directions: an ordinary
		// member is eligible too, so this is not measuring the exemption at all.
		expect(
			isEligibleForAutoDelete(
				msg({ metadata: withRoles(["12345"]) }),
				verdict({ status: "deleted", confidence: 0.99 }),
			),
		).toBe(true)
	})
})

describe("isNameImplicated", () => {
	test("the two categories that name the NAME implicate it", () => {
		for (const flag of ["offensive_nickname", "offensive_username"]) {
			expect(isNameImplicated(msg(), verdict({ flags: [flag] }))).toBe(true)
			expect(isNameImplicated(msg(), verdict({ categories: [flag] }))).toBe(
				true,
			)
		}
	})

	test("a content category does not implicate the name on its own", () => {
		// `identity_attack` and `name_targeting` also describe a body that turns
		// on the reader's identity, so treating them as name evidence would
		// reset the nickname of a member whose MESSAGE was the problem.
		for (const flag of [
			"harassment",
			"identity_attack",
			"name_targeting",
			"nsfw",
		]) {
			expect(isNameImplicated(msg(), verdict({ flags: [flag] }))).toBe(false)
		}
	})

	test("a category-only row is still caught, with flags left empty", () => {
		// The shape a parser that fills `categories` and not `flags` writes, and
		// the reason this predicate reads the EFFECTIVE categories: reading the
		// raw `flags` array would report no name involvement for a row whose
		// action is a nickname reset.
		expect(
			isNameImplicated(
				msg(),
				verdict({ categories: ["offensive_nickname"], flags: [] }),
			),
		).toBe(true)
	})

	test("a flagged promo nickname with no insult term is still caught", () => {
		// The text cannot reveal this one — there is no rude word at all — so
		// only the model's category can. This is why both halves of the
		// predicate are needed.
		const promo = msg({
			metadata: JSON.stringify({
				member: { nickname: "Cara sukses modal jual kelas AI" },
			}),
		})
		expect(isNameImplicated(promo, verdict({ flags: [] }))).toBe(false)
		expect(
			isNameImplicated(promo, verdict({ flags: ["offensive_nickname"] })),
		).toBe(true)
	})

	test("an insult term in the captured nickname implicates it without a category", () => {
		expect(
			isNameImplicated(msg(), verdict({ flags: [], categories: [] })),
		).toBe(false)
		const rude = msg({
			metadata: JSON.stringify({ member: { nickname: "adit cuking" } }),
		})
		expect(isNameImplicated(rude, verdict({ flags: [], categories: [] }))).toBe(
			true,
		)
	})

	test("a clean verdict implicates nothing", () => {
		expect(
			isNameImplicated(msg(), verdict({ flags: [], categories: [] })),
		).toBe(false)
		expect(isNameImplicated(msg(), null)).toBe(false)
	})
})

describe("isNicknameOnlyViolation", () => {
	test("an offensive_username-only flag is a nickname violation", () => {
		expect(
			isNicknameOnlyViolation(
				msg(),
				verdict({ flags: ["offensive_username"] }),
			),
		).toBe(true)
	})

	test("a content flag is not a nickname violation", () => {
		expect(
			isNicknameOnlyViolation(msg(), verdict({ flags: ["harassment"] })),
		).toBe(false)
	})

	test("no flags at all is not a nickname violation", () => {
		expect(isNicknameOnlyViolation(msg(), verdict({ flags: [] }))).toBe(false)
	})

	test("username-attributable flags plus corroborating analysis text", () => {
		expect(
			isNicknameOnlyViolation(
				msg(),
				verdict({
					flags: ["offensive_username", "identity_attack"],
					analysis: "username mengandung katatofensif; isi pesan bersih",
				}),
			),
		).toBe(true)
	})

	test("username-attributable flags but analysis blames the content", () => {
		expect(
			isNicknameOnlyViolation(
				msg(),
				verdict({
					flags: ["offensive_username", "identity_attack"],
					analysis: "isi pesan mengandung kata kasar yang=swap dan juga umpan",
				}),
			),
		).toBe(false)
	})
})

/**
 * Regression: the guard existed but the model routed around it by WORDING.
 *
 * Prod row (user 1052035456688205854, nickname "adit cuking", body "Nandayo"):
 * the verdict flagged plain `harassment`, cited the NICKNAME as the violation,
 * and the pipeline DELETED THE MESSAGE instead of resetting the name.
 *
 * Both prose paths failed at once, for reasons that have nothing to do with
 * severity:
 *   - the flag was `harassment`, which is not in USERNAME_ATTRIBUTABLE_FLAGS
 *   - "mengandung" came BEFORE "nickname", and the pattern required the reverse
 *   - the analysis never volunteered that the message itself was clean
 *
 * So the decision is now also checked against the NICKNAME and BODY themselves,
 * which the model cannot reword. Fixtures below are verbatim prod values.
 */
describe("isNicknameOnlyViolation — evidence-based path", () => {
	/**
	 * STRING, not an object. `messages.metadata` is a `text` column, so the
	 * enforcer passes a JSON string. The first version of this suite passed a
	 * parsed object, so it proved the arithmetic while the real input silently
	 * returned null — the guard was inert in production and messages were deleted
	 * over a nickname that survived. Every fixture below is a string on purpose.
	 */
	const rudeNick = JSON.stringify({
		member: { nickname: "adit cuking", displayName: "adit cuking" },
	})

	test("a JSON STRING metadata on the wire is still read", () => {
		// Verbatim prod analysis, and the verbatim prod flag: plain `harassment`.
		const analysis =
			"Pesan mengandung sindiran pribadi melalui nickname 'adit cuking' yang sudah ditandai sebagai hinaan dalam memori kanal. Pengguna menggunakan nama panggilan yang sudah diketahui moderasi sebagai pelanggaran harassment tingkat medium. Pesan 'Nandayo' adalah cara mengekspresikan ketidakpuasan atau sindiran terhadap diri sendiri menggunakan kata 'cuking' yang merupakan hinaan pribadi."

		expect(
			isNicknameOnlyViolation(
				msg({ content: "Nandayo", metadata: rudeNick }),
				verdict({ flags: ["harassment"], analysis }),
			),
		).toBe(true)
	})

	test("a parsed object still works, for direct callers", () => {
		expect(
			isNicknameOnlyViolation(
				msg({
					content: "Nandayo",
					metadata: { member: { nickname: "adit cuking" } },
				}),
				verdict({
					flags: ["harassment"],
					analysis: "Pesan mengandung sindiran.",
				}),
			),
		).toBe(true)
	})

	test("a rude body is still a deletable message violation", () => {
		// The nickname is rude AND the message is rude. The message must remain
		// deletable — the nickname reset is not a get-out-of-jail card.
		expect(
			isNicknameOnlyViolation(
				msg({ content: "kamu kontol", metadata: rudeNick }),
				verdict({
					flags: ["harassment"],
					analysis: "isi pesan mengandung kata kasar",
				}),
			),
		).toBe(false)
	})

	test("a rude nickname with no insults in the body, empty flags", () => {
		// No flags at all used to mean "cannot be a nickname violation". The
		// evidence path must not depend on the model choosing a flag.
		expect(
			isNicknameOnlyViolation(
				msg({ content: "halo semua", metadata: rudeNick }),
				verdict({ flags: [], analysis: "" }),
			),
		).toBe(true)
	})

	test("a clean nickname and clean body stay deletable", () => {
		expect(
			isNicknameOnlyViolation(
				msg({
					content: "Nandayo",
					metadata: { member: { nickname: "rama_adityo" } },
				}),
				verdict({
					flags: ["harassment"],
					analysis: "Pesan mengandung sindiran pribadi.",
				}),
			),
		).toBe(false)
	})

	test("no captured nickname leaves the prose paths in charge", () => {
		expect(
			isNicknameOnlyViolation(
				msg({ content: "Nandayo", metadata: { member: {} } }),
				verdict({
					flags: ["harassment"],
					analysis: "Pesan mengandung sindiran pribadi.",
				}),
			),
		).toBe(false)
	})
})
