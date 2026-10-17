/**
 * Enforcement follows the violation CATEGORY, and the nickname reset is real.
 *
 * ## Why this suite exists
 *
 * Two independent defects, both of which deleted a message over a nickname:
 *
 *  1. `verdicts.status` is two-valued, so it cannot say "the violation is in the
 *     member's nickname and this message must stay". The enforcer recovered that
 *     intent by regex-matching the model's own analysis prose — and production
 *     defeated it:
 *
 *         user 1052035456688205854, nickname "adit cuking", body "Nandayo"
 *         verdict: flags ["harassment"], analysis "Pesan mengandung sindiran
 *                   pribadi melalui nickname 'adit cuking' ..."
 *         -> MESSAGE DELETED, nickname left alone
 *
 *  2. The reset was never applied even in the nickname-only case. Production had
 *     51 verdicts categorised `offensive_nickname`, 7 of their messages deleted,
 *     ZERO successful resets, and 48 of 59 `moderation_actions` rows recorded as
 *     `failed`.
 *
 * The fix is that enforcement is DERIVED from the violation category rather than
 * chosen by the model, and that the nickname reset actually runs. This suite
 * covers the outcomes the category produces and the invariants that keep it
 * safe: evidence can override a miscategorised name violation, no `reset_nickname`
 * can spare a rude body, and the exempt-role gate skips only the RESET.
 *
 * Everything is mocked at the boundary — the Discord client, the moderation
 * store, the notifier, the mod-channel logger. No database, no network, no real
 * Discord call. The assertions are on what the manager DECIDED and what it
 * recorded, not on how many times a function ran.
 */
import { beforeEach, describe, expect, test, vi } from "vitest"

// ── Boundary mocks ────────────────────────────────────────────────
// Registered before importing the manager, because the manager captures these
// bindings at module load.
//
// `vi.hoisted` is REQUIRED here, not stylistic. Vitest statically hoists every
// `vi.mock` call to the top of the file — above the imports — so a factory that
// closed over a plain `const` would run in the temporal dead zone. bun's
// `mock.module` was a runtime call with no hoisting, which is why this file
// could declare the arrays inline. `vi.hoisted` lifts them above the mocks so
// the factories, and the `beforeEach` reset below, see the same instances.
const { moderationActions, loggerCalls } = vi.hoisted(() => ({
	moderationActions: [] as Array<Record<string, unknown>>,
	loggerCalls: [] as string[],
}))

vi.mock(
	"../src/infrastructure/modules-gateway/message-capture/messageStore.js",
	() => ({
		messageStore: {
			async createModerationAction(action: Record<string, unknown>) {
				moderationActions.push(action)
				return action
			},
			async updateMessageAsDeleted() {
				return null
			},
		},
	}),
)

vi.mock(
	"../src/infrastructure/modules-gateway/ai-moderation/autoDeleteLogger.js",
	() => ({
		logDeletionToChannel: async () => {
			loggerCalls.push("channel-logged")
		},
		logAlreadyDeleted: async () => {
			loggerCalls.push("already-deleted-logged")
		},
	}),
)

const { attemptAutoDeleteFlaggedMessage } = await import(
	"../src/infrastructure/modules-gateway/ai-moderation/autoDeleteManager.js"
)
type VerdictLike =
	import("../src/infrastructure/modules-gateway/ai-moderation/autoDeleteEligibility.js").VerdictLike
type AutoDeleteInput =
	import("../src/infrastructure/modules-gateway/ai-moderation/autoDeleteManager.js").AutoDeleteInput

/**
 * `messages.metadata` is a TEXT column, so the real enforcer receives a JSON
 * STRING. The first version of the evidence suite passed a parsed object and the
 * guard was inert in production, so every fixture here is `JSON.stringify`'d on
 * purpose — a test that never sees the wire shape cannot catch this.
 *
 * Verbatim prod values: nickname "adit cuking", body "Nandayo".
 */
const PROD_NICKNAME_METADATA = JSON.stringify({
	member: { nickname: "adit cuking", displayName: "adit cuking" },
})

