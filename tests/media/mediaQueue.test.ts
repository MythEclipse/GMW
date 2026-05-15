import { describe, expect, it } from "vitest";
import { MediaQueue } from "../../src/media/mediaQueue";
import type { ResolvedMediaSource } from "../../src/media/mediaTypes";

function source(overrides: Partial<ResolvedMediaSource> = {}): ResolvedMediaSource {
  return {
    source: "https://example.com/audio.ogg",
    title: "audio.ogg",
    kind: "url",
    ...overrides,
  };
}

describe("MediaQueue", () => {
  it("adds items with stable queue metadata", () => {
    const queue = new MediaQueue(() => "item-1", () => 1700000000000);

    const item = queue.add(source(), "tester");

    expect(item).toMatchObject({
      id: "item-1",
      mode: "music",
      source: "https://example.com/audio.ogg",
      title: "audio.ogg",
      kind: "url",
      requestedBy: "tester",
      addedAt: 1700000000000,
      status: "queued",
    });
    expect(queue.snapshot()).toEqual({ current: null, queue: [item] });
  });

  it("marks the next queued item as playing", () => {
    const queue = new MediaQueue(() => "item-1", () => 1700000000000);
    const item = queue.add(source(), "tester");

    expect(queue.startNext()).toEqual({ ...item, status: "playing" });
    expect(queue.snapshot()).toEqual({
      current: { ...item, status: "playing" },
      queue: [],
    });
  });

  it("removes current item and starts following item", () => {
    let id = 0;
    const queue = new MediaQueue(() => `item-${++id}`, () => 1700000000000);
    queue.add(source({ title: "first" }), "tester");
    queue.add(source({ title: "second" }), "tester");
    queue.startNext();

    queue.completeCurrent();
    const next = queue.startNext();

    expect(next?.title).toBe("second");
    expect(queue.snapshot().queue).toEqual([]);
  });

  it("returns the failed current item", () => {
    const queue = new MediaQueue(() => "item-1", () => 1700000000000);
    const item = queue.add(source(), "tester");
    queue.startNext();

    expect(queue.failCurrent()).toEqual({ ...item, status: "failed" });
    expect(queue.snapshot()).toEqual({ current: null, queue: [] });
  });

  it("clears current and queued items", () => {
    const queue = new MediaQueue(() => "item-1", () => 1700000000000);
    queue.add(source(), "tester");
    queue.startNext();

    queue.clear();

    expect(queue.snapshot()).toEqual({ current: null, queue: [] });
  });
});
