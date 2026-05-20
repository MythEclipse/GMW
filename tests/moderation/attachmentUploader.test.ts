import { beforeEach, describe, expect, it, vi } from "vitest";

const updateAttachmentAsFailedUpload = vi.fn();
const updateAttachmentAsUploaded = vi.fn();
const updateAttachmentDiscordUrl = vi.fn();
const uploadToTele = vi.fn();

vi.mock("../../src/moderation/messageStore", () => ({
  updateAttachmentAsFailedUpload,
  updateAttachmentAsUploaded,
  updateAttachmentDiscordUrl,
}));

vi.mock("../../src/uploader/teleUpload", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/uploader/teleUpload")
  >("../../src/uploader/teleUpload");
  return {
    ...actual,
    uploadToTele,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env = {
    ...process.env,
    DISCORD_TOKEN: "test-token",
    MONITOR_GUILD_ID: "test-guild",
    NODE_ENV: "test",
  };
});

describe("attachmentUploader", () => {
  it("parses tele upload response correctly", async () => {
    const { parseTeleUploadResponse } = await import(
      "../../src/uploader/teleUpload"
    );

    const result = parseTeleUploadResponse({
      download_url: "https://upload.asepharyana.tech/d/abc123.jpg",
      public_id: "abc123",
      file_name: "abc123.jpg",
      size_bytes: 102400,
    });

    expect(result.url).toBe("https://upload.asepharyana.tech/d/abc123.jpg");
    expect(result.publicId).toBe("abc123");
    expect(result.filename).toBe("abc123.jpg");
    expect(result.sizeBytes).toBe(102400);
  });

  it("handles upload response with missing download_url", async () => {
    const { parseTeleUploadResponse } = await import(
      "../../src/uploader/teleUpload"
    );

    expect(() => parseTeleUploadResponse({ download_url: "" })).toThrow(
      /download_url/,
    );
  });

  it("refreshes Discord URL after expired CDN response", async () => {
    const { processAttachmentUpload } = await import(
      "../../src/moderation/attachmentUploader"
    );
    const oldBytes = Buffer.from("old");
    const freshBytes = Buffer.from("fresh");

    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === "https://cdn.discordapp.com/old.png") {
        return Promise.resolve({ ok: false, status: 404 });
      }
      if (url === "https://cdn.discordapp.com/fresh.png") {
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () =>
            freshBytes.buffer.slice(
              freshBytes.byteOffset,
              freshBytes.byteOffset + freshBytes.byteLength,
            ),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () =>
          oldBytes.buffer.slice(
            oldBytes.byteOffset,
            oldBytes.byteOffset + oldBytes.byteLength,
          ),
      });
    });
    uploadToTele.mockResolvedValue({ url: "https://upload.example/fresh.png" });

    await processAttachmentUpload(
      "att-1",
      "https://cdn.discordapp.com/old.png",
      "image.png",
      {
        refreshDiscordUrl: async () => "https://cdn.discordapp.com/fresh.png",
      },
    );

    expect(updateAttachmentDiscordUrl).toHaveBeenCalledWith(
      "att-1",
      "https://cdn.discordapp.com/fresh.png",
    );
    expect(uploadToTele).toHaveBeenCalledWith(
      expect.objectContaining({ buffer: freshBytes, filename: "image.png" }),
    );
    expect(updateAttachmentAsUploaded).toHaveBeenCalledWith(
      "att-1",
      "https://upload.example/fresh.png",
      expect.any(Number),
    );
    expect(updateAttachmentAsFailedUpload).not.toHaveBeenCalled();
  });
});
