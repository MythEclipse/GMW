import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/errors";
import { createMediaResolver, resolveMediaSource } from "../../src/media/mediaResolver";

describe("resolveMediaSource", () => {
  it("accepts http URLs", async () => {
    await expect(
      resolveMediaSource("https://example.com/music.mp3"),
    ).resolves.toEqual({
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

  it("sanitizes URL titles", async () => {
    await expect(
      resolveMediaSource("https://example.com/%2e%2e%2fsecret.mp3"),
    ).resolves.toMatchObject({
      title: "secret.mp3",
      kind: "url",
    });
  });

  it("resolves search queries to YouTube results", async () => {
    const resolver = createMediaResolver({
      ytdlp: {
        getMetadata: vi.fn(),
        getDirectAudioUrl: vi.fn(async () => "https://audio.example.com/search"),
      },
      playDlResolver: {
        searchYouTube: vi.fn(async () => ({
          title: "Search Result",
          url: "https://youtube.com/watch?v=search",
        })),
        resolveSpotifyTrack: vi.fn(),
      },
    });

    await expect(resolver("artist song")).resolves.toEqual({
      source: "https://audio.example.com/search",
      title: "Search Result",
      kind: "search",
    });
  });

  it("rejects non-http URL sources", async () => {
    await expect(
      resolveMediaSource("file:///tmp/song.mp3"),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA_SOURCE",
      statusCode: 400,
    } satisfies Partial<AppError>);
  });

  it("rejects malformed http URLs as unsupported sources", async () => {
    await expect(resolveMediaSource("https://[invalid")).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA_SOURCE",
      statusCode: 400,
    } satisfies Partial<AppError>);
  });

  it("keeps direct URLs as generic URL sources", async () => {
    await expect(
      resolveMediaSource("https://cdn.example.com/song.mp3"),
    ).resolves.toMatchObject({
      kind: "url",
      source: "https://cdn.example.com/song.mp3",
    });
  });

  it("resolves YouTube URLs with yt-dlp metadata", async () => {
    const resolver = createMediaResolver({
      ytdlp: {
        getMetadata: vi.fn(async () => ({
          title: "YouTube Song",
          webpageUrl: "https://youtube.com/watch?v=abc",
        })),
        getDirectAudioUrl: vi.fn(async () => "https://audio.example.com/abc"),
      },
      playDlResolver: {
        searchYouTube: vi.fn(),
        resolveSpotifyTrack: vi.fn(),
      },
    });

    await expect(resolver("https://youtu.be/abc")).resolves.toEqual({
      source: "https://audio.example.com/abc",
      title: "YouTube Song",
      kind: "youtube",
    });
  });

  it("resolves Spotify track URLs through YouTube search", async () => {
    const resolver = createMediaResolver({
      ytdlp: {
        getMetadata: vi.fn(),
        getDirectAudioUrl: vi.fn(async () => "https://audio.example.com/spotify"),
      },
      playDlResolver: {
        searchYouTube: vi.fn(),
        resolveSpotifyTrack: vi.fn(async () => ({
          title: "Spotify Match",
          url: "https://youtube.com/watch?v=spotify",
        })),
      },
    });

    await expect(
      resolver("https://open.spotify.com/track/123"),
    ).resolves.toEqual({
      source: "https://audio.example.com/spotify",
      title: "Spotify Match",
      kind: "spotify",
    });
  });
});
