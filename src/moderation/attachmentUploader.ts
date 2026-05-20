import { config } from "../config";
import { createChildLogger } from "../logger";
import { uploadToTele } from "../uploader/teleUpload";
import {
  updateAttachmentAsFailedUpload,
  updateAttachmentAsUploaded,
} from "./messageStore";

const logger = createChildLogger("attachment-uploader");

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function uploadAttachmentToTele(
  fileBuffer: Buffer,
  filename: string,
): Promise<string> {
  try {
    const result = await uploadToTele({
      buffer: fileBuffer,
      filename,
      contentType: "application/octet-stream",
      uploadUrl: config.TELE_UPLOAD_URL,
      timeoutMs: config.ATTACHMENT_UPLOAD_TIMEOUT_MS,
      retries: config.ATTACHMENT_RETRY_ATTEMPTS,
      logger,
    });

    return result.url;
  } catch (error) {
    logger.error(
      {
        filename,
        error: toErrorMessage(error),
      },
      "Failed to upload attachment",
    );
    throw error;
  }
}

export async function downloadDiscordAttachment(url: string): Promise<Buffer> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(config.ATTACHMENT_UPLOAD_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Download failed with status ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    return Buffer.from(buffer);
  } catch (error) {
    logger.error(
      { url, error: toErrorMessage(error) },
      "Failed to download Discord attachment",
    );
    throw error;
  }
}

export async function processAttachmentUpload(
  attachmentId: string,
  discordUrl: string,
  filename: string,
): Promise<void> {
  try {
    const buffer = await downloadDiscordAttachment(discordUrl);

    const sizeMb = buffer.length / (1024 * 1024);
    if (sizeMb > config.ATTACHMENT_MAX_SIZE_MB) {
      throw new Error(
        `File size ${sizeMb.toFixed(2)}MB exceeds limit of ${config.ATTACHMENT_MAX_SIZE_MB}MB`,
      );
    }

    const uploadedUrl = await uploadAttachmentToTele(buffer, filename);

    await updateAttachmentAsUploaded(attachmentId, uploadedUrl, Date.now());
  } catch (error) {
    const errorMsg = toErrorMessage(error);
    await updateAttachmentAsFailedUpload(attachmentId, errorMsg);
    logger.error({ attachmentId, error: errorMsg }, "Attachment upload failed");
  }
}
