import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import type { Readable } from "node:stream";
import type { Client } from "discord.js-selfbot-v13";

export const Encoders = {
  software: (opts: any) => opts,
};

export const Utils = {
  normalizeVideoCodec: (c: string) => c.toUpperCase?.() ?? c,
};

export class Streamer {
  client: Client;
  constructor(client: Client) {
    this.client = client;
  }

  // Lightweight joinVoice placeholder. Real implementation may create a
  // WebRTC connection using private discord.js-selfbot-v13 internals.
  async joinVoice(_guildId: string, _channelId: string): Promise<unknown> {
    // No-op for now; consumers may override with a richer implementation.
    return Promise.resolve({});
  }
}

export function prepareStream(source: string, _options: any): {
  command: ReturnType<typeof spawn> | { kill?: (signal: NodeJS.Signals) => unknown };
  output: Readable;
} {
  // Spawn ffmpeg to transcode the source into a simple container with
  // H264 video + Opus audio and pipe to stdout. Options are simplified and
  // intentionally conservative to keep parity with prior behavior.
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-i",
    source,
    "-c:v",
    "libx264",
    "-preset",
    "superfast",
    "-r",
    "30",
    "-s",
    "1280x720",
    "-b:v",
    "2500k",
    "-maxrate",
    "4000k",
    "-c:a",
    "libopus",
    "-f",
    "matroska",
    "-",
  ];

  const command = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  const output = command.stdout ?? new PassThrough();

  return { command, output };
}

export async function playStream(
  output: Readable,
  _streamer: Streamer,
  _options?: object,
): Promise<void> {
  // Simple implementation: consume the stream until end. In production
  // this should attach the stream to a WebRTC connection for Discord.
  return new Promise<void>((resolve, reject) => {
    output.on("end", resolve);
    output.on("close", resolve);
    output.on("error", (err) => reject(err));
    // Ensure data flows
    if (output.readable) output.resume();
  });
}
