import { config } from "../config";
import { createChildLogger } from "../logger";
import { retryWithBackoff } from "../retry";
import {
  updateAttachmentAsFailedUpload,
  updateAttachmentAsUploaded,
} from "./messageStore";

const logger = createChildLogger("attachment-uploader");

const ATTACHMENT_UPLOAD_RETRY_OPTIONS = {
  retries: config.ATTACHMENT_RETRY_ATTEMPTS,
  minTimeout: 1000,
  maxTimeout: 5000,
  logger,
} as const;

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface PicserUploadResponse {
  success: boolean;
  filename: string;
  urls: {
    raw_commit?: string;
    [key: string]: string | undefined;
  };
  size: number;
  type: string;
}

export interface ParsedUploadResponse {
  success: boolean;
  url: string;
  filename: string;
  size: number;
  type: string;
}

export function parseUploadResponse(
  response: PicserUploadResponse,
): ParsedUploadResponse {
  if (!response.success) {
    throw new Error("Upload failed: success=false");
  }

  const rawCommitUrl = response.urls.raw_commit;
  if (!rawCommitUrl) {
    throw new Error("Upload response missing raw_commit URL");
  }

  return {
    success: true,
    url: rawCommitUrl,
    filename: response.filename,
    size: response.size,
    type: response.type,
  };
}

export async function uploadAttachmentToPicser(
  fileBuffer: Buffer,
  filename: string,
): Promise<ParsedUploadResponse> {
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(fileBuffer)], {
    type: "application/octet-stream",
  });
  formData.append("file", blob, filename);

  try {
    const response = await retryWithBackoff(async () => {
      const res = await fetch(config.PICSER_UPLOAD_URL, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(config.ATTACHMENT_UPLOAD_TIMEOUT_MS),
      });

      if (!res.ok) {
        throw new Error(`Upload failed with status ${res.status}`);
      }

      return res.json() as Promise<PicserUploadResponse>;
    }, ATTACHMENT_UPLOAD_RETRY_OPTIONS);

    return parseUploadResponse(response);
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

    const result = await uploadAttachmentToPicser(buffer, filename);

    await updateAttachmentAsUploaded(attachmentId, result.url, Date.now());
  } catch (error) {
    const errorMsg = toErrorMessage(error);
    await updateAttachmentAsFailedUpload(attachmentId, errorMsg);
    logger.error({ attachmentId, error: errorMsg }, "Attachment upload failed");
  }
}
