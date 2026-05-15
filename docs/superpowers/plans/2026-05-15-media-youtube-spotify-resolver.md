# Media YouTube and Spotify Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend media playback input so users can queue YouTube URLs, plain search queries, and Spotify track URLs that resolve to playable YouTube audio.

**Architecture:** Keep playback unchanged: `musicPlayer` still passes one resolved source to ffmpeg. Add resolver units that turn rich inputs into direct playable URLs before queueing: `play-dl` for YouTube search and Spotify metadata, `yt-dlp` wrapper for YouTube metadata/direct URL extraction when available. Spotify track support resolves metadata then searches YouTube; no Spotify playlist/album support in this phase.

**Tech Stack:** TypeScript, Vitest, Node `child_process`, `play-dl`, external `yt-dlp` command when installed, existing Express/media controller/music player.

---

## File Structure

- Modify `package.json` and `pnpm-lock.yaml` — add `play-dl` dependency.
- Modify `src/media/mediaTypes.ts` — extend `MediaSourceKind` with `youtube`, `spotify`, and `search`.
- Create `src/media/ytdlp.ts` — small wrapper around external `yt-dlp` for JSON metadata and direct audio URL extraction.
- Create `src/media/playDlResolver.ts` — wrapper around `play-dl` for YouTube search and Spotify track metadata.
- Modify `src/media/mediaResolver.ts` — compose local/direct URL/YouTube/search/Spotify resolution.
- Modify `public/index.html` — update input label/placeholder to mention YouTube, Spotify track, and search.
- Tests:
  - `tests/media/ytdlp.test.ts`
  - `tests/media/playDlResolver.test.ts`
  - `tests/media/mediaResolver.test.ts`

---

### Task 1: Add play-dl and Media Source Kinds

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `src/media/mediaTypes.ts`
- Test: `tests/media/mediaResolver.test.ts`

- [ ] **Step 1: Write failing type expectation in resolver test**

Append to `tests/media/mediaResolver.test.ts`:

```ts
  it("keeps direct URLs as generic URL sources", async () => {
    await expect(
      resolveMediaSource("https://cdn.example.com/song.mp3"),
    ).resolves.toMatchObject({
      kind: "url",
      source: "https://cdn.example.com/song.mp3",
    });
  });
```

This test should already pass before type changes; it protects existing behavior.

- [ ] **Step 2: Install play-dl**

Run:

```bash
pnpm -C /mnt/code/bete add play-dl
```

Expected: `package.json` contains `"play-dl"` in dependencies and `pnpm-lock.yaml` updates.

- [ ] **Step 3: Extend media source kinds**

Modify `src/media/mediaTypes.ts`:

```ts
export type MediaSourceKind = "url" | "local" | "youtube" | "spotify" | "search";
```

- [ ] **Step 4: Run protected resolver test and typecheck**

Run:

```bash
pnpm -C /mnt/code/bete exec vitest run tests/media/mediaResolver.test.ts
pnpm -C /mnt/code/bete run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit task 1**

```bash
git -C /mnt/code/bete add package.json pnpm-lock.yaml src/media/mediaTypes.ts tests/media/mediaResolver.test.ts
git -C /mnt/code/bete commit -m "feat: prepare media resolver source kinds"
```

---

### Task 2: yt-dlp Wrapper

**Files:**
- Create: `src/media/ytdlp.ts`
- Test: `tests/media/ytdlp.test.ts`

- [ ] **Step 1: Write failing yt-dlp tests**

Create `tests/media/ytdlp.test.ts`:

```ts
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createYtDlp } from "../../src/media/ytdlp";

class FakeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
}

