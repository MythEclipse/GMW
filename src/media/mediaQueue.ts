import type {
  MediaQueueItem,
  MediaState,
  ResolvedMediaSource,
} from "./mediaTypes";

export class MediaQueue {
  private current: MediaQueueItem | null = null;
  private readonly items: MediaQueueItem[] = [];

  constructor(
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly now = () => Date.now(),
  ) {}

  add(source: ResolvedMediaSource, requestedBy = "dashboard"): MediaQueueItem {
    const item: MediaQueueItem = {
      id: this.createId(),
      mode: "music",
      requestedBy,
      addedAt: this.now(),
      status: "queued",
      ...source,
    };
    this.items.push(item);
    return { ...item };
  }

  startNext(): MediaQueueItem | null {
    if (this.current) return { ...this.current };
    const next = this.items.shift();
    if (!next) return null;
    this.current = { ...next, status: "playing" };
    return { ...this.current };
  }

  completeCurrent(): void {
    this.current = null;
  }

  failCurrent(): MediaQueueItem | null {
    if (!this.current) return null;
    const failed = { ...this.current, status: "failed" as const };
    this.current = null;
    return failed;
  }

  clear(): void {
    this.current = null;
    this.items.length = 0;
  }

  snapshot(): Pick<MediaState, "current" | "queue"> {
    return {
      current: this.current ? { ...this.current } : null,
      queue: this.items.map((item) => ({ ...item })),
    };
  }
}