/** Verbatim prod analysis: plain `harassment` flag, nickname blamed in prose. */
const PROD_ANALYSIS =
	"Pesan mengandung sindiran pribadi melalui nickname 'adit cuking' yang " +
	"sudah ditandai sebagai hinaan dalam memori kanal. Pengguna menggunakan nama " +
	"panggilan yang sudah diketahui moderasi sebagai pelanggaran harassment tingkat " +
	"medium. Pesan 'Nandayo' adalah cara mengekspresikan ketidakpuasan atau sindiran " +
	"terhadap diri sendiri menggunakan kata 'cuking' yang merupakan hinaan pribadi."

/**
 * A fresh member identity per message.
 *
 * `recentNicknameResets` is a MODULE-LEVEL LRU keyed on `guild_id:user_id`
 * with a 10-minute TTL, and it is the real production cooldown guard — so
 * without this, the first test in the file consumes the cooldown and every
 * later one silently skips its reset. That is a real coupling, not a test
 * artefact: it is exactly why the manager keeps that cache. The `messageId` and
 * the captured nickname are unchanged from prod; only the user id varies.
 */
let userSeq = 0
function nextUserId(): string {
	userSeq += 1
	return `10520354566882058${String(userSeq).padStart(2, "0")}`
}

function message(overrides: Partial<AutoDeleteInput> = {}): AutoDeleteInput {
	return {
		id: "1554472364094521396",
		guild_id: "g1",
		channel_id: "c1",
		// Unique per call, so the production nickname-reset cooldown never carries
		// between tests. See `nextUserId`.
		user_id: nextUserId(),
		thread_id: null,
		username: "adit",
		content: "Nandayo",
		metadata: null,
		...overrides,
	}
}

/**
 * A stored verdict row.
 *
 * `categories` mirrors `flags` when a caller overrides only one of them, because
 * that is the shape the PARSER writes: `categories` falls back to `flags`, and
 * the enforcement is derived from that effective value. A fixture that set
 * `flags: ["offensive_nickname"]` while leaving `categories: ["harassment"]`
 * would describe a row the worker cannot produce — and the mismatch is precisely
 * what the category-driven enforcement is meant to resolve.
 */
function verdict(overrides: Partial<VerdictLike> = {}): VerdictLike {
	const base: VerdictLike = {
		status: "deleted",
		confidence: 0.95,
		score: 0.62,
		categories: ["harassment"],
		flags: ["harassment"],
		analysis: "contains abusive language",
	}
	const merged: VerdictLike = { ...base, ...overrides }
	if (overrides.flags !== undefined && overrides.categories === undefined) {
		merged.categories = overrides.flags
	}
	if (overrides.categories !== undefined && overrides.flags === undefined) {
		merged.flags = overrides.categories
	}
	return merged
}

/**
 * A Discord client just complete enough for the delete path: a guild with one
 * channel that reports Manage Messages, a fetchable message whose `delete()` is
 * recorded, and two fetchable members (the target, then the bot's own).
 */
function fakeClient() {
	const deleted: string[] = []
	const nicknames: Array<string | null> = []
	const targetMember = {
		manageable: true,
		setNickname: async (value: string | null) => {
			nicknames.push(value)
		},
		user: { id: "1052035456688205854", username: "adit" },
	}
	const channel = {
		permissionsFor: () => ({ has: () => true }),
		messages: {
			fetch: async (id: string) => ({
				delete: async () => {
					deleted.push(id)
				},
			}),
		},
		send: async () => undefined,
	}
	const guild = {
		name: "GMW test",
		channels: { cache: new Map([["c1", channel]]) },
		channelsFetch: async () => undefined,
		members: {
			// Any id resolves to the target member: the manager only ever fetches the
			// message author and the bot's own account, and `user_id` varies per test
			// to defeat the production cooldown cache.
			fetch: async () => targetMember,
		},
	}
	return {
		deleted,
		nicknames,
		client: {
			user: { id: "bot1" },
			guilds: { cache: new Map([["g1", guild]]) },
		} as never,
	}
}

function lastAction(): Record<string, unknown> | undefined {
	return moderationActions[moderationActions.length - 1]
}

