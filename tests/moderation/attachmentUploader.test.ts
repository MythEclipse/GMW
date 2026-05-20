import { beforeEach, describe, expect, it } from "vitest";

beforeEach(() => {
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
});
