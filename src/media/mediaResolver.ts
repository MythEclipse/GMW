import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { AppError } from "../errors";
import type { MediaMode, ResolvedMediaSource } from "./mediaTypes";
import { createPlayDlResolver } from "./playDlResolver";
import { createYtDlp, type YtDlpClient } from "./ytdlp";

type PlayDlResolver = ReturnType<typeof createPlayDlResolver>;

export interface MediaResolverDependencies {
  ytdlp?: YtDlpClient;
  playDlResolver?: PlayDlResolver;
}

export function createMediaResolver(
  dependencies: MediaResolverDependencies = {},
) {
  const ytdlp = dependencies.ytdlp ?? createYtDlp();
  const playDlResolver = dependencies.playDlResolver ?? createPlayDlResolver();

  return async function resolve(
    input: string,
    mode: MediaMode = "music",
  ): Promise<ResolvedMediaSource> {
    const source = input.trim();
    if (!source) {
      throw new AppError(
        "Media source is required",
        "MISSING_MEDIA_SOURCE",
        400,
      );
    }

    const url = parseUrl(source);
    if (url && isYouTubeUrl(url)) {
      const metadata = await ytdlp.getMetadata(source);
      const directUrl =
        mode === "screen"
          ? await ytdlp.getDirectVideoUrl(source)
          : await ytdlp.getDirectAudioUrl(source);
      return { source: directUrl, title: metadata.title, kind: "youtube" };
    }

    if (url && isSpotifyTrackUrl(url)) {
      const result = await playDlResolver.resolveSpotifyTrack(source);
      const directUrl =
        mode === "screen"
          ? await ytdlp.getDirectVideoUrl(result.url)
          : await ytdlp.getDirectAudioUrl(result.url);
      return { source: directUrl, title: result.title, kind: "spotify" };
    }

    const urlSource = resolveUrlSource(source);
    if (urlSource) return urlSource;

    const localPath = path.resolve(source);
    if (existsSync(localPath) && statSync(localPath).isFile()) {
      return {
        source: localPath,
        title: path.basename(localPath),
        kind: "local",
      };
    }

    if (!url && !looksLikeUrl(source)) {
      const result = await playDlResolver.searchYouTube(source);
      const directUrl =
        mode === "screen"
          ? await ytdlp.getDirectVideoUrl(result.url)
          : await ytdlp.getDirectAudioUrl(result.url);
      return { source: directUrl, title: result.title, kind: "search" };
    }

    throw new AppError(
      "Media source must be an HTTP(S) URL, YouTube URL, Spotify track URL, search query, or existing local file",
      "UNSUPPORTED_MEDIA_SOURCE",
      400,
    );
  };
}

export const resolveMediaSource = createMediaResolver();

function parseUrl(source: string): URL | null {
  try {
    return new URL(source);
  } catch {
    return null;
  }
}

function looksLikeUrl(source: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(source);
}

function isYouTubeUrl(url: URL): boolean {
  return [
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "youtu.be",
  ].includes(url.hostname);
}

function isSpotifyTrackUrl(url: URL): boolean {
  return (
    url.hostname === "open.spotify.com" && url.pathname.startsWith("/track/")
  );
}

function resolveUrlSource(source: string): ResolvedMediaSource | null {
  const url = parseUrl(source);
  if (!url) return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  return {
    source,
    title: titleFromUrl(url),
    kind: "url",
  };
}

function titleFromUrl(url: URL): string {
  const filename = decodeURIComponent(url.pathname.split("/").pop() || "");
  return path.basename(filename) || url.hostname;
}