beforeEach(() => {
	moderationActions.length = 0
	loggerCalls.length = 0
})

/**
 * The prod defect this suite exists to pin: the nickname reset never ran.
 *
 * Journal evidence from the incident: 51 lines reading "Model chose
 * reset_nickname but the message body violates too — nickname reset AND message
 * delete both applied", and ZERO "Offensive nickname reset to default username"
 * lines. The `if` branch logged that a reset had been applied while never
 * calling `resetOffensiveNickname` — it only existed in the `else`. So for a
 * member whose name AND body both violated, the message was deleted and the
 * name was left as it was, under a log line asserting the opposite.
 *
 * Two independent failures had to line up for that:
 *   1. the flag spelling (`offensive_nickname` vs `offensive_username`) made
 *      `isNicknameOnlyViolation` false for the rows the prompt produces, and
 *   2. the branch for "body violates too" skipped the reset entirely.
 */
describe("a nickname violation is enforced even when the message is also deleted", () => {
	/** Verbatim prod: nickname and body both carry an insult term. */
	const BOTH_RUDE_METADATA = JSON.stringify({
		member: { nickname: "adit cuking", displayName: "adit cuking" },
	})

	test("the nickname is reset AND the message deleted, with both audited", async () => {
		const { client, deleted, nicknames } = fakeClient()

		const result = await attemptAutoDeleteFlaggedMessage(
			client,
			message({
				// The body carries an insult term, so `isNicknameOnlyViolation` is
				// false by design — this is the mixed case, not the name-only one.
				content: "dasar goblok",
				metadata: BOTH_RUDE_METADATA,
			}),
			verdict({
				status: "deleted",
				action: "reset_nickname",
				flags: ["offensive_nickname"],
				confidence: 0.99,
			}),
		)

		// The abusive message still goes — the `action` field is not a veto.
		expect(result.deleted).toBe(true)
		expect(deleted).toEqual(["1554472364094521396"])

		// And the NAME is corrected, which is the half that was silently skipped.
		expect(nicknames).toEqual([null])

		// Both facts are on the record. The reset row is what proves the name was
		// touched rather than merely logged as having been.
		const resetRow = moderationActions.find(
			(row) => row.action_type === "reset_nickname",
		)
		expect(resetRow).toBeDefined()
		expect(resetRow?.status).toBe("executed")
		expect(resetRow?.executed_at).not.toBeNull()
		expect(resetRow?.reason).toContain("nickname direset")
		expect(
			moderationActions.some((row) => row.action_type === "delete_message"),
		).toBe(true)
	})

	test("a clean name beside a rude body is not renamed, only deleted", async () => {
		// The reset is not unconditional: it fires on the name-only evidence OR
		// on the model's `reset_nickname` disposition, which this case lacks.
		// Renaming here would be enforcement nobody asked for.
		const { client, deleted, nicknames } = fakeClient()

		const result = await attemptAutoDeleteFlaggedMessage(
			client,
			message({
				content: "dasar goblok",
				metadata: JSON.stringify({
					member: { nickname: "rama_adityo", displayName: "rama_adityo" },
				}),
			}),
			verdict({
				status: "deleted",
				action: "delete_message",
				flags: ["harassment"],
				confidence: 0.99,
			}),
		)

		expect(result.deleted).toBe(true)
		expect(deleted).toEqual(["1554472364094521396"])
		expect(nicknames).toEqual([])
		expect(
			moderationActions.some((row) => row.action_type === "reset_nickname"),
		).toBe(false)
	})
})

/**
 * Exempt roles: the account cannot enforce against these members at all.
 *
 * Discord answers `50013 Missing Permissions` for any nickname change against a
 * member whose top role sits above the account's, so every attempt was a doomed
 * PATCH. In production 48 of 59 `moderation_actions` rows are `status='failed'`
 * for exactly that reason — the audit trail was mostly records of actions the
 * account is structurally unable to perform.
 */