describe("createYtDlp", () => {
  it("reads YouTube metadata as JSON", async () => {
    const proc = new FakeProcess();
    const spawn = vi.fn(() => proc);
    const ytdlp = createYtDlp({ spawn });

    const result = ytdlp.getMetadata("https://youtu.be/video");
    proc.stdout.write(JSON.stringify({ title: "Song Title", webpage_url: "https://youtube.com/watch?v=video" }));
    proc.stdout.end();
    proc.emit("close", 0);

    await expect(result).resolves.toEqual({
      title: "Song Title",
      webpageUrl: "https://youtube.com/watch?v=video",
    });
    expect(spawn).toHaveBeenCalledWith("yt-dlp", [
      "https://youtu.be/video",
      "--dump-single-json",
      "--no-playlist",
      "--no-warnings",
      "--quiet",
    ], { stdio: ["ignore", "pipe", "pipe"] });
  });

  it("reads direct audio URL", async () => {
    const proc = new FakeProcess();
    const ytdlp = createYtDlp({ spawn: vi.fn(() => proc) });

    const result = ytdlp.getDirectAudioUrl("https://youtu.be/video");
    proc.stdout.write("https://audio.example.com/stream\n");
    proc.stdout.end();
    proc.emit("close", 0);

    await expect(result).resolves.toBe("https://audio.example.com/stream");
  });

  it("rejects when yt-dlp exits non-zero", async () => {
    const proc = new FakeProcess();
    const ytdlp = createYtDlp({ spawn: vi.fn(() => proc) });

    const result = ytdlp.getMetadata("https://youtu.be/video");
    proc.stderr.write("failed");
    proc.stderr.end();
    proc.emit("close", 1);

    await expect(result).rejects.toThrow("yt-dlp failed with code 1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm -C /mnt/code/bete exec vitest run tests/media/ytdlp.test.ts
```

Expected: FAIL because `src/media/ytdlp.ts` does not exist.

- [ ] **Step 3: Implement yt-dlp wrapper**

Create `src/media/ytdlp.ts`:

```ts
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";

export interface YtDlpMetadata {
  title: string;
  webpageUrl: string;
}

export interface YtDlpClient {
  getMetadata(url: string): Promise<YtDlpMetadata>;
  getDirectAudioUrl(url: string): Promise<string>;
}

export interface YtDlpDependencies {
  spawn?: typeof nodeSpawn;
}

export function createYtDlp(dependencies: YtDlpDependencies = {}): YtDlpClient {
  const spawn = dependencies.spawn ?? nodeSpawn;

  return {
    async getMetadata(url: string): Promise<YtDlpMetadata> {
      const data = await runYtDlp(spawn, [
        url,
        "--dump-single-json",
        "--no-playlist",
        "--no-warnings",
        "--quiet",
      ]);
      const parsed = JSON.parse(data) as { title?: string; webpage_url?: string };
      return {
        title: parsed.title || url,
        webpageUrl: parsed.webpage_url || url,
      };
    },

    async getDirectAudioUrl(url: string): Promise<string> {
      return runYtDlp(spawn, [
        url,
        "--get-url",
        "--format",
        "bestaudio[protocol^=http]/bestaudio/best",
        "--no-playlist",
        "--no-warnings",
        "--quiet",
      ]).then((value) => value.trim().split("\n")[0] || url);
    },
  };
}

async function runYtDlp(
  spawn: typeof nodeSpawn,
  args: string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", args, {
      stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as ChildProcessWithoutNullStreams;
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`yt-dlp failed with code ${code}: ${stderr.trim()}`));
    });
  });
}
```

- [ ] **Step 4: Run yt-dlp tests and typecheck**

```bash
pnpm -C /mnt/code/bete exec vitest run tests/media/ytdlp.test.ts
pnpm -C /mnt/code/bete run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit task 2**

```bash
git -C /mnt/code/bete add src/media/ytdlp.ts tests/media/ytdlp.test.ts
git -C /mnt/code/bete commit -m "feat: add yt-dlp media helper"
```

---

### Task 3: play-dl Resolver Wrapper

**Files:**
- Create: `src/media/playDlResolver.ts`
- Test: `tests/media/playDlResolver.test.ts`

- [ ] **Step 1: Write failing play-dl resolver tests**

