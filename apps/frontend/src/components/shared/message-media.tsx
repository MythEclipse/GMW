"use client"

import { cn } from "cn"
import { FileAudio, FileText, Play } from "lucide-react"
import { useState } from "react"
import { formatBytes } from "@/lib/format"
import {
	type AttachmentEvidence,
	attachmentKindLabel,
	isRenderableAttachment,
	type StickerEvidence,
} from "@/lib/message-metadata"

/**
 * The media a message actually carried, rendered.
 *
 * WHY THIS EXISTS
 * The gateway has always captured attachments, stickers and custom emoji into
 * `messages.metadata` (`getAttachmentMetadata` / `getStickerMetadata` /
 * `getCustomEmojiMetadata`), and `parseMessageMetadata` has always parsed them
 * back out. Nothing ever rendered them. A member posting a screenshot rendered
 * as a card whose entire body was blank, because:
 *
 *   - `getDisplayContent()` substitutes `[Attachment: file.png]` for a
 *     media-only post, and `messageBody()` STRIPS that placeholder, so the body
 *     reduced to `""`;
 *   - `EmbeddedPreview` then took the `content.length > 0` branch (the
 *     placeholder made it non-zero) and rendered `messageBody("")` — an empty
 *     paragraph.
 *
 * So the image was captured, stored, and never shown. This component is the
 * missing render.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * No video or audio element. This is a moderation evidence surface: a moderator
 * needs to see the frame, judge it and move on, and an inline player per feed
 * row costs bandwidth and layout for no decision value. Non-renderable
 * attachments become a file chip linking to the original instead.
 *
 * The images are plain `<img>` off `cdn.discordapp.com`, matching the avatar
 * treatment already in `MessageFeedCard`: a Vite SPA has no image optimizer to
 * route them through, and the CDN already serves resized derivatives.
 */

/** Per-card cap. A 40-image dump should not turn one feed row into a wall. */
const MAX_INLINE = 4

/**
 * Ratio used when Discord reported no pixel dimensions.
 *
 * 4:3, not 1:1: a screenshot with unknown dimensions is far more likely to be
 * a landscape desktop capture than a square avatar-sized crop, and `object-cover`
 * crops the overflow either way.
 */
const DEFAULT_IMAGE_RATIO = 4 / 3

const GALLERY_GRID = "grid grid-cols-2 gap-1.5 sm:grid-cols-3"

/**
 * An attachment's aspect ratio, as a `w / h` string for `--media-ratio`.
 *
 * The design gate forbids an inline `style` for a real property and accepts
 * only a custom property whose object literal it can read at the JSX site —
 * the same shape `Avatar` uses for `--avatar-size`. The value is genuinely
 * per-instance: Discord reports real pixel dimensions per attachment, so a 9:16
 * phone screenshot and a 4:3 desktop capture cannot both be served by one
 * Tailwind class, and `.media-frame` in globals.css reads this.
 */
function mediaRatio(width?: number | null, height?: number | null): string {
	if (!width || !height || height <= 0) return String(DEFAULT_IMAGE_RATIO)
	return String(width / height)
}

export function MessageMedia({
	attachments,
	stickers,
	compact = false,
}: {
	attachments: AttachmentEvidence[]
	stickers: StickerEvidence[]
	/** Density for the narrow panels rather than the main feed. */
	compact?: boolean
}) {
	const [revealed, setRevealed] = useState<Record<string, boolean>>({})
	const [broken, setBroken] = useState<Record<string, boolean>>({})

	const renderable = attachments.filter(isRenderableAttachment)
	const chips = attachments.filter((a) => !isRenderableAttachment(a))
	const shown = renderable.slice(0, MAX_INLINE)
	const overflow = renderable.length - shown.length

	if (renderable.length === 0 && chips.length === 0 && stickers.length === 0) {
		return null
	}

	const thumbClass = compact ? "max-h-40" : "max-h-72"

	return (
		<div className="mt-2 space-y-1.5">
			{stickers.length > 0 && (
				<ul className="flex flex-wrap items-center gap-1.5">
					{stickers.map((sticker) => (
						<li key={sticker.id}>
							<a
								href={sticker.url}
								target="_blank"
								rel="noreferrer noopener"
								title={sticker.name}
							>
								<img
									src={sticker.url}
									alt={sticker.name || "Sticker"}
									loading="lazy"
									onError={() =>
										setBroken((s) => ({ ...s, [sticker.id]: true }))
									}
									className="size-11 rounded-md border border-hairline bg-surface-2/40 object-contain"
								/>
							</a>
						</li>
					))}
				</ul>
			)}

			{shown.length > 0 && (
				<ul className={GALLERY_GRID}>
					{shown.map((attachment) => (
						<li key={attachment.id} className="relative min-w-0">
							<MediaImage
								attachment={attachment}
								thumbClass={thumbClass}
								failed={Boolean(broken[attachment.id])}
								onFailure={() =>
									setBroken((s) => ({ ...s, [attachment.id]: true }))
								}
								revealed={Boolean(revealed[attachment.id])}
								onReveal={() =>
									setRevealed((s) => ({ ...s, [attachment.id]: true }))
								}
							/>
						</li>
					))}
				</ul>
			)}

			{overflow > 0 && (
				<p className="text-micro text-ink-faint">+{overflow} gambar lain</p>
			)}

			{chips.length > 0 && (
				<ul className="flex flex-wrap gap-1.5">
					{chips.map((attachment) => (
						<li key={attachment.id}>
							<FileChip attachment={attachment} />
						</li>
					))}
				</ul>
			)}
		</div>
	)
}