describe("exempt roles skip the RESET, never the deletion", () => {
	const EXEMPT_ROLE = "1504423881849442354"

	const exemptMetadata = (nickname: string) =>
		JSON.stringify({
			member: {
				nickname,
				displayName: nickname,
				roles: [{ id: EXEMPT_ROLE, name: "Paladin", position: 84 }],
			},
		})

	// The corrected scope of the exemption. It exists because Discord refuses
	// `setNickname` (50013) for a member whose top role outranks the account's —
	// it is a statement about what this account CAN do, and it says nothing
	// about deleting, which needs `MANAGE_MESSAGES` in the channel and is
	// checked separately below.
	//
	// The earlier version returned early from `isEligibleForAutoDelete`, which
	// also blocked the deletion. That exempted the server's admins from
	// moderation entirely — precisely the members most able to abuse it.
	test("an exempt member's violating message is still deleted", async () => {
		const { client, deleted } = fakeClient()

		const result = await attemptAutoDeleteFlaggedMessage(
			client,
			message({
				content: "dasar goblok",
				metadata: exemptMetadata("rama_adityo"),
			}),
			verdict({ status: "deleted", confidence: 0.99 }),
		)

		expect(result.deleted).toBe(true)
		expect(result.reason).toBe("deleted")
		expect(deleted).toEqual(["1554472364094521396"])
	})

	test("a nickname reset is skipped for an exempt member, and the message stays", async () => {
		const { client, nicknames, deleted } = fakeClient()

		const result = await attemptAutoDeleteFlaggedMessage(
			client,
			message({
				content: "Nandayo",
				metadata: exemptMetadata("adit cuking"),
			}),
			verdict({
				status: "deleted",
				categories: ["offensive_nickname"],
				flags: ["offensive_nickname"],
				analysis: "Nickname mengandung kata kasar; isi pesan bersih.",
			}),
		)

		// Not even attempted: Discord would refuse the PATCH, and a refusal
		// recorded as `failed` is the noise this exemption removes.
		expect(nicknames).toEqual([])
		// The message is kept, because a nickname violation is enforced on the
		// name — there is nothing wrong with the body to delete.
		expect(deleted).toEqual([])
		expect(result.reason).toBe("nickname_reset_exempt_role")
	})

	test("an ordinary member's nickname IS reset", async () => {
		// The negative control: if the exemption matched everyone, the test
		// above would pass while every reset was silently dead server-wide.
		const { client, nicknames } = fakeClient()

		await attemptAutoDeleteFlaggedMessage(
			client,
			message({
				content: "Nandayo",
				metadata: JSON.stringify({
					member: {
						nickname: "adit cuking",
						roles: [{ id: "999", name: "Member", position: 3 }],
					},
				}),
			}),
			verdict({
				status: "deleted",
				categories: ["offensive_nickname"],
				flags: ["offensive_nickname"],
				analysis: PROD_ANALYSIS,
			}),
		)

		expect(nicknames).toEqual([null])
	})

	test("an ordinary member is still enforced against", async () => {
		// The other negative control, for the deletion half: the role must not
		// change what happens to a violating BODY either way.
		const { client, deleted } = fakeClient()

		const plain = await attemptAutoDeleteFlaggedMessage(
			client,
			message({
				content: "dasar goblok",
				// Same shape as the exempt fixture, only the role id differs.
				metadata: JSON.stringify({
					member: {
						nickname: "rama_adityo",
						roles: [{ id: "999", name: "Member", position: 3 }],
					},
				}),
			}),
			verdict({ status: "deleted", confidence: 0.99 }),
		)

		expect(plain.deleted).toBe(true)
		expect(plain.reason).toBe("deleted")
		expect(deleted).toEqual(["1554472364094521396"])
	})
})

