import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors";
import { resolveMediaSource } from "../../src/media/mediaResolver";

describe("resolveMediaSource", () => {
  it("accepts http URLs", async () => {
    await expect(resolveMediaSource("https://example.com/music.mp3")).resolves.toEqual({
      source: "https://example.com/music.mp3",
      title: "music.mp3",
      kind: "url",
    });
  });

  it("accepts existing local files", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-resolver-"));
    const file = path.join(dir, "song.ogg");
    writeFileSync(file, "audio");

    await expect(resolveMediaSource(file)).resolves.toEqual({
      source: file,
      title: "song.ogg",
      kind: "local",
    });
  });

  it("rejects empty sources", async () => {
    await expect(resolveMediaSource("   ")).rejects.toMatchObject({
      code: "MISSING_MEDIA_SOURCE",
      statusCode: 400,
    } satisfies Partial<AppError>);
  });

  it("rejects unsupported sources", async () => {
    await expect(resolveMediaSource("not a url or file")).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA_SOURCE",
      statusCode: 400,
    } satisfies Partial<AppError>);
  });
});
