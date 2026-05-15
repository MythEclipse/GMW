import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { createMediaRoutes } from "../../src/routes/mediaRoutes";

function getHandler(
  router: ReturnType<typeof createMediaRoutes>,
  path: string,
  method: string,
) {
  const layer = router.stack.find((item) => item.route?.path === path);
  return layer?.route?.stack.find((item) => item.method === method)?.handle;
}

describe("createMediaRoutes", () => {
  it("returns media status", async () => {
    const controller = {
      getState: vi.fn(() => ({ playing: false, current: null, queue: [] })),
      queue: vi.fn(),
      skip: vi.fn(),
      stop: vi.fn(),
    };
    const handler = getHandler(
      createMediaRoutes(controller),
      "/media/status",
      "get",
    );
    const json = vi.fn();

    await handler?.({} as Request, { json } as unknown as Response, vi.fn());

    expect(json).toHaveBeenCalledWith({
      playing: false,
      current: null,
      queue: [],
    });
  });

  it("queues a source", async () => {
    const state = { playing: true, current: null, queue: [] };
    const controller = {
      getState: vi.fn(),
      queue: vi.fn(async () => state),
      skip: vi.fn(),
      stop: vi.fn(),
    };
    const handler = getHandler(
      createMediaRoutes(controller),
      "/media/queue",
      "post",
    );
    const json = vi.fn();

    await handler?.(
      { body: { source: "https://example.com/song.mp3" } } as Request,
      { json } as unknown as Response,
      vi.fn(),
    );

    expect(controller.queue).toHaveBeenCalledWith(
      "https://example.com/song.mp3",
    );
    expect(json).toHaveBeenCalledWith(state);
  });

  it("passes missing source errors to Express", async () => {
    const controller = {
      getState: vi.fn(),
      queue: vi.fn(),
      skip: vi.fn(),
      stop: vi.fn(),
    };
    const handler = getHandler(
      createMediaRoutes(controller),
      "/media/queue",
      "post",
    );
    const next = vi.fn();

    await handler?.(
      { body: {} } as Request,
      { json: vi.fn() } as unknown as Response,
      next,
    );

    expect(next.mock.calls[0][0]).toMatchObject({
      code: "MISSING_MEDIA_SOURCE",
      statusCode: 400,
    });
  });
});