/**
 * One attachment image, with Discord's spoiler marker honoured.
 *
 * The spoiler is the author's own instruction and the moderation-relevant part
 * of the post: revealing it is an explicit click, exactly as it is in Discord.
 * `alt` is the author-supplied description when there is one, because that is
 * frequently the only text explaining what the picture is — and for a screen
 * reader it is the difference between a described image and a gap.
 */
function MediaImage({
	attachment,
	thumbClass,
	failed,
	onFailure,
	revealed,
	onReveal,
}: {
	attachment: AttachmentEvidence
	thumbClass: string
	failed: boolean
	onFailure: () => void
	revealed: boolean
	onReveal: () => void
}) {
	const alt = attachment.description?.trim() || attachment.name
	const ratio = mediaRatio(attachment.width, attachment.height)

	if (failed) {
		// A CDN URL that has expired or 404s is a real state: Discord's signed
		// attachment URLs are not permanent. Say so instead of leaving a browser
		// broken-image glyph the reader has to interpret.
		return (
			<div
				className="media-frame flex max-h-72 items-center justify-center rounded-md border border-hairline bg-surface-2/40 px-2 text-center"
				style={{ "--media-ratio": ratio } as React.CSSProperties}
			>
				<span className="text-micro text-ink-faint">
					Gambar tidak dapat dimuat
				</span>
			</div>
		)
	}

	const isSpoiler = attachment.spoiler === true && !revealed

	return (
		<a
			href={attachment.url}
			target="_blank"
			rel="noreferrer noopener"
			onClick={isSpoiler ? (event) => event.preventDefault() : undefined}
			className="block"
		>
			{isSpoiler ? (
				<button
					type="button"
					onClick={onReveal}
					style={{ "--media-ratio": ratio } as React.CSSProperties}
					className={cn(
						"media-frame flex w-full items-center justify-center rounded-md border border-hairline bg-surface-2/40 text-micro text-ink-muted transition-colors hover:text-ink-soft",
						thumbClass,
					)}
				>
					Spoiler — klik untuk melihat
				</button>
			) : (
				<img
					src={attachment.url}
					alt={alt}
					loading="lazy"
					onError={onFailure}
					style={{ "--media-ratio": ratio } as React.CSSProperties}
					className={cn(
						"media-frame w-full rounded-md border border-hairline bg-surface-2/40 object-cover",
						thumbClass,
					)}
				/>
			)}
		</a>
	)
}

/**
 * A non-image attachment: video, audio, or a plain file.
 *
 * Links to the original rather than embedding it, and carries the size and
 * dimensions so a moderator can tell a 4 MB video from a 3 KB text file without
 * opening either.
 */
function FileChip({ attachment }: { attachment: AttachmentEvidence }) {
	const kind = attachmentKindLabel(attachment)
	const Icon = kind === "video" ? Play : kind === "audio" ? FileAudio : FileText
	const label = attachment.description?.trim() || attachment.name

	return (
		<a
			href={attachment.url}
			target="_blank"
			rel="noreferrer noopener"
			title={label}
			className="inline-flex max-w-64 items-center gap-1.5 rounded-md border border-hairline bg-surface-2/40 px-2 py-1 text-micro text-ink-muted transition-colors hover:text-ink-soft"
		>
			<Icon className="size-3.5 shrink-0" aria-hidden />
			<span className="truncate">{label}</span>
			<span className="shrink-0 font-mono text-ink-faint">
				{formatBytes(attachment.size)}
			</span>
			{attachment.width && attachment.height && (
				<span className="shrink-0 font-mono text-ink-faint">
					{attachment.width}×{attachment.height}
				</span>
			)}
		</a>
	)
}
