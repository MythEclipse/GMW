import { AppError } from "../errors";
import { discordPlayer } from "../player";
import { MediaQueue } from "./mediaQueue";
import { resolveMediaSource } from "./mediaResolver";
import type {
  MediaState,
  MusicPlayback,
  MusicPlayer,
  ResolvedMediaSource,
} from "./mediaTypes";
import { createMusicPlayer } from "./musicPlayer";

export interface MediaControllerDependencies {
  isVoiceConnected?: () => boolean;
  isBrowserStreaming?: () => boolean;
  resolveMediaSource?: (source: string) => Promise<ResolvedMediaSource>;
  musicPlayer?: MusicPlayer;
  onStateChange?: (state: MediaState) => void;
}

export class MediaController {
  private readonly queueStore = new MediaQueue();
  private readonly musicPlayer: MusicPlayer;
  private playback: MusicPlayback | null = null;
  private playbackToken = 0;
  private skipInProgress = false;

  constructor(private readonly dependencies: MediaControllerDependencies = {}) {
    this.musicPlayer = dependencies.musicPlayer ?? createMusicPlayer();
  }

  getState(): MediaState {
    const snapshot = this.queueStore.snapshot();
    return {
      playing: snapshot.current?.status === "playing",
      ...snapshot,
    };
  }

  async queue(source: string): Promise<MediaState> {
    this.assertCanStart();
    const resolved = await (
      this.dependencies.resolveMediaSource ?? resolveMediaSource
    )(source);
    this.queueStore.add(resolved);
    this.startNextIfIdle();
    return this.emitState();
  }

  async skip(): Promise<MediaState> {
    if (this.skipInProgress) {
      throw new AppError(
        "Skip already in progress",
        "MEDIA_SKIP_IN_PROGRESS",
        409,
      );
    }

    this.skipInProgress = true;
    try {
      this.playbackToken++;
      this.playback?.stop();
      this.playback = null;
      this.queueStore.completeCurrent();
      this.startNextIfIdle();
      return this.emitState();
    } finally {
      this.skipInProgress = false;
    }
  }

  async stop(): Promise<MediaState> {
    this.playbackToken++;
    this.playback?.stop();
    this.playback = null;
    this.queueStore.clear();
    return this.emitState();
  }

  private assertCanStart(): void {
    const isVoiceConnected =
      this.dependencies.isVoiceConnected ?? (() => discordPlayer.isConnected());
    if (!isVoiceConnected()) {
      throw new AppError(
        "Connect to a voice channel before playing media",
        "VOICE_NOT_CONNECTED",
        409,
      );
    }

    if (this.dependencies.isBrowserStreaming?.()) {
      throw new AppError(
        "Stop browser microphone streaming before playing media",
        "BROWSER_STREAM_ACTIVE",
        409,
      );
    }
  }

  private startNextIfIdle(): void {
    if (this.playback) return;
    const item = this.queueStore.startNext();
    if (!item) return;

    const token = ++this.playbackToken;
    try {
      this.playback = this.musicPlayer.play(item);
    } catch {
      this.queueStore.failCurrent();
      this.playback = null;
      this.startNextIfIdle();
      this.emitState();
      return;
    }

    this.playback.done.then(
      () => this.finishCurrent(token, false),
      () => this.finishCurrent(token, true),
    );
  }

  private finishCurrent(token: number, failed: boolean): void {
    if (token !== this.playbackToken) return;
    this.playback = null;
    if (failed) {
      this.queueStore.failCurrent();
    } else {
      this.queueStore.completeCurrent();
    }
    this.startNextIfIdle();
    this.emitState();
  }

  private emitState(): MediaState {
    const state = this.getState();
    this.dependencies.onStateChange?.(state);
    return state;
  }
}