describe("the CATEGORY chooses the outcome", () => {
	// 1. The headline case: the model says reset_nickname, and the name-only
	//    evidence is a rude nickname with a clean body — the exact prod row. The
	//    message must survive and the nickname must be reset.
	test("action reset_nickname takes the nickname-reset path and keeps the message", async () => {
		const { client, nicknames } = fakeClient()

		const result = await attemptAutoDeleteFlaggedMessage(
			client,
			message({
				content: "Nandayo",
				metadata: PROD_NICKNAME_METADATA,
			}),
			verdict({
				status: "deleted",
				action: "reset_nickname",
				flags: ["offensive_nickname"],
				analysis: "Nickname mengandung kata kasar 'cuking'; isi pesan bersih.",
			}),
		)

		expect(result.deleted).toBe(false)
		expect(result.reason).toBe("nickname_only_violation")
		expect(nicknames).toEqual([null])
		expect(lastAction()?.action_type).toBe("reset_nickname")
		expect(lastAction()?.status).toBe("executed")
	})

	// The pure-category path: a nickname with NO insult term in it — a promo name
	// — where the captured text cannot reveal the violation at all. Only the
	// model's CATEGORY can classify it, and that is the whole reason the category
	// is what enforcement reads. The message must survive and the name reset.
	test("a category-only name violation is enforced without textual evidence", async () => {
		const { client, nicknames, deleted } = fakeClient()

		const result = await attemptAutoDeleteFlaggedMessage(
			client,
			// A nickname with no insult term in it: `nicknameCarriesInsult` is
			// FALSE here, so only the model's category can produce this outcome.
			message({
				content: "halo semua",
				metadata: JSON.stringify({
					member: { nickname: "rama_adityo", displayName: "rama_adityo" },
				}),
			}),
			verdict({
				status: "deleted",
				categories: ["offensive_nickname"],
				flags: ["offensive_nickname"],
				analysis: "Nickname melanggar aturan; isi pesan bersih.",
			}),
		)

		expect(result.deleted).toBe(false)
		// The category derives `reset_nickname`, so the name branch is taken and
		// reports itself by its category-derived name. No `model_action_*` label
		// exists any more: the model does not choose.
		expect(result.reason).toBe("nickname_only_violation")
		expect(deleted).toEqual([])
		expect(nicknames).toEqual([null])
		expect(lastAction()?.action_type).toBe("reset_nickname")
	})

	// The invariant, stated correctly. `reset_nickname` never SPARES a message
	// that violates in its own right — but that is not the same as "never
	// deletes". This case has `metadata: null` (no nickname to reset at all) and a
	// body that is itself an insult, so there is no name-only violation to
	// enforce: the message is deleted.
	//
	// The previous version of this test asserted `deleted === false` here, which
	// contradicted its sibling ("a rude body still deletes") and encoded the
	// jail-card bug as if it were a requirement: naming `reset_nickname` would
	// have kept ANY message.
	test("action reset_nickname cannot spare a body that violates on its own", async () => {
		const { client, deleted } = fakeClient()

		const result = await attemptAutoDeleteFlaggedMessage(
			client,
			message({ content: "kamu kontol", metadata: null }),
			verdict({
				status: "deleted",
				action: "reset_nickname",
				confidence: 0.99,
				categories: ["harassment"],
				analysis: "hinaan di isi pesan",
			}),
		)

		expect(result.deleted).toBe(true)
		expect(deleted).toHaveLength(1)
		// No nickname exists, so nothing was reset — only the message went.
		expect(lastAction()?.action_type).toBe("delete_message")
	})

	// 2. THE REGRESSION THAT SHIPPED. The model says delete_message, but the
	//    evidence says the only problem is the nickname and the body is clean.
	//    The evidence wins: nickname reset, message kept.
	test("action delete_message is overridden to a reset when the nickname is the only violation", async () => {
		const { client, nicknames, deleted } = fakeClient()

		const result = await attemptAutoDeleteFlaggedMessage(
			client,
			message({
				content: "Nandayo",
				metadata: PROD_NICKNAME_METADATA,
			}),
			// Verbatim prod verdict: plain `harassment`, nickname blamed in prose.
			verdict({
				status: "deleted",
				action: "delete_message",
				analysis: PROD_ANALYSIS,
			}),
		)

		expect(result.deleted).toBe(false)
		expect(result.reason).toBe("nickname_only_violation")
		expect(deleted).toEqual([])
		expect(nicknames).toEqual([null])
		expect(lastAction()?.action_type).toBe("reset_nickname")
	})

	// The override is not a blanket "always reset": a rude BODY is a real message
	// violation, and the nickname reset is not a get-out-of-jail card. This is the
	// other half of the same guard, and the reason both halves are required.
	test("action reset_nickname does not spare a message whose own body violates", async () => {
		const { client, deleted } = fakeClient()

		const result = await attemptAutoDeleteFlaggedMessage(
			client,
			message({
				content: "dasar kontol cuking",
				metadata: PROD_NICKNAME_METADATA,
			}),
			verdict({
				status: "deleted",
				action: "reset_nickname",
				analysis: PROD_ANALYSIS,
			}),
		)

		// The body carries an insult term, so `isNicknameOnlyViolation` is false and
		// `status: "deleted"` is what authorises the delete. `action` cannot veto it,
		// because honouring `reset_nickname` here would be the jail card.
		expect(result.deleted).toBe(true)
		expect(result.reason).toBe("deleted")
		expect(deleted).toEqual(["1554472364094521396"])
		expect(lastAction()?.action_type).toBe("delete_message")
	})

	// 3. Invalid action values must fall back to exactly the pre-action
	//    behaviour, for every junk shape the wire can carry.
	test("an invalid action falls back safely instead of deleting or erroring", async () => {
		for (const action of [
			"warn",
			"review",
			"escalate",
			"delete",
			"RESET_NICKNAME",
			"reset-nickname",
			"hapus_nickname",
			"",
			"   ",
			42,
			null,
			undefined,
			true,
			["delete_message"],
			{ action: "delete_message" },
		]) {
			moderationActions.length = 0
			const { client, deleted, nicknames } = fakeClient()

			const result = await attemptAutoDeleteFlaggedMessage(
				client,
				// A clean nickname and a rude body: `isNicknameOnlyViolation` is false,
				// so eligibility alone decides. A junk action must not divert this to a
				// nickname reset, and must not throw.
				message({ content: "dasar goblok", metadata: null }),
				verdict({ status: "deleted", action }),
			)

			// Pre-action behaviour: status `deleted` + eligible -> deleted.
			expect(result.deleted).toBe(true)
			expect(result.reason).toBe("deleted")
			expect(deleted).toEqual(["1554472364094521396"])
			expect(nicknames).toEqual([])
			expect(lastAction()?.action_type).toBe("delete_message")
		}
	})

	// An invalid action on a CLEAN verdict must stay a keep. This is the direction
	// that matters: a hallucinated field must never be able to authorise a delete.
	test("an invalid action on a clean verdict never reaches enforcement", async () => {
		for (const action of ["delete_message", "warn", 1, {}, null, undefined]) {
			moderationActions.length = 0
			const { client, deleted, nicknames } = fakeClient()

			const result = await attemptAutoDeleteFlaggedMessage(
				client,
				message({ content: "halo semua", metadata: null }),
				verdict({ status: "clean", action, confidence: 0.99 }),
			)

			expect(result.deleted).toBe(false)
			expect(result.reason).toBe("not_eligible")
			expect(deleted).toEqual([])
			expect(nicknames).toEqual([])
			// No action row at all: the only writer of `action_type` on this path is a
			// delete attempt or a nickname reset, and neither happened.
			expect(lastAction()?.action_type).toBe("delete_message")
			expect(lastAction()?.status).toBe("failed")
		}
	})

	// 4. `clean` -> no action. The enforcer never sees a `clean` row at all (its
	//    candidate query filters `status = 'deleted'`), so this is asserted at the
	//    manager boundary: nothing is deleted, no reset, no reset_nickname row.
	//
	//    Uses a CLEAN nickname. The earlier version reused
	//    PROD_NICKNAME_METADATA ("adit cuking") with `status: "clean"` and
	//    expected no enforcement — but a rude nickname IS a violation, and the
	//    evidence guard deliberately overrides a `clean` verdict on it. Expecting
	//    `not_eligible` there asserted that the override did not exist.
	test("action clean performs no enforcement at all", async () => {
		const { client, deleted, nicknames } = fakeClient()

		const result = await attemptAutoDeleteFlaggedMessage(
			client,
			message({
				content: "Nandayo",
				metadata: JSON.stringify({
					member: { nickname: "rama_adityo", displayName: "rama_adityo" },
				}),
			}),
			verdict({ status: "clean", action: "clean" }),
		)

		expect(result.deleted).toBe(false)
		expect(result.skipped).toBe(true)
		expect(result.reason).toBe("not_eligible")
		expect(deleted).toEqual([])
		expect(nicknames).toEqual([])
	})

	// A model-supplied `clean` beside a nickname violation cannot veto the reset:
	// the field is not consulted at all, so there is nothing in it to honour.
	// Only `status` and the evidence speak.
	test("a model-supplied clean cannot veto the nickname-only evidence guard", async () => {
		const { client, nicknames, deleted } = fakeClient()

		const result = await attemptAutoDeleteFlaggedMessage(
			client,
			message({
				content: "Nandayo",
				metadata: PROD_NICKNAME_METADATA,
			}),
			verdict({ status: "deleted", action: "clean" }),
		)

		expect(result.deleted).toBe(false)
		expect(result.reason).toBe("nickname_only_violation")
		expect(deleted).toEqual([])
		expect(nicknames).toEqual([null])
	})

	// The pre-existing behaviour, for the rows written before the column existed:
	// NULL action, nickname-only evidence -> the old reset path, unchanged.
	test("a null action (every row written before the column) still behaves as before", async () => {
		const { client, nicknames, deleted } = fakeClient()

		const nicknameOnly = await attemptAutoDeleteFlaggedMessage(
			client,
			message({ content: "Nandayo", metadata: PROD_NICKNAME_METADATA }),
			verdict({ status: "deleted", action: null }),
		)
		expect(nicknameOnly.reason).toBe("nickname_only_violation")
		expect(deleted).toEqual([])
		// The reset actually ran, which the old build never did.
		expect(nicknames).toEqual([null])

		moderationActions.length = 0
		const plainDelete = await attemptAutoDeleteFlaggedMessage(
			client,
			message({ content: "dasar goblok", metadata: null }),
			verdict({ status: "deleted", action: null }),
		)
		expect(plainDelete.deleted).toBe(true)
		expect(lastAction()?.action_type).toBe("delete_message")
	})

	// The disposition is no longer the model's to choose, so the audit row
	// records what the CATEGORY produced. A name category on a member with a
	// clean body: a reset, recorded as executed, never as a pending delete.
	test("the audit row records the category-derived disposition", async () => {
		const { client } = fakeClient()

		await attemptAutoDeleteFlaggedMessage(
			client,
			message({
				content: "halo semua",
				metadata: JSON.stringify({
					member: { nickname: "rama_adityo", displayName: "rama_adityo" },
				}),
			}),
			verdict({
				status: "deleted",
				categories: ["offensive_nickname"],
				flags: ["offensive_nickname"],
				analysis: "Nickname melanggar aturan; isi pesan bersih.",
			}),
		)

		const action = lastAction()
		expect(action?.action_type).toBe("reset_nickname")
		expect(action?.executed_by).toBe("auto-delete-manager")
		expect(action?.server_nick).toBe("rama_adityo")
		// `reset_nickname` is recorded as executed, never as a pending delete.
		expect(action?.status).toBe("executed")
		expect(action?.executed_at).not.toBeNull()
	})

	// And the mirror: a content category on the same clean-body member records a
	// DELETION, so the audit row tracks the category rather than a stale
	// preference. Both directions matter — a single-direction test would pass
	// even if the manager always wrote the same action_type.
	test("a content category records a deletion, not a reset", async () => {
		const { client } = fakeClient()

		await attemptAutoDeleteFlaggedMessage(
			client,
			message({
				content: "dasar goblok",
				metadata: JSON.stringify({
					member: { nickname: "rama_adityo", displayName: "rama_adityo" },
				}),
			}),
			verdict({
				status: "deleted",
				categories: ["harassment"],
				flags: ["harassment"],
				analysis: "hinaan langsung",
			}),
		)

		expect(lastAction()?.action_type).toBe("delete_message")
		expect(lastAction()?.status).toBe("executed")
	})
})
