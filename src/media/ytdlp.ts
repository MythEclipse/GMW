import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";

export interface YtDlpMetadata {
  title: string;
  webpageUrl: string;
}

export interface YtDlpClient {
  getMetadata(url: string): Promise<YtDlpMetadata>;
  getDirectAudioUrl(url: string): Promise<string>;
  getDirectVideoUrl(url: string): Promise<string>;
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
      const parsed = JSON.parse(data) as {
        title?: string;
        webpage_url?: string;
      };
      return {
        title: parsed.title || url,
        webpageUrl: parsed.webpage_url || url,
      };
    },

    async getDirectAudioUrl(url: string): Promise<string> {
      const value = await runYtDlp(spawn, [
        url,
        "--get-url",
        "--format",
        "bestaudio[protocol^=http]/bestaudio/best",
        "--no-playlist",
        "--no-warnings",
        "--quiet",
      ]);
      return value.trim().split("\n")[0] || url;
    },

    async getDirectVideoUrl(url: string): Promise<string> {
      const value = await runYtDlp(spawn, [
        url,
        "--get-url",
        "--format",
        "best[protocol^=http]/best",
        "--no-playlist",
        "--no-warnings",
        "--quiet",
      ]);
      return value.trim();
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
