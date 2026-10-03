import type { DisplayVerdict, PipelineStatus, VerdictStatus } from "./types";

/**
 * The moderation state machine, in one place.
 *
 * There are TWO independent axes and conflating them is the single most
 * expensive bug this dashboard has had:
 *
 *   `messages.ai_status`  — WHERE the message is in the queue.
 *                            pending | claimed | analyzed | retry_wait
 *                            dead | skipped
 *                            A hard CHECK constraint (migration 0020, widened
 *                            by 0023) rejects anything else, so the v1 names
 *                            ("processing", "clean", "flagged"…) can never be
 *                            written.
 *
 *   `verdicts.status`     — WHAT the model decided.
 *                            clean | deleted | error
 *
 * So "still queued" and "judged clean" are different facts. A message that is
 * `pending` has no outcome yet; rendering it as clean is a lie, and a filter
 * written against `ai_status IN ('flagged')` can never match a row.
 *
 * `skipped` is the other end: terminal, and deliberately un-judged. The message
 * was captured and is on the dashboard, but its channel is exempt from
 * moderation, so it has no verdict — not a clean one, and not an error.
 */

export const PIPELINE_STATUSES: readonly PipelineStatus[] = [
  "pending",
  "claimed",
  "analyzed",
  "retry_wait",
  "dead",
  "skipped",
] as const;

export const VERDICT_STATUSES: readonly VerdictStatus[] = [
  "clean",
  "deleted",
  "error",
] as const;

/** True only for values the DB CHECK constraint will accept. */
export function isPipelineStatus(value: unknown): value is PipelineStatus {
  return (
    typeof value === "string" &&
    (PIPELINE_STATUSES as readonly string[]).includes(value)
  );
}

export function isVerdictStatus(value: unknown): value is VerdictStatus {
  return (
    typeof value === "string" &&
    (VERDICT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Read a filter value out of a URL query parameter (W2).
 *
 * Returns the caller's "unfiltered" sentinel when the parameter is absent OR is
 * not one the backend accepts. The validation is the point: these strings go
 * straight into the oRPC call, and `messageQuerySchema` is a Zod enum, so an
 * unvalidated `?status=whatever` from a shared or hand-edited URL would reject
 * the whole request and take the page down with it.
 *
 * Shared by the messages and moderation views so both validate identically.
 */
export function filterFromUrl(
  value: string | null,
  allowed: readonly string[],
  unfiltered: string,
): string {
  return value !== null && allowed.includes(value) ? value : unfiltered;
}

export type VerdictTone = "neutral" | "positive" | "warning" | "danger";

/**
 * Map a verdict to a tone. `"unjudged"` is neutral, NOT positive: it means the
 * worker has not concluded, and painting it green would understate the backlog.
 *
 * `deleted` is danger for the same reason `flagged` was — it is the outcome
 * that acted on the message, and the one a moderator needs to see.
 */
export function verdictTone(
  verdict: DisplayVerdict | null | undefined,
): VerdictTone {
  switch (verdict) {
    case "deleted":
      return "danger";
    case "error":
      return "warning";
    case "clean":
      return "positive";
    default:
      return "neutral";
  }
}

export function verdictLabel(
  verdict: DisplayVerdict | null | undefined,
): string {
  switch (verdict) {
    // The DECISION is called "flagged", not "deleted": deletion is a separate,
    // downstream fact (see `deletedBy`). Labelling both "Deleted" printed the
    // word twice on every bot-removed message and read as a stutter.
    case "deleted":
      return "Flagged";
    case "error":
      return "Error";
    case "clean":
      return "Clean";
    case "unjudged":
      return "Unjudged";
    default:
      return "Unknown";
  }
}

/**
 * Who removed the message from Discord — the distinction a bare `deleted_at`
 * cannot make.
 *
 * Discord's `messageDelete` event fires for EVERY deletion, moderator or bot,
 * so `deleted_at` only records THAT something was deleted. It never says who.
 * The bot's own deletions are recoverable from a second source: the gateway's
 * auto-delete enforcer is the only writer of `verdicts.auto_delete_state`, and
 * it always leaves a state behind — `done` on success, `failed` if Discord
 * refused, `claimed`/`pending` while in flight.
 *
 * So:
 *   bot    — deleted_at set AND auto_delete_state is non-null
 *   human  — deleted_at set AND auto_delete_state is null
 *   absent — nothing deleted; returns null so callers render no badge at all
 *
 * `pending`/`claimed` count as the bot: the bot DID act, and had a human beaten
 * it to the message its Discord call would have failed, leaving `failed`.
 */
export type DeletedBy = "bot" | "human";

export function deletedBy(message: {
  deleted_at?: number | null;
  auto_delete_state?: string | null;
}): DeletedBy | null {
  if (message.deleted_at == null) return null;
  return message.auto_delete_state != null ? "bot" : "human";
}

/** Queue position as a label, with the meaning spelled out. */
export function pipelineLabel(
  status: PipelineStatus | null | undefined,
): string {
  switch (status) {
    case "pending":
      return "Queued";
    case "claimed":
      return "Analyzing";
    case "analyzed":
      return "Analyzed";
    case "retry_wait":
      return "Retrying";
    case "dead":
      return "Abandoned";
    // Deliberately not analysed: a channel on the skip list. NOT an error
    // and not "queued" — the message was captured and will never be judged.
    case "skipped":
      return "Not moderated";
    default:
      return "Unknown";
  }
}

export function pipelineTone(
  status: PipelineStatus | null | undefined,
): VerdictTone {
  switch (status) {
    case "dead":
      return "danger";
    // Neutral, not positive: `analyzed` is green because a judgement was
    // reached, and nothing was judged here. Not a warning either.
    case "skipped":
      return "neutral";
    case "retry_wait":
      return "warning";
    case "claimed":
      return "neutral";
    case "analyzed":
      return "positive";
    default:
      return "neutral";
  }
}

/**
 * A message needs a human when its pipeline state is `dead` (the worker gave
 * up) or its verdict is `error`. Everything else resolves on its own.
 */
export function needsHuman(message: {
  ai_status?: PipelineStatus | null;
  verdict_status?: DisplayVerdict | null;
}): boolean {
  return message.ai_status === "dead" || message.verdict_status === "error";
}

/**
 * Work still owed by the worker.
 *
 * `dead` is excluded on purpose — it is not queued any more, it is
 * abandoned, and conflating the two hides a stuck pipeline behind a
 * healthy-looking backlog number. `skipped` is excluded for a different
 * reason: nothing is ever owed, so counting it would put an exempt channel
 * in the backlog permanently.
 */
export function isBacklogged(
  status: PipelineStatus | null | undefined,
): boolean {
  return (
    status === "pending" || status === "claimed" || status === "retry_wait"
  );
}
