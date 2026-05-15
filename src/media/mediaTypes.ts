import type { Readable } from "node:stream";

export type MediaMode = "music" | "screen";
export type MediaSourceKind = "url" | "local";
export type MediaQueueItemStatus = "queued" | "playing" | "failed";

export interface ResolvedMediaSource {
  source: string;
  title: string;
  kind: MediaSourceKind;
}

export interface MediaQueueItem extends ResolvedMediaSource {
  id: string;
  mode: MediaMode;
  requestedBy: string;
  addedAt: number;
  status: MediaQueueItemStatus;
}

export interface MediaState {
  playing: boolean;
  current: MediaQueueItem | null;
  queue: MediaQueueItem[];
}

export interface MusicPlayback {
  done: Promise<void>;
  stop(): void;
}

export interface MusicPlayer {
  play(source: ResolvedMediaSource): MusicPlayback;
}

export interface DiscordAudioPlayer {
  isConnected(): boolean;
  playStream(stream: Readable): void;
  stop(): void;
}
