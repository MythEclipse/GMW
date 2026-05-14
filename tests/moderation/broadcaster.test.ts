import { describe, expect, it, vi } from "vitest";
import { createBroadcaster } from "../../src/moderation/broadcaster";

function client() {
  return { readyState: 1, send: vi.fn() };
}

describe("createBroadcaster", () => {
  it("sends JSON events to open clients", () => {
    const ws = client();
    const broadcaster = createBroadcaster();

    broadcaster.addClient(ws as any);
    broadcaster.messageAnalyzed({ id: "m1", ai_status: "clean" } as any);

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({
      type: "message_analyzed",
      data: { id: "m1", ai_status: "clean" },
    });
  });

  it("skips closed clients", () => {
    const ws = { readyState: 3, send: vi.fn() };
    const broadcaster = createBroadcaster();

    broadcaster.addClient(ws as any);
    broadcaster.messageDeleted({ id: "m1", deleted_at: 123 });

    expect(ws.send).not.toHaveBeenCalled();
  });
});
