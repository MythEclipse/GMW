import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

// Mock spawn to avoid calling real ffmpeg
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: any) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const listeners: Record<string, Function[]> = {};
      const proc: any = {
        stdout,
        stderr,
        kill: vi.fn(() => {
          // emit exit when killed
          (listeners.exit || []).forEach((fn) => fn(0, "SIGKILL"));
        }),
        on: (ev: string, fn: Function) => {
          listeners[ev] = listeners[ev] || [];
          listeners[ev].push(fn);
        },
        off: (ev: string, fn: Function) => {
          listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn);
        },
        stdoutWrite: (d: Buffer | string) => stdout.write(d),
      };
      // simulate async start
      setTimeout(() => {
        (listeners.exit || []).forEach((fn) => fn(null, null));
      }, 10);
      return proc;
    },
  };
});

import { prepareTranscoder } from "../../src/streaming/transcoder";

describe("Transcoder", () => {
  it("starts ffmpeg and returns output stream and command", () => {
    const { transcoder, command, output } = prepareTranscoder(
      "http://example.test/video",
      { fps: 24 },
    );
    expect(transcoder).toBeTruthy();
    expect(command).toBeTruthy();
    expect(output).toBeTruthy();
    expect(typeof command.kill).toBe("function");
    // write some data and ensure output is readable
    const wrote = command.stdoutWrite?.("hello");
    expect(output.readable).toBe(true);
    transcoder.stop();
  });
});
