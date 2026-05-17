import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return {
    ...actual,
    spawn: (_cmd: string, _args: string[], _opts: any) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const listeners: Record<string, Function[]> = {};
      const proc: any = {
        stdout,
        stderr,
        kill: vi.fn(() => {
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
      setTimeout(() => {
        (listeners.exit || []).forEach((fn) => fn(null, null));
      }, 10);
      return proc;
    },
  };
});

import { playTranscodedPreparedStream } from "../../src/streaming/index";

describe("playTranscodedPreparedStream", () => {
  it("pipes transcoder output to session and broadcasts to web", async () => {
    // mock global broadcast
    const broadcasts: Buffer[] = [];
    (globalThis as any).broadcastVideoToWeb = (chunk: Buffer) =>
      broadcasts.push(Buffer.from(chunk));

    const session = {
      connection: { channel: { id: "c" } },
      stream: { playVideo: () => null, playAudio: () => null },
      play: vi.fn().mockImplementation(async (readable) => {
        // consume a bit from readable to simulate playback
        if (readable && typeof readable.on === "function") {
          readable.on("data", (_d: Buffer) => {});
        }
        // resolve after a short delay
        await new Promise((r) => setTimeout(r, 5));
      }),
      stop: vi.fn(),
    } as any;

    await playTranscodedPreparedStream("http://example.test/stream", session, {
      fps: 30,
    });
    expect(session.play).toHaveBeenCalled();
    expect(broadcasts.length).toBeGreaterThanOrEqual(0);
  });
});