Create `tests/media/playDlResolver.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createPlayDlResolver } from "../../src/media/playDlResolver";

describe("createPlayDlResolver", () => {
  it("returns the first YouTube search result", async () => {
    const resolver = createPlayDlResolver({
      search: vi.fn(async () => [
        { title: "Song Result", url: "https://youtube.com/watch?v=abc" },
      ]),
      spotify: vi.fn(),
    });

    await expect(resolver.searchYouTube("artist song")).resolves.toEqual({
      title: "Song Result",
      url: "https://youtube.com/watch?v=abc",
    });
  });

  it("turns Spotify track metadata into a YouTube search query", async () => {
    const resolver = createPlayDlResolver({
      search: vi.fn(async () => [
        { title: "Artist - Track", url: "https://youtube.com/watch?v=track" },
      ]),
      spotify: vi.fn(async () => ({
        type: "track",
        name: "Track",
        artists: [{ name: "Artist" }],
      })),
    });

    await expect(
      resolver.resolveSpotifyTrack("https://open.spotify.com/track/123"),
    ).resolves.toEqual({
      title: "Artist - Track",
      url: "https://youtube.com/watch?v=track",
    });
  });

  it("rejects Spotify playlists in this phase", async () => {
    const resolver = createPlayDlResolver({
      search: vi.fn(),
      spotify: vi.fn(async () => ({ type: "playlist", name: "Playlist" })),
    });

    await expect(
      resolver.resolveSpotifyTrack("https://open.spotify.com/playlist/123"),
    ).rejects.toThrow("Only Spotify track URLs are supported");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm -C /mnt/code/bete exec vitest run tests/media/playDlResolver.test.ts
```

Expected: FAIL because `src/media/playDlResolver.ts` does not exist.

- [ ] **Step 3: Implement play-dl wrapper**

Create `src/media/playDlResolver.ts`:

```ts
import play from "play-dl";

export interface PlayDlResult {
  title: string;
  url: string;
}

interface PlayDlSearchResult {
  title?: string;
  url?: string;
}

interface SpotifyTrackLike {
  type?: string;
  name?: string;
  artists?: Array<{ name?: string }>;
}

export interface PlayDlDependencies {
  search?: (query: string, options: { limit: number }) => Promise<PlayDlSearchResult[]>;
  spotify?: (url: string) => Promise<SpotifyTrackLike>;
}

export function createPlayDlResolver(dependencies: PlayDlDependencies = {}) {
  const search = dependencies.search ?? play.search;
  const spotify = dependencies.spotify ?? play.spotify;

  return {
    async searchYouTube(query: string): Promise<PlayDlResult> {
      const results = await search(query, { limit: 1 });
      const first = results[0];
      if (!first?.url) throw new Error(`No YouTube result found for ${query}`);
      return {
        title: first.title || query,
        url: first.url,
      };
    },

    async resolveSpotifyTrack(url: string): Promise<PlayDlResult> {
      const track = await spotify(url);
      if (track.type !== "track") {
        throw new Error("Only Spotify track URLs are supported");
      }
      const artists = (track.artists || [])
        .map((artist) => artist.name)
        .filter(Boolean)
        .join(" ");
      const query = `${artists} ${track.name || ""} audio`.trim();
      return this.searchYouTube(query);
    },
  };
}
```

- [ ] **Step 4: Run play-dl tests and typecheck**

```bash
pnpm -C /mnt/code/bete exec vitest run tests/media/playDlResolver.test.ts
pnpm -C /mnt/code/bete run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit task 3**

```bash
git -C /mnt/code/bete add src/media/playDlResolver.ts tests/media/playDlResolver.test.ts
git -C /mnt/code/bete commit -m "feat: add play-dl search resolver"
```

---

### Task 4: Compose Resolver for YouTube, Search, and Spotify Track

**Files:**
- Modify: `src/media/mediaResolver.ts`
- Test: `tests/media/mediaResolver.test.ts`

- [ ] **Step 1: Write failing composed resolver tests**

Append to `tests/media/mediaResolver.test.ts`:

```ts
import { createMediaResolver } from "../../src/media/mediaResolver";

