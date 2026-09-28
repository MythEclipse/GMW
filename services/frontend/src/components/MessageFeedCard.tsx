"use client";

import Image from "next/image";
import { useState } from "react";
import { Badge, type Tone } from "@/components/shared/tone";
import {
  pipelineLabel,
  pipelineTone,
  severityTone,
  verdictLabel,
  verdictTone,
} from "@/lib/ai-status";
import { formatRelative } from "@/lib/format";
import type { Message, Severity, VerdictStatus } from "@/lib/types";

/**
 * Message row for the live feed and the review queue.
 *
 * Shows BOTH state axes explicitly, because collapsing them is the bug that
 * made "still queued" indistinguishable from "judged clean":
 *
 *   - the VERDICT pill  (clean / warn / flagged / error / unjudged)
 *   - the PIPELINE pill (queued / analyzing / analyzed / retrying / abandoned)
 *
 * An unjudged message is visually neutral, never green.
 */
export function MessageFeedCard({
  message,
  showPipeline = true,
  now,
}: {
  message: Message;
  showPipeline?: boolean;
  now?: number;
}) {
  const verdict = (message.verdict_status ?? "unjudged") as
    | VerdictStatus
    | "unjudged";
  const deleted = message.deleted_at != null;
  const edited = message.edited_at != null;

  return (
    <article className="msg-feed-card hud-card px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Avatar
          src={message.avatar_url}
          name={message.server_nick ?? message.username}
        />
        <span className="truncate text-sm font-medium text-ink">
          {message.server_nick ?? message.username}
        </span>
        <span className="truncate font-mono text-micro-lg text-ink-faint">
          {message.user_id}
        </span>
        <span className="ml-auto shrink-0 text-micro-lg text-ink-faint">
          {formatRelative(message.created_at, now)}
        </span>
      </div>

      <p className="mt-1.5 text-sm break-words whitespace-pre-wrap text-ink-soft">
        {message.content.length > 0 ? message.content : "—"}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge tone={verdictTone(verdict)}>{verdictLabel(verdict)}</Badge>

        {showPipeline && (
          <Badge tone={pipelineTone(message.ai_status)}>
            {pipelineLabel(message.ai_status)}
          </Badge>
        )}

        {message.verdict_severity && message.verdict_severity !== "none" && (
          <Badge tone={severityTone(message.verdict_severity)}>
            {message.verdict_severity}
          </Badge>
        )}

        {deleted && <Badge tone="danger">Deleted</Badge>}
        {edited && !deleted && <Badge tone="neutral">Edited</Badge>}

        {(message.verdict_flags ?? []).slice(0, 3).map((flag) => (
          <span
            key={flag}
            className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-micro text-ink-muted"
          >
            {flag}
          </span>
        ))}
      </div>

      {message.verdict_analysis && (
        <p className="mt-2 border-l-2 border-hairline pl-2 text-xs text-ink-muted">
          {message.verdict_analysis}
        </p>
      )}
    </article>
  );
}

/**
 * Avatar with a text fallback.
 *
 * Discord CDN URLs are already allow-listed in `next.config.ts`; `unoptimized`
 * is set because these are small, already-CDN-cached images where the Next
 * image optimizer would add a hop for no benefit.
 *
 * The fallback's dimensions travel as `--avatar-size` rather than inline
 * `width`/`height`, because the design gate forbids inline width/height and the
 * value is genuinely per-instance. `.avatar-fallback` in globals.css reads the
 * variable.
 */
export function Avatar({
  src,
  name,
  size = 24,
}: {
  src: string | null | undefined;
  name: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const initials = name.slice(0, 2).toUpperCase() || "??";

  if (!src || failed) {
    return (
      <span
        className="avatar-fallback flex shrink-0 items-center justify-center rounded-full bg-surface-2 font-mono text-micro text-ink-muted"
        style={{ "--avatar-size": `${size}px` } as React.CSSProperties}
        aria-hidden
      >
        {initials}
      </span>
    );
  }

  return (
    <Image
      src={src}
      alt=""
      width={size}
      height={size}
      // Avatars are already CDN-cached and tiny; the optimizer would add a hop
      // and a server round trip for no benefit, and would break for any host
      // not allow-listed in next.config.ts.
      unoptimized
      onError={() => setFailed(true)}
      className="shrink-0 rounded-full"
    />
  );
}

export function SeverityBadge({ severity }: { severity: Severity | null }) {
  if (!severity || severity === "none") return null;
  return <Badge tone={severityTone(severity)}>{severity}</Badge>;
}

export type { Tone };
