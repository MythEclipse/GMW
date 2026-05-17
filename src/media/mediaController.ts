import { createChildLogger } from "../logger";
import { AppError } from "../errors";
import { discordPlayer } from "../player";
import { MediaQueue } from "./mediaQueue";
import { resolveMediaSource } from "./mediaResolver";
import type {
  MediaMode,
  MediaState,
  MusicPlayback,
  MusicPlayer,
  QueueMediaOptions,
  ResolvedMediaSource,
  ScreenShareController,
  ScreenSharePlayback,
} from "./mediaTypes";
import { createMusicPlayer } from "./musicPlayer";

const logger = createChildLogger("mediaController");

export interface MediaControllerDependencies {
  isVoiceConnected?: () => boolean;
  isBrowserStreaming?: () => boolean;
  resolveMediaSource?: (
    source: string,
    mode?: MediaMode,
  ) => Promise<ResolvedMediaSource>;
  musicPlayer?: MusicPlayer;
  screenController?: ScreenShareController;
  onStateChange?: (state: MediaState) => void;
  initialMusicVolume?: number;
  onMusicVolumeChange?: (volume: number) => void | Promise<void>;
  setMusicVolume?: (volume: number) => void;
}

export class MediaController {
  private readonly queueStore = new MediaQueue();
  private readonly musicPlayer: MusicPlayer;
  private playback: MusicPlayback | null = null;
  private playbackToken = 0;
  private skipInProgress = false;
  private screenPlayback: ScreenSharePlayback | null = null;
  private activeMode: MediaMode | null = null;
  private musicVolume: number;
  private readonly setPlayerMusicVolume: (volume: number) => void;

  constructor(private readonly dependencies: MediaControllerDependencies = {}) {
    this.musicPlayer = dependencies.musicPlayer ?? createMusicPlayer();
    this.setPlayerMusicVolume =
      dependencies.setMusicVolume ??
      ((volume) => {
        discordPlayer.setMusicVolume(volume);
      });
    this.musicVolume = normalizeVolume(dependencies.initialMusicVolume, 1);
    this.setPlayerMusicVolume(this.musicVolume);
  }

  getState(): MediaState {
    const snapshot = this.queueStore.snapshot();
    return {
      playing:
        this.activeMode === "screen" || snapshot.current?.status === "playing",
      activeMode: this.activeMode ?? snapshot.current?.mode ?? null,
      musicVolume: this.musicVolume,
      ...snapshot,
    };
  }

  async setMusicVolume(volume: number): Promise<MediaState> {
    const nextVolume = normalizeVolume(volume, this.musicVolume);
    if (this.musicVolume === nextVolume) return this.emitState();
    this.musicVolume = nextVolume;
    this.setPlayerMusicVolume(nextVolume);
    await this.dependencies.onMusicVolumeChange?.(nextVolume);
    return this.emitState();
  }

  async queue(
    source: string,
    options: QueueMediaOptions = {},
  ): Promise<MediaState> {
    const mode = options.mode ?? "music";

    logger.info({ source: source.slice(0, 100), mode }, "Queuing media");
    const resolved = await (
      this.dependencies.resolveMediaSource ?? resolveMediaSource
    )(source, mode);
    logger.info(
      { title: resolved.title, kind: resolved.kind },
      "Media resolved",
    );

    if (mode === "screen") {
      // Stop current music if any
      this.playbackToken++;
      this.playback?.stop();
      this.playback = null;
      this.assertCanStartMusic();
      this.queueStore.clear();
      this.queueStore.add(resolved, mode, options.requestedBy);
      this.queueStore.startNext();
      logger.info({ title: resolved.title }, "Starting screen share");
      return this.startScreen(resolved.source);
    }

    // mode === "music"
    // If a screen share is active outside of this controller (browser-owned),
    // reject to avoid stealing the shared player. If this controller started
    // the screenPlayback, stop it and proceed.
    if (this.screenPlayback || this.dependencies.screenController?.isActive()) {
      if (
        this.dependencies.screenController?.isActive() &&
        !this.screenPlayback
      ) {
        throw new AppError("Another media mode is active", "MEDIA_BUSY", 409);
      }
      this.screenPlayback?.stop();
      this.screenPlayback = null;
      this.activeMode = null;
    }

    this.assertCanStartMusic();
    this.queueStore.add(resolved, mode, options.requestedBy);
    logger.info(
      { title: resolved.title, queueSize: this.queueStore.snapshot().queue.length },
      "Added to queue",
    );
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
    this.screenPlayback?.stop();
    this.screenPlayback = null;
    this.activeMode = null;
    this.queueStore.clear();
    return this.emitState();
  }

  private assertCanStartMusic(): void {
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

  private async startScreen(source: string): Promise<MediaState> {
    const screenController = this.dependencies.screenController;
    if (!screenController) {
      throw new AppError(
        "Screen sharing is unavailable",
        "SCREEN_UNAVAILABLE",
        500,
      );
    }

    this.activeMode = "screen";
    try {
      this.screenPlayback = await screenController.start(source);
    } catch (error) {
      this.activeMode = null;
      this.queueStore.failCurrent();
      throw error;
    }

    this.screenPlayback.done.then(
      () => this.finishScreen(),
      () => this.finishScreen(),
    );
    return this.emitState();
  }

  private finishScreen(): void {
    if (!this.screenPlayback || this.activeMode !== "screen") return;
    this.screenPlayback = null;
    this.activeMode = null;
    this.queueStore.completeCurrent();
    this.emitState();
  }

  private startNextIfIdle(): void {
    if (this.playback) return;
    const item = this.queueStore.startNext();
    if (!item) {
      logger.debug("Queue empty, no playback started");
      return;
    }

    const token = ++this.playbackToken;
    logger.info(
      { title: item.title, token, queueSize: this.queueStore.snapshot().queue.length },
      "Starting playback",
    );
    try {
      this.playback = this.musicPlayer.play(item);
    } catch (err) {
      logger.error({ err }, "Failed to start playback");
      this.queueStore.failCurrent();
      this.playback = null;
      this.startNextIfIdle();
      this.emitState();
      return;
    }

    this.playback.done.then(
      () => this.finishCurrent(token, false),
      (err) => {
        logger.error({ err, token }, "Playback failed");
        this.finishCurrent(token, true);
      },
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

function normalizeVolume(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value as number));
}
