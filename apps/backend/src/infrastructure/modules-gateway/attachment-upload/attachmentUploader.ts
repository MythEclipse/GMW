import { retryWithBackoff } from "../../../domain/utils/index.js"
import { config } from "../../config/index.js"
import { createChildLogger } from "../../logger/index.js"
import { uploadToTele } from "../../uploads/uploader.js"
import { messageStore } from "../message-capture/messageStore.js"

const logger = createChildLogger("attachment-uploader")

class AttachmentDownloadError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message)
		this.name = "AttachmentDownloadError"
	}
}

export class AttachmentTooLargeError extends Error {
	constructor(
		readonly actualBytes: number,
		readonly maxBytes: number,
	) {
		super(
			`Attachment is ${(actualBytes / 1024 / 1024).toFixed(2)}MB, over the ${(
				maxBytes / 1024 / 1024
			).toFixed(2)}MB limit`,
		)
		this.name = "AttachmentTooLargeError"
	}
}

/**
 * Read a response body, aborting the moment it exceeds `maxBytes`.
 *
 * `arrayBuffer()` has no ceiling, so the limit has to be enforced during the
 * read. The reader is always released, including on the abort path, or the
 * socket stays open until GC.
 */
async function readBodyWithLimit(
	response: Response,
	maxBytes: number,
): Promise<ArrayBuffer> {
	if (!response.body) return new ArrayBuffer(0)

	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			if (!value) continue
			total += value.byteLength
			if (total > maxBytes) {
				// Release the connection before throwing: an abandoned stream keeps
				// the socket (and its buffer) alive.
				await reader.cancel().catch(() => {})
				throw new AttachmentTooLargeError(total, maxBytes)
			}
			chunks.push(value)
		}
	} finally {
		reader.releaseLock?.()
	}

	const out = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		out.set(chunk, offset)
		offset += chunk.byteLength
	}
	return out.buffer
}

export type RefreshDiscordAttachmentUrl = () => Promise<string | null>

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function shouldRefreshDiscordUrl(error: unknown): boolean {
	return (
		error instanceof AttachmentDownloadError &&
		(error.status === 403 || error.status === 404)
	)
}

export async function uploadAttachmentToTele(
	fileBuffer: Buffer,
	filename: string,
	contentType = "application/octet-stream",
): Promise<string> {
	logger.debug(
		{ filename, sizeBytes: fileBuffer.length },
		"Starting attachment upload to tele",
	)
	try {
		const result = await uploadToTele({
			buffer: fileBuffer,
			filename,
			contentType,
			uploadUrl: config.TELE_UPLOAD_URL,
			timeoutMs: config.ATTACHMENT_UPLOAD_TIMEOUT_MS,
			// Tele 5xx under load is transient (prod: 12x Status 500) — retry
			// inside uploadToTele instead of failing the attachment outright.
			retries: config.ATTACHMENT_RETRY_ATTEMPTS,
		})

		logger.info(
			{ filename, url: result.url },
			"Attachment uploaded to tele successfully",
		)
		return result.url
	} catch (error) {
		logger.error(
			{
				filename,
				error: toErrorMessage(error),
			},
			"Failed to upload attachment",
		)
		throw error
	}
}

