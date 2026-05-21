import { ChildProcess, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { PassThrough } from "node:stream";
import { createChildLogger } from "../logger.js";
import {
  transcoderRestartsCounter,
  transcoderRunningGauge,
} from "../metrics.js";
import { retryWithBackoff } from "../retry.js";

const logger = createChildLogger("transcoder");

export interface TranscoderOptions {
  fps?: number;
  bitrate?: string | number;
  preset?: string;
}

export class Transcoder {
  proc: ChildProcess | null = null;
  output: Readable | null = null;
  stopping = false;
  restartAttempts = 0;
  restartTimer: NodeJS.Timeout | null = null;
  maxRestarts = 6;

  constructor(
    private source: string,
    private opts: TranscoderOptions = {},
  ) {}

  start(): { command: ChildProcess; output: Readable } {
    const fps = this.opts.fps ?? 30;
    const bitrate = String(this.opts.bitrate ?? "2500k");
    const preset = this.opts.preset ?? "superfast";

    const args = ["-hide_banner", "-loglevel", "warning"];

    if (
      this.source.startsWith("http://") ||
      this.source.startsWith("https://")
    ) {
      args.push(
        "-user_agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36",
      );
    }

    args.push(
      "-i",
      this.source,
      "-c:v",
      "libx264",
      "-preset",
      preset,
      "-r",
      String(fps),
      "-s",
      "1280x720",
      "-b:v",
      String(bitrate),
      "-maxrate",
      "4000k",
      "-c:a",
      "libopus",
      "-f",
      "matroska",
      "-",
    );

    const cmd = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = cmd.stdout ?? new PassThrough();

    this.proc = cmd;
    this.output = out;

    cmd.on("error", (err) => {
      logger.error({ err }, "transcoder process error");
    });
    cmd.on("exit", (code, signal) => {
      logger.info({ code, signal }, "transcoder exited");
      transcoderRunningGauge.set(0);
      // If we didn't explicitly stop, attempt restart with backoff
      if (!this.stopping) {
        this.scheduleRestart();
      }
    });

    transcoderRunningGauge.set(1);

    return { command: cmd, output: out };
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    try {
      if (this.proc && !this.proc.killed) this.proc.kill("SIGTERM");
    } catch (e) {
      logger.warn({ e }, "failed to terminate transcoder gracefully");
      try {
        if (this.proc && !this.proc.killed) this.proc.kill("SIGKILL");
      } catch (e2) {
        logger.warn({ e2 }, "failed to kill transcoder forcefully");
      }
    }
    this.proc = null;
    this.output = null;
    transcoderRunningGauge.set(0);
  }

  scheduleRestart() {
    if (this.restartAttempts >= this.maxRestarts) {
      logger.error(
        { attempts: this.restartAttempts },
        "transcoder reached max restart attempts",
      );
      return;
    }
    const delay = Math.min(30000, 1000 * Math.pow(2, this.restartAttempts));
    this.restartAttempts += 1;
    transcoderRestartsCounter.inc();
    logger.info(
      { delay, attempt: this.restartAttempts },
      "scheduling transcoder restart",
    );
    this.restartTimer = setTimeout(() => {
      try {
        this.start();
      } catch (err) {
        logger.error({ err }, "transcoder restart failed");
        this.scheduleRestart();
      }
    }, delay) as unknown as NodeJS.Timeout;
  }

  async startWithRetry(retries = 2) {
    return retryWithBackoff(() => Promise.resolve(this.start()), {
      retries,
      logger,
    });
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.proc && !this.proc.killed) {
      return new Promise<void>((resolve) => {
        this.proc?.once("exit", () => resolve());
        try {
          this.proc?.kill("SIGTERM");
        } catch {
          try {
            this.proc?.kill("SIGKILL");
          } catch {
            resolve();
          }
        }
        setTimeout(() => resolve(), 5000);
      }).then(() => {
        this.proc = null;
        this.output = null;
        transcoderRunningGauge.set(0);
      });
    }
  }
}

export function prepareTranscoder(
  source: string,
  options: TranscoderOptions = {},
) {
  const t = new Transcoder(source, options);
  const { command, output } = t.start();
  return { transcoder: t, command, output };
}