// Add inside describe("resolveMediaSource", ...):
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
```

Also update imports at the top:

```ts
import { describe, expect, it, vi } from "vitest";
import { createMediaResolver, resolveMediaSource } from "../../src/media/mediaResolver";
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm -C /mnt/code/bete exec vitest run tests/media/mediaResolver.test.ts
```

Expected: FAIL because `createMediaResolver` does not exist.

- [ ] **Step 3: Implement composed resolver**

Modify `src/media/mediaResolver.ts` to export `createMediaResolver()` and keep `resolveMediaSource` as the default instance:

```ts
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { AppError } from "../errors";
import { createPlayDlResolver } from "./playDlResolver";
import type { ResolvedMediaSource } from "./mediaTypes";
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

  return async function resolve(input: string): Promise<ResolvedMediaSource> {
    const source = input.trim();
    if (!source) {
      throw new AppError("Media source is required", "MISSING_MEDIA_SOURCE", 400);
    }

    const url = parseUrl(source);
    if (url && isYouTubeUrl(url)) {
      const metadata = await ytdlp.getMetadata(source);
      const directUrl = await ytdlp.getDirectAudioUrl(source);
      return { source: directUrl, title: metadata.title, kind: "youtube" };
    }

    if (url && isSpotifyTrackUrl(url)) {
      const result = await playDlResolver.resolveSpotifyTrack(source);
      const directUrl = await ytdlp.getDirectAudioUrl(result.url);
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

    if (!url) {
      const result = await playDlResolver.searchYouTube(source);
      const directUrl = await ytdlp.getDirectAudioUrl(result.url);
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

function isYouTubeUrl(url: URL): boolean {
  return ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(
    url.hostname,
  );
}

function isSpotifyTrackUrl(url: URL): boolean {
  return url.hostname === "open.spotify.com" && url.pathname.startsWith("/track/");
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
```

- [ ] **Step 4: Run resolver tests and typecheck**

```bash
pnpm -C /mnt/code/bete exec vitest run tests/media/mediaResolver.test.ts
pnpm -C /mnt/code/bete run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit task 4**

```bash
git -C /mnt/code/bete add src/media/mediaResolver.ts tests/media/mediaResolver.test.ts
git -C /mnt/code/bete commit -m "feat: resolve youtube search and spotify media"
```

---

### Task 5: Dashboard Copy and Full Verification

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Update media input copy**

Change the media input label and placeholder in `public/index.html` from:

```html
<label for="mediaSourceInput">Music URL / file path</label>
<input id="mediaSourceInput" type="text" placeholder="https://example.com/song.mp3">
```

to:

```html
<label for="mediaSourceInput">Music URL, YouTube, Spotify track, search, or file path</label>
<input id="mediaSourceInput" type="text" placeholder="YouTube URL, Spotify track, or search terms">
```

- [ ] **Step 2: Run full verification**

```bash
pnpm -C /mnt/code/bete run test
pnpm -C /mnt/code/bete run typecheck
pnpm -C /mnt/code/bete run lint
```

Expected: PASS.

- [ ] **Step 3: Manual verification**

Run:

```bash
pnpm -C /mnt/code/bete run dev
```

Manual checks:

1. Queue a direct MP3 URL: still plays.
2. Queue a local file path: still plays.
3. Queue a YouTube URL: resolves title and plays audio.
4. Queue plain search terms: resolves first YouTube result and plays audio.
5. Queue a Spotify track URL: resolves Spotify metadata, searches YouTube, and plays audio.
6. Queue a Spotify playlist URL: returns a clear unsupported error.

- [ ] **Step 4: Commit task 5**

```bash
git -C /mnt/code/bete add public/index.html
git -C /mnt/code/bete commit -m "feat: update media input guidance"
```

---

## Self-Review

Spec coverage:

- YouTube URL support: Task 2 + Task 4.
- Search query support: Task 3 + Task 4.
- Spotify track URL to YouTube support: Task 3 + Task 4.
- No Spotify playlist/album support: Task 3 explicitly rejects non-track Spotify types, Task 5 manual check covers playlist error.
- Dashboard copy: Task 5.
- Existing direct URL/local file behavior protected: Task 1 + existing tests.

Placeholder scan: no placeholders, TODOs, or vague test instructions remain.

Type consistency: `MediaSourceKind` includes `youtube`, `spotify`, and `search`; resolver returns those exact values; tests assert those values.