export async function downloadDiscordAttachment(
	url: string,
	timeoutMs?: number,
): Promise<Buffer> {
	const timeout = timeoutMs ?? config.ATTACHMENT_UPLOAD_TIMEOUT_MS
	const maxBytes = config.ATTACHMENT_MAX_SIZE_MB * 1024 * 1024
	logger.debug(
		{ url, maxMb: config.ATTACHMENT_MAX_SIZE_MB },
		"Starting Discord attachment download",
	)
	try {
		// Timeout-only retry: a CDN abort mid-download is transient (the prod
		// failure signature is "The operation was aborted due to timeout").
		// 403/404 = expired or purged URL — not retried here; the caller
		// refreshes via refreshDiscordUrl instead.
		const response = await retryWithBackoff(
			() =>
				fetch(url, {
					signal: AbortSignal.timeout(timeout),
				}),
			{
				retries: config.ATTACHMENT_RETRY_ATTEMPTS,
				minTimeout: 1000,
				maxTimeout: 8000,
			},
		)

		if (!response.ok) {
			throw new AttachmentDownloadError(
				`Download failed with status ${response.status}`,
				response.status,
			)
		}

		// Refuse BEFORE buffering, not after.
		//
		// The size check used to run on the fully-materialised Buffer, so an
		// oversized file was downloaded into memory in its entirety and only then
		// rejected. Discord caps a single upload at 10MB/25MB, but the gateway is
		// a selfbot reading whatever URL the API hands it, and the service runs
		// under MemoryMax=1G shared with the client. A handful of concurrent
		// large attachments is an OOM.
		//
		// `content-length` is only a hint, so it is used as an early exit and the
		// real bound is enforced while streaming.
		const declared = Number(response.headers.get("content-length") ?? "")
		if (Number.isFinite(declared) && declared > maxBytes) {
			throw new AttachmentTooLargeError(declared, maxBytes)
		}

		const buffer = await readBodyWithLimit(response, maxBytes)
		const result = Buffer.from(buffer)
		logger.debug(
			{ url, sizeBytes: result.length },
			"Discord attachment downloaded successfully",
		)
		return result
	} catch (error) {
		if (error instanceof AttachmentDownloadError) throw error
		// retryWithBackoff rethrows AbortError unwrapped — normalize it to a
		// plain Error so shouldRefreshDiscordUrl() never mistakes a timeout
		// for an expired URL (which would trigger a useless refresh fetch).
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(`Download timed out: ${toErrorMessage(error)}`)
		}
		logger.error(
			{ url, error: toErrorMessage(error) },
			"Failed to download Discord attachment",
		)
		throw error
	}
}

export async function processAttachmentUpload(
	attachmentId: string,
	discordUrl: string,
	filename: string,
	options: {
		refreshDiscordUrl?: RefreshDiscordAttachmentUrl
		contentType?: string
	} = {},
): Promise<void> {
	logger.info({ attachmentId, filename }, "processAttachmentUpload called")
	try {
		let currentDiscordUrl = discordUrl
		let buffer: Buffer
		try {
			buffer = await downloadDiscordAttachment(currentDiscordUrl)
		} catch (error) {
			// An oversized file will still be oversized on the retry, and a
			// refresh would only re-download it to fail again.
			if (error instanceof AttachmentTooLargeError) throw error
			if (!options.refreshDiscordUrl || !shouldRefreshDiscordUrl(error)) {
				throw error
			}

			logger.warn(
				{ attachmentId, filename },
				"Discord URL expired, refreshing and retrying",
			)
			const freshUrl = await options.refreshDiscordUrl()
			if (!freshUrl) throw error
			currentDiscordUrl = freshUrl
			await messageStore.updateAttachmentDiscordUrl(attachmentId, freshUrl)
			buffer = await downloadDiscordAttachment(currentDiscordUrl)
		}

		// The limit is now enforced during the download (readBodyWithLimit), so
		// this is a cheap belt-and-braces assertion rather than the only guard.
		const sizeMb = buffer.length / (1024 * 1024)
		logger.debug(
			{ attachmentId, sizeMb: sizeMb.toFixed(2) },
			"Attachment size check",
		)
		if (sizeMb > config.ATTACHMENT_MAX_SIZE_MB) {
			throw new AttachmentTooLargeError(
				buffer.length,
				config.ATTACHMENT_MAX_SIZE_MB * 1024 * 1024,
			)
		}

		const uploadedUrl = await uploadAttachmentToTele(
			buffer,
			filename,
			options.contentType,
		)

		await messageStore.updateAttachmentAsUploaded(
			attachmentId,
			uploadedUrl,
			Date.now(),
		)
		logger.info(
			{ attachmentId, url: uploadedUrl },
			"Attachment upload completed successfully",
		)
	} catch (error) {
		const errorMsg = toErrorMessage(error)
		await messageStore.updateAttachmentAsFailedUpload(attachmentId, errorMsg)
		logger.error({ attachmentId, error: errorMsg }, "Attachment upload failed")
	}
}
